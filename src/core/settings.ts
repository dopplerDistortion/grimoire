// Settings (spec §3, §4, §6): store settings live in the tracker's
// `settings.yml`, each key with its value and who set it when, folding per key
// with the later change winning; machine settings live in the machine-local
// store and apply to this clone on this machine only. `settings_get` reads
// both; `settings_set` is human-only.
import { stripExcerptText } from '../capture/session-record';
import { invalid } from '../errors';
import { defaultDashboardPort, MachineLocalStore } from '../machine-local';
import { define, oneLine, writer } from './op';
import { s } from './schema';
import { parseDuration } from './stale';
import type { TrackerDraft, TrackerView } from '../tracker';

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

/** The store's evolved-skill delivery switch (spec §15, Delete and delivery off). */
export const DELIVERY_SETTING = 'skills.delivery';

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
 * Every setting this release knows, by key. The part of grimoire a setting
 * governs adds it here, with whatever a change must do in the same commit
 * (the excerpt mode, the loop pause and the chore and proposal thresholds come
 * with the parts that use them). Turning `skills.delivery` off removes every
 * copy and stub: the refresh after the write reconciles this pin's worktrees
 * with nothing served. A tracker's keys this release doesn't know are still
 * shown and kept.
 */
const SETTINGS: ReadonlyMap<string, SettingSpec> = new Map<string, SettingSpec>(Object.entries({
  excerpts: {
    scope: 'store',
    description:
      'what capture commits: excerpts (redacted excerpt text plus facts), facts (never excerpt text) or none (never opens a transcript); tightening strips the text from open attempts',
    fallback: () => EXCERPTS_UNSET,
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
  'skills.delivery': {
    scope: 'store',
    description: 'whether evolved skills reach working agents; off empties skill_list and removes every copy and stub',
    fallback: () => true,
    ...flag,
  },
  'skills.max_active': {
    scope: 'store',
    description: 'the most evolved skills that may be active at once',
    fallback: () => 8,
    ...wholeNumber(1, 64),
  },
  'skills.description_max': {
    scope: 'store',
    description: 'the longest an evolved skill’s description may be, in characters',
    fallback: () => 300,
    ...wholeNumber(1, 1024),
  },
  'knowledge.loop': {
    scope: 'store',
    description: 'the knowledge loop: on, or paused (no chore becomes due; runs in flight may still submit; decisions and restores keep working)',
    fallback: () => 'on',
    ...oneOf(['on', 'paused']),
  },
  'chores.settle_hours': {
    scope: 'store',
    description: 'how long after its attempt ended a pass or fail is settled enough to compile (a human-set outcome is settled at once)',
    fallback: () => 24,
    ...wholeNumber(0, 8_760),
  },
  'chores.compile_pairs': {
    scope: 'store',
    description: 'how many uncompiled settled traces make the Wiki Maintainer due (with chores.compile_fails of them failing)',
    fallback: () => 5,
    ...wholeNumber(1, 1_000),
  },
  'chores.compile_fails': {
    scope: 'store',
    description: 'how many of those traces must be fails',
    fallback: () => 1,
    ...wholeNumber(0, 1_000),
  },
  'chores.compile_wait_days': {
    scope: 'store',
    description: 'how many days after the last compile a single uncompiled fail makes the Wiki Maintainer due',
    fallback: () => 7,
    ...wholeNumber(1, 3_650),
  },
  'chores.batch_pairs': {
    scope: 'store',
    description: 'the most traces one compile takes, newest first',
    fallback: () => 8,
    ...wholeNumber(1, 64),
  },
  'chores.batch_fails': {
    scope: 'store',
    description: 'the most fails one compile takes',
    fallback: () => 5,
    ...wholeNumber(0, 64),
  },
  'chores.batch_passes': {
    scope: 'store',
    description: 'the most passes one compile takes',
    fallback: () => 3,
    ...wholeNumber(0, 64),
  },
  'chores.strikes': {
    scope: 'store',
    description: 'how many failed compile runs set a trace aside (shown, no longer offered)',
    fallback: () => 2,
    ...wholeNumber(1, 100),
  },
  'chores.propose_fails': {
    scope: 'store',
    description: 'how many fails among the compiles no Skill Proposer run consumed yet make the Skill Proposer due',
    fallback: () => 2,
    ...wholeNumber(1, 1_000),
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
} satisfies Record<string, SettingSpec>));

/** The store setting that holds the excerpt mode (spec §14, The setting). */
export const EXCERPTS_SETTING = 'excerpts';
export const EXCERPT_MODES = ['excerpts', 'facts', 'none'] as const;
export type ExcerptMode = (typeof EXCERPT_MODES)[number];
/**
 * What a tracker without the setting is treated as: `init` seeds it on every
 * mint, so only a tracker made some other way lacks it, and it gets the mode
 * that commits no transcript text.
 */
export const EXCERPTS_UNSET: ExcerptMode = 'facts';

export function isExcerptMode(value: unknown): value is ExcerptMode {
  return typeof value === 'string' && (EXCERPT_MODES as readonly string[]).includes(value);
}

/** The store's excerpt mode in `view`. */
export function storeExcerptMode(view: Pick<TrackerView, 'settings'>): ExcerptMode {
  const value = view.settings().get(EXCERPTS_SETTING)?.value;
  return isExcerptMode(value) ? value : EXCERPTS_UNSET;
}

/**
 * The full settings a new tracker is seeded with (spec §12, init step 4): the
 * excerpt mode chosen at the mint, and every store setting this release knows
 * at its default.
 */
export function seedStoreSettings(mode: ExcerptMode): Map<string, unknown> {
  const seed = new Map<string, unknown>([[EXCERPTS_SETTING, mode]]);
  for (const [key, spec] of SETTINGS) if (spec.scope === 'store' && !seed.has(key)) seed.set(key, spec.fallback(''));
  return seed;
}

const MODE_RANK: Readonly<Record<ExcerptMode, number>> = { none: 0, facts: 1, excerpts: 2 };

/** The lower of two excerpt modes: the one that commits less. */
export function lowerMode(x: ExcerptMode, y: ExcerptMode): ExcerptMode {
  return MODE_RANK[x] <= MODE_RANK[y] ? x : y;
}

/** The excerpt disclosure (spec §12 step 3): shown on every init, and again by every change of the mode (§14). */
export function disclosureLines(mode: ExcerptMode | null): string[] {
  return [
    mode === null ? 'Excerpt mode: not known until this clone has the tracker.' : `Excerpt mode: ${mode}.`,
    'In `excerpts` mode, redacted excerpts of agent transcripts are committed to grimoire/tracker and pushed while the attempt is still open.',
    'Redaction is best-effort: a secret can slip through.',
    'Pushed history can’t be purged.',
    'The modes: `excerpts` (redacted excerpt text plus facts), `facts` (names, versions, hashes, times and statuses, never excerpt text) and `none` (never opens a transcript). A person changes it with `grimoire settings set excerpts <mode>` or in the dashboard.',
  ];
}

/** What loosening the mode says (spec §14 The setting). */
export const LOOSENING_WARNING =
  'Loosening the excerpt mode: every clone applies it at its next cut, and teammates aren’t asked.';

/**
 * Strips the excerpt text from every open attempt's session records in
 * `draft` (spec §14: switching to `facts` or `none` does so in the same
 * commit). Sealed traces keep theirs. Returns how many records it rewrote.
 */
export async function stripOpenAttempts(draft: TrackerDraft): Promise<number> {
  let stripped = 0;
  for (const issue of draft.issues()) {
    for (const attempt of draft.attempts(issue.id)) {
      if (attempt.end !== null) continue;
      for (const key of attempt.sessions.keys()) {
        const bytes = await draft.sessionRecord(attempt.id, key);
        const without = bytes === null ? null : stripExcerptText(bytes);
        if (without === null) continue;
        draft.putSessionRecord(attempt.id, key, without);
        stripped++;
      }
    }
  }
  return stripped;
}

/** Sets a machine setting for this clone (`settings_set`'s machine half, for init's join). */
export async function putMachineSetting(commonDir: string, key: string, value: unknown): Promise<void> {
  const spec = SETTINGS.get(key);
  if (!spec || spec.scope !== 'machine' || spec.parse(value) === undefined) throw new Error(`${key} can't be set to ${JSON.stringify(value)}`);
  await new MachineLocalStore(commonDir).records.write(MACHINE_SETTINGS, key, spec.parse(value) as never);
}

/** A machine setting as this clone has it, or undefined when never set. */
export function readMachineSetting(commonDir: string, key: string): Promise<unknown> {
  return new MachineLocalStore(commonDir).records.read(MACHINE_SETTINGS, key);
}

/**
 * A store setting's value in `view`: the one set when it is valid for this
 * release, else its default.
 */
export function storeSetting(view: Pick<TrackerView, 'settings'>, key: string): unknown {
  const spec = SETTINGS.get(key);
  if (!spec || spec.scope !== 'store') throw new Error(`${key} is not a store setting`);
  const set = view.settings().get(key);
  const value = set === undefined ? undefined : spec.parse(set.value);
  return value === undefined ? spec.fallback('') : value;
}

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
  throw invalid({ key: `"${key}" is not a setting; settings are ${[...SETTINGS.keys()].join(', ')}` });
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
    if (input.key !== undefined && !SETTINGS.has(input.key) && !stored.has(input.key)) unknownKey(input.key);
    for (const [key, spec] of SETTINGS) {
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
    // Keys a newer release set are shown as they are (as own properties, whatever the tracker named them).
    for (const [key, setting] of stored) {
      if (SETTINGS.has(key) || !wanted(key)) continue;
      const shown: ShownSetting = { value: setting.value, default: false, at: setting.at, by: setting.by };
      Object.defineProperty(result.store, key, { value: shown, enumerable: true, writable: true, configurable: true });
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
  /** The excerpt mode: the disclosure, shown again. */
  disclosure?: string[];
  /** The excerpt mode, loosened: every clone applies it at its next cut, and teammates aren't asked. */
  warning?: string;
  /** The excerpt mode, tightened: how many open attempts' session records lost their text in the same commit. */
  stripped?: number;
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
  async run(input, { ctx, tracker, actor, servedChanged }): Promise<SettingsSetResult> {
    const spec = SETTINGS.get(input.key) ?? unknownKey(input.key);
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
    const write = await tracker.transact({ op: 'settings-set', author, actor }, async (draft) => {
      const current = draft.settings().get(input.key);
      if (current && JSON.stringify(current.value) === JSON.stringify(value)) {
        return { result: { key: input.key, scope: 'store' as const, value, changed: false, at: current.at, by: current.by } as SettingsSetResult };
      }
      const mode = input.key === EXCERPTS_SETTING ? { from: storeExcerptMode(draft), to: value as ExcerptMode } : null;
      draft.putSetting(input.key, value, author.email);
      const at = draft.now.toISOString();
      const result: SettingsSetResult = { key: input.key, scope: 'store' as const, value, changed: true, at, by: author.email };
      // The excerpt mode (spec §14): a mode that forbids text strips it from the open attempts in this commit.
      if (mode && mode.to !== 'excerpts') result.stripped = await stripOpenAttempts(draft);
      if (mode && MODE_RANK[mode.to] > MODE_RANK[mode.from]) result.warning = LOOSENING_WARNING;
      return { result };
    });
    if (input.key === EXCERPTS_SETTING) write.result.disclosure = disclosureLines(value as ExcerptMode);
    // The delivery switch: off removes every copy and stub, on brings them back (spec §15).
    if (write.result.changed && input.key === DELIVERY_SETTING) servedChanged();
    return write.result;
  },
});
