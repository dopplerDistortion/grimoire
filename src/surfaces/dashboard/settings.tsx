// The Settings screen (spec §20 Settings): the store settings, human-only and
// behind a scope dialog ("committed on grimoire/tracker; every worktree now,
// every clone after sync"); this machine's settings; the runner's status with
// the CLI commands; the sync panel with Sync now; the dashboard session; and
// the purged records with the history caveat. Every value shown is the
// core's (`settings_get`, `sync_status`, `purge_list`); every change is a
// `settings_set`, recorded as the signed-in person through the dashboard.
import { useCallback, useEffect, useState } from 'preact/hooks';
import { read, runner as readRunner, signOut, write, type SessionInfo } from './api';
import { useLiveRefetch } from './data';
import { ago } from './format';
import { positionText, syncNow, useSyncStatus } from './sync';
import type { PurgeListResult, RunnerInfo, SettingsResult, SettingsSetResult, ShownSetting } from './types';
import { errorText, LockTag, openDialog, toast } from './ui';

/** How the screen names the settings it knows; any other key shows as itself. */
const LABELS: Readonly<Record<string, string>> = {
  excerpts: 'Session excerpts in traces',
  'auto-sync': 'Automatic sync',
  link_base: 'link_base',
  'skills.delivery': 'Evolved-skill delivery',
  'knowledge.loop': 'Knowledge loop',
  'knowledge.pickup': 'Knowledge chore pickup',
  'dashboard.stale_after': 'Call a claim stale after',
  'capture.excerpts_max': 'Most this machine captures',
  'dashboard.port': 'Dashboard port',
};

/** The choices of the settings that have a few. */
const CHOICES: Readonly<Record<string, readonly string[]>> = {
  excerpts: ['excerpts', 'facts', 'none'],
  'auto-sync': ['true', 'false'],
  'skills.delivery': ['true', 'false'],
  'knowledge.loop': ['on', 'paused'],
  'knowledge.pickup': ['ask', 'auto', 'manual'],
  'capture.excerpts_max': ['excerpts', 'facts', 'none'],
};

/** The store settings shown first, in this order; the loop's thresholds follow. */
const STORE_FIRST = ['excerpts', 'auto-sync', 'link_base', 'skills.delivery', 'knowledge.loop'];
const MACHINE_ORDER = ['knowledge.pickup', 'dashboard.stale_after', 'capture.excerpts_max', 'dashboard.port'];

const MODE_RANK: Readonly<Record<string, number>> = { none: 0, facts: 1, excerpts: 2 };

const label = (key: string) => LABELS[key] ?? key;
const shown = (value: unknown) => (value === true ? 'on' : value === false ? 'off' : value === '' ? '(empty)' : String(value));

/** A typed value as `settings_set` takes it: numbers and switches as JSON, text as it is. */
function valueOf(key: string, raw: string, current: unknown): unknown {
  if (raw === 'true' || raw === 'false') return raw === 'true';
  if (typeof current === 'number' && /^\s*\d+\s*$/.test(raw)) return Number(raw);
  if (key === 'dashboard.port' && /^\s*\d+\s*$/.test(raw)) return Number(raw);
  return raw;
}

export function SettingsScreen({ session }: { session: SessionInfo }) {
  const [settings, setSettings] = useState<SettingsResult | null>(null);
  const [purges, setPurges] = useState<PurgeListResult | null>(null);
  const [runner, setRunner] = useState<RunnerInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    void read<SettingsResult>('settings_get').then((value) => {
      setSettings(value);
      setError(null);
    }, (failure: unknown) => setError(errorText(failure)));
    void read<PurgeListResult>('purge_list').then(setPurges, () => {});
    void readRunner<RunnerInfo>().then(setRunner, () => {});
  }, []);
  useEffect(refetch, [refetch]);
  useLiveRefetch(refetch, (change) => change.settings || change.machine || change.knowledge);

  return (
    <div class="settings">
      <h1>Settings</h1>
      {error ? <div class="err">{error}</div> : null}
      <div class="settings-grid">
        <div class="stack">
          {settings ? <StoreSettings settings={settings} onChanged={refetch} /> : null}
          {settings ? <MachineSettings settings={settings} onChanged={refetch} /> : null}
          <RunnerPanel runner={runner} />
        </div>
        <div class="stack">
          <SyncPanel />
          <SessionPanel session={session} />
          <PurgedPanel purges={purges} />
        </div>
      </div>
    </div>
  );
}

// ---------- store settings ----------

function StoreSettings({ settings, onChanged }: { settings: SettingsResult; onChanged: () => void }) {
  const keys = Object.keys(settings.store);
  const ordered = [...STORE_FIRST.filter((key) => key in settings.store), ...keys.filter((key) => !STORE_FIRST.includes(key)).sort()];
  return (
    <div class="panel pad settings-store">
      <div class="row between">
        <h2>Store settings</h2>
        <LockTag />
      </div>
      <p class="mute small">
        Committed on <code>grimoire/tracker</code>: every worktree now, every clone after sync.
      </p>
      <table>
        <tbody>
          {ordered.map((key) => (
            <SettingRow key={key} name={key} setting={settings.store[key]!} scope="store" onChanged={onChanged} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What the scope dialog adds for one store change: the consequences the person should know first. */
function consequences(key: string, from: unknown, to: unknown) {
  if (key === 'excerpts' && typeof from === 'string' && typeof to === 'string') {
    if ((MODE_RANK[to] ?? 0) < (MODE_RANK[from] ?? 0)) {
      return (
        <p class="banner warn">
          Tightening strips the excerpt text from every open attempt’s session records in the same commit. Sealed traces keep theirs, and pushed history keeps what it has.
        </p>
      );
    }
    return <p class="banner warn">Loosening: every clone applies it at its next cut, and teammates aren’t asked.</p>;
  }
  if (key === 'skills.delivery' && to === false) {
    return <p class="banner warn">Turning delivery off removes every evolved-skill copy and stub from every worktree, and new attempts record the switch as off.</p>;
  }
  if (key === 'knowledge.loop' && to === 'paused') {
    return <p class="mute">While paused no chore becomes due; runs already going may still submit, and decisions and restores keep working.</p>;
  }
  return null;
}

/** After an excerpt-mode change: the disclosure again, and what the change did. */
function showDisclosure(result: SettingsSetResult): void {
  openDialog({
    title: `Excerpt mode: ${shown(result.value)}`,
    ok: 'OK',
    notice: true,
    body: (
      <div class="disclosure">
        {(result.disclosure ?? []).map((line) => (
          <p key={line}>{line}</p>
        ))}
        {result.warning ? <p class="banner warn">{result.warning}</p> : null}
        {result.stripped !== undefined ? (
          <p class="stripped">
            Stripped the excerpt text from {result.stripped} open attempt session record{result.stripped === 1 ? '' : 's'} in the same commit.
          </p>
        ) : null}
      </div>
    ),
  });
}

/**
 * The scope dialog a store setting's change goes through (spec §20 Settings):
 * human-only, "committed on grimoire/tracker; every worktree now, every clone
 * after sync", with what the change does. `apply` writes it.
 */
export function confirmStoreSetting(name: string, from: unknown, to: unknown, apply: () => Promise<unknown>, onCancel?: () => void): void {
  openDialog({
    title: `Change ${label(name)}?`,
    humanOnly: true,
    ok: 'Save store setting',
    body: (
      <>
        <p>
          <b>{shown(from)}</b> → <b>{shown(to)}</b>
        </p>
        <p class="scope">
          Committed on <code>grimoire/tracker</code>; every worktree now, every clone after sync.
        </p>
        {consequences(name, from, to)}
      </>
    ),
    run: async () => {
      await apply();
    },
    ...(onCancel ? { onCancel } : {}),
  });
}

/** Sets a store setting behind the scope dialog, then calls `done`. */
export function changeStoreSetting(name: string, from: unknown, to: unknown, done: () => void): void {
  confirmStoreSetting(name, from, to, async () => {
    await write<SettingsSetResult>('settings_set', { key: name, value: to });
    toast(`${label(name)}: ${shown(to)}. Committed on grimoire/tracker.`);
    done();
  });
}

export function SettingRow({ name, setting, scope, onChanged }: { name: string; setting: ShownSetting; scope: 'store' | 'machine'; onChanged: () => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const current = String(setting.value);
  const known = setting.description !== undefined;
  const choices = CHOICES[name];

  const change = (raw: string) => {
    const value = valueOf(name, raw, setting.value);
    if (JSON.stringify(value) === JSON.stringify(setting.value)) return setDraft(null);
    const apply = async () => {
      const result = await write<SettingsSetResult>('settings_set', { key: name, value });
      setDraft(null);
      onChanged();
      if (result.disclosure) setTimeout(() => showDisclosure(result), 0);
      return result;
    };
    if (scope === 'machine') {
      setDraft(raw);
      void apply().then(
        () => toast(name === 'dashboard.port' ? 'Saved on this machine only; start listens there after a restart.' : 'Saved on this machine only.'),
        (failure: unknown) => {
          setDraft(null);
          toast(errorText(failure));
        },
      );
      return;
    }
    setDraft(raw);
    confirmStoreSetting(name, setting.value, value, apply, () => setDraft(null));
  };

  const value = draft ?? current;
  return (
    <tr class="setting-row" data-key={name}>
      <td>
        <div>{label(name)}</div>
        {setting.description ? <div class="small mute">{setting.description}</div> : <div class="small mute">set by a newer grimoire; shown as it is</div>}
        {!setting.default && setting.by ? (
          <div class="small mute">
            set by {setting.by}
            {setting.at ? ` ${ago(setting.at)}` : ''}
          </div>
        ) : null}
      </td>
      <td class="setting-value">
        {!known ? (
          <code>{JSON.stringify(setting.value)}</code>
        ) : choices ? (
          <select value={value} onChange={(event) => change((event.target as HTMLSelectElement).value)}>
            {choices.map((choice) => (
              <option key={choice} value={choice}>
                {shown(choice === 'true' ? true : choice === 'false' ? false : choice)}
              </option>
            ))}
          </select>
        ) : (
          <TextSetting value={value} numeric={typeof setting.value === 'number'} onSave={change} />
        )}
      </td>
    </tr>
  );
}

function TextSetting({ value, numeric, onSave }: { value: string; numeric: boolean; onSave: (raw: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <form
      class="row setting-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(text.trim());
      }}
    >
      {numeric ? (
        <input class="num" type="number" value={text} onInput={(event) => setText((event.target as HTMLInputElement).value)} />
      ) : (
        <input class="text" type="text" value={text} onInput={(event) => setText((event.target as HTMLInputElement).value)} />
      )}
      <button type="submit" disabled={text.trim() === value}>
        Save
      </button>
    </form>
  );
}

// ---------- this machine ----------

function MachineSettings({ settings, onChanged }: { settings: SettingsResult; onChanged: () => void }) {
  const keys = [...MACHINE_ORDER.filter((key) => key in settings.machine), ...Object.keys(settings.machine).filter((key) => !MACHINE_ORDER.includes(key)).sort()];
  return (
    <div class="panel pad settings-machine">
      <div class="row between">
        <h2>This machine</h2>
        <LockTag />
      </div>
      <p class="mute small">Kept in this clone’s machine-local store, never committed.</p>
      <table>
        <tbody>
          {keys.map((key) => (
            <SettingRow key={key} name={key} setting={settings.machine[key]!} scope="machine" onChanged={onChanged} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------- the runner ----------

export function RunnerPanel({ runner, title = 'Runner (this machine)' }: { runner: RunnerInfo | null; title?: string }) {
  if (!runner) return null;
  const trigger = runner.trigger ?? null;
  return (
    <div class="panel pad small runner-panel">
      <h2>{title}</h2>
      {runner.enabled ? (
        <>
          <div>
            <b>{runner.kind}</b> · <code>{runner.binary}</code>
            {runner.model ? ` · model ${runner.model}` : ''}
          </div>
          <div class="runner-runs">
            {runner.runs_today} of {runner.runs_per_day} runs in the last 24 h
            {runner.paused_until ? ` · paused until ${runner.paused_until} after failed runs` : runner.next_run_at ? ` · at its daily cap until ${runner.next_run_at}` : ''}
          </div>
          {runner.last ? (
            <div>
              Last run: {runner.last.result}
              {runner.last.kind ? ` (${runner.last.kind})` : ''} {ago(runner.last.at)}
              {runner.last.reason ? `: ${runner.last.reason}` : ''}
            </div>
          ) : null}
          <div class="runner-preflight">
            Preflight:{' '}
            {trigger?.preflight ? (
              <>
                <span class="chip bad">refused</span> {trigger.message} · {ago(trigger.at)}
              </>
            ) : (
              <>
                <span class="chip ok">passed</span> when it was enabled{runner.auth_method ? ` (auth ${runner.auth_method})` : ''}
              </>
            )}
          </div>
          {trigger && !trigger.preflight ? (
            <div class="runner-trigger mute">
              Last check by start {ago(trigger.at)}: {trigger.outcome}
              {trigger.outcome === 'refused' && trigger.message ? ` (${trigger.message})` : ''}
            </div>
          ) : null}
          {runner.auth_method ? (
            <div>
              Auth: {runner.auth_method}
              {runner.bills_api ? <span class="chip warn">bills outside the plan</span> : null}
            </div>
          ) : null}
          {runner.warnings.length > 0 ? (
            <div class="banner warn small">
              {runner.warnings.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          ) : null}
          <div class="mute">
            Status only. Turn it off with <code>{runner.commands.disable}</code> in a terminal.
          </div>
        </>
      ) : (
        <div class="mute">
          Not enabled on this machine. Enable one in a terminal: <code>{runner.commands.enable.join('  or  ')}</code>
        </div>
      )}
    </div>
  );
}

// ---------- sync ----------

function SyncPanel() {
  const status = useSyncStatus();
  const [busy, setBusy] = useState(false);
  if (!status) return <div class="panel pad sync-panel">Reading the sync status…</div>;
  const position = status.position;
  return (
    <div class="panel pad sync-panel">
      <h2>Sync</h2>
      <table>
        <tbody>
          <tr>
            <td>Remote</td>
            <td class="sync-remote">
              {status.remote ? (
                <>
                  <code>{status.remote}/grimoire/tracker</code>
                  {status.url ? <span class="mute small"> · {status.url}</span> : null}
                </>
              ) : (
                <span class="mute">none yet</span>
              )}
            </td>
          </tr>
          <tr>
            <td>Local tracker</td>
            <td class="sync-position">
              {positionText(position)}
              {position?.state === 'diverged' ? <span class="chip warn">diverged</span> : null}
              {position?.local ? <span class="mute small"> · {position.local.slice(0, 7)}</span> : null}
              <span class="mute small"> (against the remote as last fetched)</span>
            </td>
          </tr>
          <tr>
            <td>Last sync</td>
            <td class="sync-last">
              {status.last_success_at ? ago(status.last_success_at) : 'never on this machine'}
              {status.last_attempt_at && status.last_attempt_at !== status.last_success_at ? <span class="mute small"> · last tried {ago(status.last_attempt_at)}</span> : null}
              {status.auto_sync === false ? <span class="chip warn">auto-sync off</span> : null}
            </td>
          </tr>
          <tr>
            <td>Waiting</td>
            <td>{status.pending_since ? `since ${ago(status.pending_since)}` : <span class="mute">nothing</span>}</td>
          </tr>
          <tr>
            <td>Last rejection</td>
            <td class="sync-failure">
              {status.failure ? (
                <div class="banner bad small">
                  <div class="b">
                    {status.failure.class === 'rejected' ? 'The remote rejected the push' : status.failure.class === 'auth' ? 'Authentication failed' : 'The remote could not be reached'} · {ago(status.failure.at)} · in a{' '}
                    {status.failure.client} {status.failure.surface}
                  </div>
                  <div class="src">{status.failure.message}</div>
                  {status.fix ? <div class="sync-fix">{status.fix}</div> : null}
                </div>
              ) : (
                <span class="mute">none</span>
              )}
            </td>
          </tr>
        </tbody>
      </table>
      <div class="row">
        <button
          type="button"
          class="pri sync-now"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void syncNow()
              .then(toast, (failure: unknown) => toast(errorText(failure)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Syncing…' : 'Sync now'}
        </button>
        <span class="mute small">fetch → fold → push</span>
      </div>
    </div>
  );
}

// ---------- the session ----------

function SessionPanel({ session }: { session: SessionInfo }) {
  const who = session.identity?.email ?? session.identity?.name ?? 'no git identity';
  return (
    <div class="panel pad small session-panel">
      <h2>Dashboard session</h2>
      <div>
        Signed in as <b>{who}</b> (this clone’s git identity){session.since ? `, ${ago(session.since)}` : ''}.
      </div>
      <div class="mute">
        The session ends when <code>grimoire start</code> stops. Without it, anything that reaches this port gets nothing.
      </div>
      <div class="row">
        <button type="button" class="sign-out" onClick={() => void signOut().finally(() => location.replace('/'))}>
          Sign out
        </button>
      </div>
    </div>
  );
}

// ---------- purged records ----------

function PurgedPanel({ purges }: { purges: PurgeListResult | null }) {
  if (!purges) return null;
  return (
    <div class="panel pad small purged-panel">
      <h2>Purged records</h2>
      {purges.purged.length === 0 ? <div class="mute">None.</div> : null}
      {purges.purged.map((record) => (
        <div key={`${record.kind}:${record.id}:${record.key ?? ''}`} class="purged-row">
          <span class="id">{record.id}</span> · {record.kind === 'session' ? `session record ${record.key?.slice(0, 8)}… (${record.facts === 'kept' ? 'excerpt' : 'excerpt and facts'})` : record.kind} · {record.by} ·{' '}
          {ago(record.at)} · {record.reason}
        </div>
      ))}
      <div class="mute history-note">{purges.note}</div>
    </div>
  );
}
