// Settings (spec §3, §4, §6): store settings live in the tracker's
// `settings.yml`, each key with its value and who set it when, folding per key
// with the later change winning; machine settings live in the machine-local
// store and apply to this clone on this machine only. `settings_get` reads
// both; `settings_set` is human-only.
import { invalid } from '../errors';
import { defaultDashboardPort, MachineLocalStore } from '../machine-local';
import { define, oneLine, writer } from './op';
import { s } from './schema';
import { parseDuration } from './stale';

export type SettingScope = 'store' | 'machine';

interface SettingSpec {
  readonly scope: SettingScope;
  readonly description: string;
  /** The value when the setting was never set. */
  readonly fallback: (commonDir: string) => unknown | Promise<unknown>;
  /** The value a `settings_set` input stands for, or undefined when it isn't valid (with `why`). */
  readonly parse: (value: unknown) => unknown;
  readonly why: string;
}

const MACHINE_SETTINGS = 'machine-settings';

function oneOf(values: readonly string[]): Pick<SettingSpec, 'parse' | 'why'> {
  return {
    parse: (value) => (typeof value === 'string' && values.includes(value.trim()) ? value.trim() : undefined),
    why: `must be one of ${values.map((v) => JSON.stringify(v)).join(', ')}`,
  };
}

function wholeNumber(min: number, max: number): Pick<SettingSpec, 'parse' | 'why'> {
  return {
    parse: (value) => {
      const n = typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : value;
      return typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max ? n : undefined;
    },
    why: `must be a whole number from ${min} to ${max}`,
  };
}

const flag: Pick<SettingSpec, 'parse' | 'why'> = {
  parse: (value) => (value === true || value === 'true' ? true : value === false || value === 'false' ? false : undefined),
  why: 'must be true or false',
};

/** A forge URL that `link` appends record paths to; never one that carries credentials. */
const linkBase: Pick<SettingSpec, 'parse' | 'why'> = {
  parse: (value) => {
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    if (text === '') return '';
    try {
      const url = new URL(text);
      return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === '' ? text : undefined;
    } catch {
      return undefined;
    }
  },
  why: 'must be an http(s) URL without credentials, or empty for none',
};

/**
 * Every setting this release knows, by key. Tickets that add a setting add it
 * here; a tracker's keys this release doesn't know are still shown and kept.
 */
const SETTINGS: Readonly<Record<string, SettingSpec>> = {
  excerpts: {
    scope: 'store',
    description: 'what traces commit: excerpts, facts (no excerpt text) or none (no transcript is opened)',
    fallback: () => 'facts',
    ...oneOf(['excerpts', 'facts', 'none']),
  },
  'auto-sync': {
    scope: 'store',
    description: 'whether grimoire syncs the tracker on its own; `grimoire sync` always works',
    fallback: () => true,
    ...flag,
  },
  link_base: {
    scope: 'store',
    description: 'the URL `link` puts before a record’s path (empty: `link` is the bare id)',
    fallback: () => '',
    ...linkBase,
  },
  delivery: {
    scope: 'store',
    description: 'whether evolved skills reach working agents',
    fallback: () => 'on',
    ...oneOf(['on', 'off']),
  },
  'knowledge.loop': {
    scope: 'store',
    description: 'whether new knowledge chores become due',
    fallback: () => 'on',
    ...oneOf(['on', 'paused']),
  },
  'skills.max_active': {
    scope: 'store',
    description: 'the most evolved skills active at once',
    fallback: () => 8,
    ...wholeNumber(1, 100),
  },
  'skills.description_max': {
    scope: 'store',
    description: 'the longest evolved skill description, in characters',
    fallback: () => 300,
    ...wholeNumber(1, 1024),
  },
  'knowledge.pickup': {
    scope: 'machine',
    description: 'how sessions on this machine pick up a due chore: ask, auto or manual',
    fallback: () => 'ask',
    ...oneOf(['ask', 'auto', 'manual']),
  },
  'dashboard.port': {
    scope: 'machine',
    description: 'the port `start` serves the dashboard on (default: one derived from this clone)',
    fallback: (commonDir) => defaultDashboardPort(commonDir),
    ...wholeNumber(1, 65_535),
  },
  'dashboard.stale_after': {
    scope: 'machine',
    description: 'how long without activity makes a claim stale on this machine (display only)',
    fallback: () => '24h',
    parse: (value) => (typeof value === 'string' && parseDuration(value) !== null ? value.trim() : undefined),
    why: 'must be a duration like 24h, 90m or 2d',
  },
  'capture.excerpts_max': {
    scope: 'machine',
    description: 'the most this machine’s sessions capture; it can only lower the store’s excerpts mode',
    fallback: () => 'excerpts',
    ...oneOf(['excerpts', 'facts', 'none']),
  },
};

/** One setting as `settings_get` shows it. */
export interface ShownSetting {
  value: unknown;
  /** True when it was never set, so `value` is the default. */
  default: boolean;
  /** Store settings that were set: when and by whom. */
  at?: string;
  by?: string;
  /** What it does; absent for a key this release doesn't know. */
  description?: string;
}

export interface SettingsResult {
  /** Committed on the tracker: every worktree now, every clone after sync. */
  store: Record<string, ShownSetting>;
  /** This clone on this machine only. */
  machine: Record<string, ShownSetting>;
}

function unknownKey(key: string): never {
  throw invalid({ key: `"${key}" is not a setting; settings are ${Object.keys(SETTINGS).join(', ')}` });
}

export const settingsGet = define({
  name: 'settings_get',
  description: 'Show the settings: store settings (on the tracker, who set each when) and this machine’s settings, defaults included.',
  kind: 'read',
  policy: 'agent',
  mcp: false,
  replay: 'none',
  input: s.object({ key: s.optional(s.string({ ...oneLine, description: 'show only this setting' })) }),
  async run(input, { tracker }): Promise<SettingsResult> {
    const view = await tracker.read();
    const commonDir = tracker.location.commonDir;
    const machine = new MachineLocalStore(commonDir);
    const result: SettingsResult = { store: {}, machine: {} };
    const stored = view.settings();
    const wanted = (key: string) => input.key === undefined || input.key === key;
    if (input.key !== undefined && !(input.key in SETTINGS) && !stored.has(input.key)) unknownKey(input.key);
    for (const [key, spec] of Object.entries(SETTINGS)) {
      if (!wanted(key)) continue;
      if (spec.scope === 'store') {
        const setting = stored.get(key);
        result.store[key] = setting
          ? { value: setting.value, default: false, at: setting.at, by: setting.by, description: spec.description }
          : { value: await spec.fallback(commonDir), default: true, description: spec.description };
      } else {
        const value = await machine.records.read(MACHINE_SETTINGS, key);
        result.machine[key] =
          value === undefined
            ? { value: await spec.fallback(commonDir), default: true, description: spec.description }
            : { value, default: false, description: spec.description };
      }
    }
    // Keys a newer release set are shown as they are.
    for (const [key, setting] of stored) {
      if (!(key in SETTINGS) && wanted(key)) result.store[key] = { value: setting.value, default: false, at: setting.at, by: setting.by };
    }
    return result;
  },
});

export interface SettingsSetResult {
  key: string;
  scope: SettingScope;
  value: unknown;
  /** False when the setting already had this value: nothing was written. */
  changed: boolean;
  /** Store settings: when and by whom the value was set. */
  at?: string;
  by?: string;
}

const scalar = s.either(
  s.string({ singleLine: true }),
  s.either(s.boolean(), s.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER })),
  'the new value (text, a number, or true/false)',
);

export const settingsSet = define({
  name: 'settings_set',
  description:
    'Change a setting. A store setting is committed on the tracker (every worktree now, every clone after sync; the later change wins per key); a machine setting applies to this clone on this machine only. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({ key: s.string(oneLine), value: scalar }),
  async run(input, { ctx, tracker, actor }): Promise<SettingsSetResult> {
    const spec = SETTINGS[input.key] ?? unknownKey(input.key);
    const value = spec.parse(input.value);
    if (value === undefined) throw invalid({ value: `${input.key} ${spec.why}` });
    if (spec.scope === 'machine') {
      const records = new MachineLocalStore(tracker.location.commonDir).records;
      const current = await records.read(MACHINE_SETTINGS, input.key);
      const changed = current === undefined || JSON.stringify(current) !== JSON.stringify(value);
      if (changed) await records.write(MACHINE_SETTINGS, input.key, value as never);
      return { key: input.key, scope: 'machine', value, changed };
    }
    const author = writer(ctx);
    const write = await tracker.transact({ op: 'settings_set', author, actor }, (draft) => {
      const current = draft.settings().get(input.key);
      if (current && JSON.stringify(current.value) === JSON.stringify(value)) {
        return { result: { key: input.key, scope: 'store' as const, value, changed: false, at: current.at, by: current.by } };
      }
      draft.putSetting(input.key, value, author.email);
      const at = draft.now.toISOString();
      return { result: { key: input.key, scope: 'store' as const, value, changed: true, at, by: author.email } };
    });
    return write.result;
  },
});
