// The dashboard's live events (spec §20, SSE): `GET /api/events`, one stream
// per tab. While any stream is open, `start` checks the tracker's tip pair
// (`refs/grimoire/tracker` and the chosen remote's remote-tracking tracker
// ref) about every second, plus the machine-local store and the launch
// worktree's pin, and tells every stream what changed:
//
//   event: change   id: <tip pair>:<stamp>
//   data: {"tips": {local, remote}, "issues": [...], "attempts": [...],
//          "knowledge", "settings", "sync", "machine", "instance", "agent"}
//
//   event: reload   after a large jump, a fold, a new or rewritten history
//   event: ready    on connect, carrying the current id
//   event: heartbeat  every 15 s
//
// The change set comes from the `Grimoire-Issue`, `Grimoire-Attempt`,
// `Grimoire-Op` and `Grimoire-Actor` trailers of the commits between the old
// and the new tips. `<stamp>` hashes the machine-local store and the pin, so a
// browser that reconnects with `Last-Event-ID` learns everything that changed
// while it was away (or gets `reload` when that id is unknown here).
import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { runGit } from '../../git/run';
import type { TrackerTips } from '../../tracker';

/** How often the tips are checked while a stream is open. */
export const LIVE_CHECK_MS = 1_000;
/** How often every stream gets a heartbeat. */
export const HEARTBEAT_MS = 15_000;
/** More commits than this between two checks is a large jump: `reload`. */
export const LARGE_JUMP = 500;

/** What one `change` event carries. */
export interface ChangeSet {
  readonly tips: TrackerTips;
  readonly issues: string[];
  readonly attempts: string[];
  readonly knowledge: boolean;
  readonly settings: boolean;
  readonly sync: boolean;
  readonly machine: boolean;
  /** The launch worktree's pin changed: the dashboard re-reads `/api/instance`. */
  readonly instance: boolean;
  /** An agent made at least one of the commits. */
  readonly agent: boolean;
}

export interface LiveEventsOptions {
  /** The checkout `start` runs from: git runs here. */
  readonly root: string;
  /** `<git-common-dir>/grimoire`. */
  readonly machineDir: string;
  /** The tip pair, resolved fresh. */
  readonly tips: () => Promise<TrackerTips>;
  /** The launch worktree's pin, read fresh. */
  readonly pin: () => Promise<string | null>;
  readonly checkMs?: number;
  readonly heartbeatMs?: number;
}

interface LiveState {
  readonly local: string | null;
  readonly remote: string | null;
  /** A hash of the machine-local store's records and sync markers, and the pin. */
  readonly stamp: string;
  /** The parts of the stamp, for telling which changed. */
  readonly machine: string;
  readonly sync: string;
  readonly pin: string | null;
}

type Outgoing = { readonly event: 'change'; readonly data: ChangeSet } | { readonly event: 'reload'; readonly data: { tips: TrackerTips } } | null;

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const KNOWLEDGE_OP = /^(?:skill|wiki|proposal|chore|knowledge|ledger|purge)-|^(?:quarantine|unquarantine)$/;
/** Ops after which the client reloads rather than refetching pieces. */
const RELOAD_OPS = new Set(['fold', 'init']);

function idOf(state: LiveState): string {
  return `${state.local ?? '0'}:${state.remote ?? '0'}:${state.stamp}`;
}

function parseId(id: string): { local: string | null; remote: string | null; stamp: string } | null {
  const [local, remote, stamp, ...rest] = id.split(':');
  const tip = (value: string | undefined) => (value === '0' ? null : value !== undefined && OID.test(value) ? value : undefined);
  const l = tip(local);
  const r = tip(remote);
  if (rest.length > 0 || l === undefined || r === undefined || !stamp || !/^[0-9a-f]{12}$/.test(stamp)) return null;
  return { local: l, remote: r, stamp };
}

/** A fingerprint of the files directly under each of `dirs`' subfolders (or the folder itself). */
async function fingerprint(dirs: readonly { dir: string; nested: boolean }[]): Promise<string> {
  const hash = createHash('sha256');
  for (const { dir, nested } of dirs) {
    const folders = nested ? (await readdir(dir).catch(() => [] as string[])).sort().map((name) => path.join(dir, name)) : [dir];
    for (const folder of folders) {
      const names = (await readdir(folder).catch(() => [] as string[])).filter((name) => name.endsWith('.json')).sort();
      for (const name of names) {
        const info = await stat(path.join(folder, name)).catch(() => null);
        if (info) hash.update(`${path.basename(folder)}/${name}\0${info.size}\0${info.mtimeMs}\n`);
      }
    }
  }
  return hash.digest('hex').slice(0, 12);
}

interface Stream {
  readonly response: ServerResponse;
}

export class LiveEvents {
  private readonly streams = new Set<Stream>();
  private state: LiveState | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private checking = false;
  private checkTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly options: LiveEventsOptions) {}

  /** Opens a stream on `response`; `Last-Event-ID` (or the `last_event_id` query) resumes from an earlier id. */
  attach(request: IncomingMessage, response: ServerResponse, lastEventId: string | null): void {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    response.write('retry: 2000\n\n');
    const stream: Stream = { response };
    const detach = () => {
      if (!this.streams.delete(stream)) return;
      if (this.streams.size === 0) this.idle();
    };
    request.once('close', detach);
    response.once('close', detach);
    void this.serial(async () => {
      if (this.closed || response.destroyed) return;
      let current: LiveState;
      try {
        // While idle nothing kept the state fresh; with streams open, the checks keep it at most a check old.
        if (this.state === null || this.streams.size === 0) this.state = await this.read();
        current = this.state;
      } catch {
        // Nothing to tell yet: end the stream, and the browser reconnects after `retry`.
        return void response.end();
      }
      if (response.destroyed) return;
      this.streams.add(stream);
      this.wake();
      const resumed = lastEventId === null ? null : parseId(lastEventId);
      const message = lastEventId === null ? null : resumed === null ? reloadOf(current) : await this.between(resumed, current).catch(() => reloadOf(current));
      if (message) send(response, message.event, idOf(current), message.data);
      else send(response, 'ready', idOf(current), { tips: tipsOf(current) });
    });
  }

  /** Ends every stream and stops checking. */
  close(): void {
    this.closed = true;
    this.idle();
    for (const { response } of this.streams) response.end();
    this.streams.clear();
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task);
    this.chain = next.catch(() => {});
    return next;
  }

  private wake(): void {
    if (this.checkTimer === null) {
      this.checkTimer = setInterval(() => this.check(), this.options.checkMs ?? LIVE_CHECK_MS);
      this.checkTimer.unref();
    }
    if (this.heartbeatTimer === null) {
      this.heartbeatTimer = setInterval(() => {
        for (const { response } of this.streams) response.write('event: heartbeat\ndata: {}\n\n');
      }, this.options.heartbeatMs ?? HEARTBEAT_MS);
      this.heartbeatTimer.unref();
    }
  }

  private idle(): void {
    if (this.checkTimer) clearInterval(this.checkTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.checkTimer = null;
    this.heartbeatTimer = null;
  }

  /** One check: a change goes to every stream. A check still running makes the next one skip. */
  private check(): void {
    if (this.checking) return;
    this.checking = true;
    void this.serial(async () => {
      try {
        const previous = this.state;
        // A failed read (git busy, a ref mid-update) keeps the old state: the next check tries again.
        const next = await this.read();
        // Commits it can't read are never dropped: the client refetches everything instead.
        const message = previous === null || idOf(previous) === idOf(next) ? null : await this.between(previous, next).catch(() => reloadOf(next));
        this.state = next;
        if (!message) return;
        for (const { response } of this.streams) send(response, message.event, idOf(next), message.data);
      } catch {
        // Nothing moved on: the next check tries again.
      } finally {
        this.checking = false;
      }
    });
  }

  private async read(): Promise<LiveState> {
    const { machineDir } = this.options;
    const [tips, machine, sync, pin] = await Promise.all([
      this.options.tips(),
      fingerprint([
        { dir: path.join(machineDir, 'records'), nested: true },
        { dir: path.join(machineDir, 'coordination', 'sync-pending'), nested: false },
      ]),
      fingerprint([
        { dir: path.join(machineDir, 'records', 'sync-status'), nested: false },
        { dir: path.join(machineDir, 'coordination', 'sync-pending'), nested: false },
      ]),
      this.options.pin().catch(() => null),
    ]);
    const stamp = createHash('sha256').update(`${machine}\0${sync}\0${pin ?? ''}`).digest('hex').slice(0, 12);
    return { local: tips.local, remote: tips.remote, stamp, machine, sync, pin };
  }

  /** What changed from `from` (a state, or only an id's parts) to `to`; null for nothing. */
  private async between(from: { local: string | null; remote: string | null; stamp: string } & Partial<LiveState>, to: LiveState): Promise<Outgoing> {
    const tipsMoved = from.local !== to.local || from.remote !== to.remote;
    const stampMoved = from.stamp !== to.stamp;
    if (!tipsMoved && !stampMoved) return null;
    // From an id alone, the parts of the stamp can't be told apart: all of them changed.
    const machine = stampMoved && (from.machine === undefined || from.machine !== to.machine);
    const sync = stampMoved && (from.sync === undefined || from.sync !== to.sync);
    const instance = stampMoved && (from.machine === undefined || from.pin !== to.pin);
    const tips = tipsOf(to);
    if (!tipsMoved) {
      return { event: 'change', data: { tips, issues: [], attempts: [], knowledge: false, settings: false, sync, machine, instance, agent: false } };
    }
    const commits = await this.commitsBetween(from, to);
    if (commits === null) return { event: 'reload', data: { tips } };
    const issues = new Set<string>();
    const attempts = new Set<string>();
    let knowledge = false;
    let settings = false;
    let agent = false;
    for (const trailers of commits) {
      const op = trailers.get('Grimoire-Op') ?? '';
      if (RELOAD_OPS.has(op)) return { event: 'reload', data: { tips } };
      const issue = trailers.get('Grimoire-Issue');
      const attempt = trailers.get('Grimoire-Attempt');
      if (issue) issues.add(issue);
      if (attempt) attempts.add(attempt);
      if (KNOWLEDGE_OP.test(op)) knowledge = true;
      if (op === 'settings-set') settings = true;
      if (actorKind(trailers.get('Grimoire-Actor')) === 'agent') agent = true;
    }
    return {
      event: 'change',
      data: { tips, issues: [...issues].sort(), attempts: [...attempts].sort(), knowledge, settings, sync: true, machine, instance, agent },
    };
  }

  /**
   * The trailers of every commit the new tips have that the old ones didn't;
   * null when the client should reload: no tracker any more, an old tip the
   * new ones don't contain (a rewrite, a purge, an id from elsewhere), or a
   * large jump.
   */
  private async commitsBetween(from: { local: string | null; remote: string | null }, to: LiveState): Promise<Map<string, string>[] | null> {
    const fresh = [...new Set([to.local, to.remote].filter((tip): tip is string => tip !== null))];
    const old = [...new Set([from.local, from.remote].filter((tip): tip is string => tip !== null))];
    if (fresh.length === 0 || old.length === 0) return null;
    const { root } = this.options;
    const lost = await runGit(root, ['rev-list', '--count', ...old, '--not', ...fresh, '--']);
    if (lost.code !== 0 || lost.stdout.toString('utf8').trim() !== '0') return null;
    const log = await runGit(root, ['log', '--no-color', `--max-count=${LARGE_JUMP + 1}`, '--format=%x1e%B', ...fresh, '--not', ...old, '--']);
    if (log.code !== 0) return null;
    const messages = log.stdout.toString('utf8').split('\x1e').slice(1);
    if (messages.length > LARGE_JUMP) return null;
    return messages.map(trailersOf);
  }
}

function tipsOf(state: LiveState): TrackerTips {
  return { local: state.local, remote: state.remote };
}

function reloadOf(state: LiveState): Outgoing {
  return { event: 'reload', data: { tips: tipsOf(state) } };
}

function send(response: ServerResponse, event: string, id: string, data: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** The `Grimoire-*` trailers of a commit message: one per line in its last paragraph. */
function trailersOf(message: string): Map<string, string> {
  const trailers = new Map<string, string>();
  const paragraphs = message.replace(/\r\n/g, '\n').trim().split(/\n{2,}/);
  for (const line of (paragraphs.at(-1) ?? '').split('\n')) {
    const match = /^(Grimoire-[A-Za-z]+): (.*)$/.exec(line);
    if (match && !trailers.has(match[1]!)) trailers.set(match[1]!, match[2]!.trim());
  }
  return trailers;
}

function actorKind(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { kind?: unknown };
    return typeof parsed.kind === 'string' ? parsed.kind : null;
  } catch {
    return null;
  }
}
