// Shared pieces of the dashboard's screens: who is signed in, toasts, the
// confirmation dialog (spec §20, Confirmations), and the chips that render the
// core's derived fields (spec §20, State-chip precedence). Nothing here derives
// state: every chip reads fields the core computed.
import { createContext, type ComponentChildren } from 'preact';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { ApiError } from './api';
import { short } from './format';

/** The signed-in person: every action is recorded as them, through the dashboard. */
export const Me = createContext<{ email: string | null; name: string | null }>({ email: null, name: null });

export function useMe(): { email: string | null; name: string | null } {
  return useContext(Me);
}

/** What a failed call says, for a person: the code and the core's message. */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error);
}

// ---------- toasts ----------

interface Toast {
  readonly id: number;
  readonly text: string;
  readonly href?: string | undefined;
}

let toasts: Toast[] = [];
let nextToast = 0;
const toastListeners = new Set<() => void>();

/** Shows a short note in the corner for a few seconds. */
export function toast(text: string, href?: string): void {
  const entry: Toast = { id: nextToast++, text, href };
  toasts = [...toasts, entry].slice(-5);
  for (const listener of toastListeners) listener();
  setTimeout(() => {
    toasts = toasts.filter((t) => t !== entry);
    for (const listener of toastListeners) listener();
  }, 6_500);
}

export function Toasts() {
  const [, rerender] = useState(0);
  useEffect(() => {
    const update = () => rerender((n) => n + 1);
    toastListeners.add(update);
    return () => void toastListeners.delete(update);
  }, []);
  return (
    <div class="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} class="toast">
          {t.text}
          {t.href ? (
            <>
              {' '}
              <a href={t.href}>Open</a>
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}

// ---------- the confirmation dialog ----------

export type FormValues = Record<string, string>;

export interface DialogSpec {
  readonly title: string;
  /** A human-only action: the dialog carries 🔒. */
  readonly humanOnly?: boolean;
  readonly danger?: boolean;
  readonly ok: string;
  /** The text the person must type to confirm (an id for a delete). */
  readonly typed?: string;
  /** The dialog's body: named inputs are read when it is confirmed. */
  readonly body?: ComponentChildren;
  /** A problem with the values that stops the action before it is sent, or null. */
  readonly validate?: (values: FormValues) => string | null;
  /** Runs the action; a throw keeps the dialog open and shows the error. */
  readonly run?: (values: FormValues) => Promise<unknown> | void;
  /** Only an OK button: the dialog says something, it doesn't ask. */
  readonly notice?: boolean;
  /** Runs when the person cancels (Cancel or Escape), never after the action ran. */
  readonly onCancel?: () => void;
}

let dialog: DialogSpec | null = null;
let dialogSerial = 0;
const dialogListeners = new Set<() => void>();

export function openDialog(spec: DialogSpec): void {
  dialog = spec;
  dialogSerial++;
  for (const listener of dialogListeners) listener();
}

export function closeDialog(): void {
  dialog = null;
  for (const listener of dialogListeners) listener();
}

export function DialogHost() {
  const [, rerender] = useState(0);
  useEffect(() => {
    const update = () => rerender((n) => n + 1);
    dialogListeners.add(update);
    return () => void dialogListeners.delete(update);
  }, []);
  return dialog ? <Dialog key={dialogSerial} spec={dialog} /> : null;
}

function valuesOf(form: HTMLFormElement): FormValues {
  const values: FormValues = {};
  for (const [key, value] of new FormData(form).entries()) if (typeof value === 'string') values[key] = value;
  return values;
}

function Dialog({ spec }: { spec: DialogSpec }) {
  const me = useMe();
  const form = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const first = form.current?.querySelector<HTMLElement>('input[name="__typed"], textarea, input:not([type=radio]):not([type=checkbox]), select');
    (first ?? form.current?.querySelector<HTMLElement>('button.ok'))?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const cancel = () => {
    spec.onCancel?.();
    closeDialog();
  };

  const confirm = async () => {
    if (!form.current || busy) return;
    const values = valuesOf(form.current);
    if (spec.typed !== undefined && (values.__typed ?? '').trim() !== spec.typed) return setError(`Type ${spec.typed} to confirm.`);
    const problem = spec.validate?.(values) ?? null;
    if (problem) return setError(problem);
    setBusy(true);
    try {
      await spec.run?.(values);
      closeDialog();
    } catch (failure) {
      setError(errorText(failure));
      setBusy(false);
    }
  };

  const who = me.email ?? me.name ?? 'you';
  return (
    <div class="overlay" role="dialog" aria-modal="true" aria-label={spec.title}>
      <form
        ref={form}
        class="modal"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        <div class="modal-body">
          <h2>{spec.title}</h2>
          <div class="recorded">
            {spec.humanOnly ? '🔒 human-only · ' : ''}recorded as {who} through the dashboard
          </div>
          <div class="stack">{spec.body}</div>
          {spec.typed !== undefined ? (
            <label class="field">
              Type <code>{spec.typed}</code> to confirm
              <input name="__typed" autocomplete="off" />
            </label>
          ) : null}
          {error ? <div class="err dialog-error">{error}</div> : null}
        </div>
        <div class="modal-actions">
          {spec.notice ? null : (
            <button type="button" class="cancel" onClick={cancel}>
              Cancel
            </button>
          )}
          <button type="submit" class={`ok ${spec.danger ? 'danger solid' : 'pri'}`} disabled={busy}>
            {spec.ok}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------- chips and names ----------

export const LockTag = () => (
  <span class="lock" title="Human-only: never offered to agents over MCP">
    🔒 human-only
  </span>
);

/** The derived facts a state chip renders, as `list` and `show` return them. */
export interface StateFacts {
  readonly status: string;
  readonly conflict: boolean;
  readonly claimed: boolean;
  readonly stale: boolean;
  readonly openBlockers: number;
  readonly openChildren: number;
  readonly ready: boolean;
}

/**
 * The state chip, in the spec's precedence: done or canceled; a conflict
 * prefix; stale claim, or claimed; blocked · n; n open sub-issues; ready; open.
 */
export function StateChip({ facts }: { facts: StateFacts }) {
  if (facts.status === 'done') return <span class="chip ok state">done</span>;
  if (facts.status === 'canceled') return <span class="chip state">canceled</span>;
  const prefix = facts.conflict ? <span class="chip bad state">conflict</span> : null;
  let main = null;
  if (facts.claimed) main = facts.stale ? <span class="chip warn state">stale claim</span> : <span class="chip info state">claimed</span>;
  else if (facts.openBlockers > 0) main = <span class="chip state">blocked · {facts.openBlockers}</span>;
  else if (facts.openChildren > 0) main = <span class="chip state">{facts.openChildren} open sub-issue{facts.openChildren > 1 ? 's' : ''}</span>;
  else if (facts.ready) main = <span class="chip acc state">ready</span>;
  if (!prefix && !main) return <span class="chip state">open</span>;
  return (
    <span class="chips">
      {prefix}
      {main}
    </span>
  );
}

export function OutcomeChip({ outcome }: { outcome: { verdict: string; set_by: string } | null }) {
  if (!outcome) return <span class="chip">no outcome</span>;
  const tone = outcome.verdict === 'pass' ? 'ok' : outcome.verdict === 'fail' ? 'bad' : '';
  return (
    <span class="chips">
      <span class={`chip outcome ${tone}`}>{outcome.verdict}</span>
      {outcome.set_by.startsWith('human:') ? (
        <span class="chip warn" title={`set by ${outcome.set_by.slice(6)}`}>
          overridden
        </span>
      ) : null}
    </span>
  );
}

/** A session id, shortened for display. */
function shortSession(session: string): string {
  return session.length > 12 ? `${session.slice(0, 4)}…${session.slice(-4)}` : session;
}

/** A person, plus the client and session that acted for them. */
export function ActorName({ person, client, session }: { person: string | null | undefined; client?: string | null | undefined; session?: string | null | undefined }) {
  const via = client && client !== 'dashboard' && client !== 'cli' ? client : null;
  return (
    <span class="actor" title={person ?? undefined}>
      <b>{short(person)}</b>
      {via ? (
        <span class="mute">
          {' '}
          via {via}
          {session ? ` · ${shortSession(session)}` : ''}
        </span>
      ) : client === 'dashboard' ? (
        <span class="mute"> (dashboard)</span>
      ) : client === 'cli' ? (
        <span class="mute"> (cli)</span>
      ) : null}
    </span>
  );
}

/** A line diff, as source text (spec §20, Rendering: diffs render as source). */
export function DiffView({ lines, context }: { lines: readonly { t: '=' | '-' | '+'; l: string }[]; context?: number }) {
  const keep = lines.map((line, k) => {
    if (context === undefined || line.t !== '=') return true;
    for (let d = -context; d <= context; d++) if (lines[k + d] && lines[k + d]!.t !== '=') return true;
    return false;
  });
  const out: ComponentChildren[] = [];
  let gap = false;
  lines.forEach((line, k) => {
    if (!keep[k]) {
      if (!gap) out.push(<div key={`g${k}`} class="eq gap">  …</div>);
      gap = true;
      return;
    }
    gap = false;
    out.push(
      <div key={k} class={line.t === '+' ? 'add' : line.t === '-' ? 'del' : 'eq'}>
        {line.t === '=' ? '  ' : `${line.t} `}
        {line.l}
      </div>,
    );
  });
  return <div class="diff">{out}</div>;
}

/** A diff the core shows as lines marked `  `, `- ` or `+ ` (shownDiff), as source text. */
export function SourceDiff({ lines, context }: { lines: readonly string[]; context?: number }) {
  const parsed = lines.map((line) => ({ t: (line.startsWith('+ ') ? '+' : line.startsWith('- ') ? '-' : '=') as '=' | '-' | '+', l: line.slice(2) }));
  if (parsed.length === 0) return <div class="diff mute">No change.</div>;
  return context === undefined ? <DiffView lines={parsed} /> : <DiffView lines={parsed} context={context} />;
}

/** A version id, shortened for display (the whole id on hover). */
export function Version({ id }: { id: string | null | undefined }) {
  if (!id) return <span class="mute">none</span>;
  return (
    <code class="version-id" title={id}>
      {id.slice(0, 10)}
    </code>
  );
}
