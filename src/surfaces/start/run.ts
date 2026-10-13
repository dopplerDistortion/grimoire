// `grimoire start` and `grimoire open` (spec §12, §10 Runtime, §20).
//
// `start` is one foreground process per clone, with no daemon: it serves the
// dashboard, runs upkeep on its timers, syncs every 10 min and, while a
// runner is configured, runs due chores with it (src/runner/trigger.ts), until Ctrl-C
// or a control-channel `stop`. It refuses agent markers but needs no TTY (a
// login item may run it), and prints the sign-in URL only at a terminal.
// When the clone's `start` already runs, a second `start` signs a browser in
// to it over the control channel and exits 0; if the running version isn't
// this one, it says so and, at a terminal, offers to stop it and take over.
//
// `open [<ref>]` gets a fresh sign-in code over the control channel and opens
// a signed-in tab (landing on `<ref>`); it prints no secret.
//
// stdout is one JSON object, as for every verb: `start` prints it once it
// serves (`{"started": …}`) or once it signed a browser in to the running one
// (`{"running": …}`); errors are `{"error": …}` with exit 1. Beyond the
// shared codes (HUMAN_ONLY, NO_REPO), the conditions §9 doesn't name use
// (recorded for the spec's error table):
//   NOT_FOUND {start: null}  `open` with no live `start` for this clone
//   BUSY                     no port free of the 10 tried; a takeover whose
//                            old `start` didn't stop within 20 s; another
//                            `start` kept taking the lock (retrying may help)
//   INTERNAL                 the live `start`'s control channel can't be
//                            reached or refused; no browser could be opened
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { autoSync, createCore, syncRequestOf, type CallContext, type Identity } from '../../core';
import { actorOf } from '../../core/context';
import { findHostRoot, readCheckoutConfig, readPerson } from '../../core/host';
import { readMachineSetting } from '../../core/settings';
import { GrimoireError, type ErrorBody } from '../../errors';
import { cloneId as cloneIdOf, defaultDashboardPort, findGitDirs, MachineLocalStore, runningStart, START_LOCK, startStaleness, type RunningStart } from '../../machine-local';
import { enableWarnings, readRunnerConfig, runChores, runnerStatus, startRunnerTrigger } from '../../runner';
import { openTracker } from '../../tracker';
import { startUpkeep, watchNewWorktrees } from '../../upkeep';
import { VERSION } from '../../version';
import { UsageError } from '../cli/args';
import type { CliIo } from '../cli/run';
import { agentMarkersIn } from '../cli/shell';
import { terminalOn } from '../cli/wiki';
import { errorBodyOf } from '../internal';
import { openBrowser } from './browser';
import { callControl, ControlError, controlPaths, findControlPaths, removeStaleSockets, serveControl, type ControlAnswer, type ControlOp } from './control';
import { LiveEvents } from './events';
import { createDashboardServer, listenOnLoopback } from './server';
import { SignIns } from './sign-in';

/** `start` syncs this often (spec §4, Where it runs). */
export const START_SYNC_EVERY_MS = 10 * 60_000;
/** How long the git identity of dashboard calls is reused before it is read again. */
const PERSON_TTL_MS = 5_000;
/** How long a second `start` waits for a stopped instance to let go of the lock. */
const TAKEOVER_WAIT_MS = 20_000;

export interface StartVerbOptions {
  /** The running `grimoire.mjs`: the dashboard's files sit beside it, in `dashboard/`. */
  readonly bin: string;
  readonly io?: CliIo;
  readonly startDir?: string;
}

interface StartCommand {
  readonly port: number | null;
  readonly open: boolean;
  readonly from: string | null;
  readonly help: boolean;
  readonly ref: string | null;
}

function parseArgs(verb: 'start' | 'open', argv: readonly string[]): StartCommand {
  let port: number | null = null;
  let open = true;
  let from: string | null = null;
  let help = false;
  let ref: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    const value = () => {
      const given = name === arg ? argv[++i] : arg.slice(eq + 1);
      if (given === undefined || given === '') throw new UsageError(`${name} needs a value`, verb);
      return given;
    };
    if (name === '--help' && name === arg) help = true;
    else if (name === '--from') from = value();
    else if (verb === 'start' && name === '--no-open' && name === arg) open = false;
    else if (verb === 'start' && name === '--port') {
      const raw = value();
      port = /^\d{1,5}$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new UsageError('--port takes a port number, 1–65535', verb);
    } else if (verb === 'open' && !arg.startsWith('--') && ref === null) ref = arg;
    else throw new UsageError(`${verb} doesn't take ${arg}`, verb);
  }
  return { port, open, from, help, ref };
}

const HELP = {
  start: {
    verb: 'start',
    usage: 'grimoire start [--port <port>] [--no-open]',
    description:
      'Serves this clone’s dashboard on 127.0.0.1 in the foreground (Ctrl-C stops it), runs upkeep and syncs every 10 min. Opens a signed-in browser tab; prints the sign-in URL only at a terminal. When it already runs, signs a browser in to it and exits 0.',
    gate: 'refuses agent markers; needs no terminal',
    flags: { '--port': 'listen here (else the dashboard.port machine setting, else this clone’s own port)', '--no-open': 'don’t open a browser tab' },
    output: 'one JSON object: {"started": …} once it serves, {"running": …} when another start serves this clone, or {"error": …}',
  },
  open: {
    verb: 'open',
    usage: 'grimoire open [<ref>]',
    description: 'Opens a signed-in dashboard tab from the running `grimoire start`, landing on <ref> (any text with a full issue id or attempt handle) when given. Prints no secret.',
    gate: 'refuses agent markers; needs no terminal',
    output: 'one JSON object: {"opened": true, …} or {"error": …}',
  },
};

function printJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, io.stdout.isTTY ? 2 : undefined)}\n`);
}

function defaultIo(): CliIo {
  return { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, cwd: process.cwd() };
}

interface Clone {
  readonly root: string;
  readonly commonDir: string;
  readonly cloneId: string;
  readonly store: MachineLocalStore;
}

async function cloneAt(io: CliIo, command: StartCommand, startDir: string | undefined): Promise<Clone> {
  const root = await findHostRoot(command.from === null ? (startDir ?? io.cwd) : path.resolve(io.cwd, command.from));
  const dirs = await findGitDirs(root);
  if (!dirs) throw new GrimoireError('NO_REPO', `no git repository at or above ${root}`, { root });
  return { root, commonDir: dirs.commonDir, cloneId: await cloneIdOf(dirs.commonDir), store: new MachineLocalStore(dirs.commonDir, root) };
}

/** Runs a verb body with the shared gate, usage and error handling. */
async function verb(name: 'start' | 'open', argv: readonly string[], options: StartVerbOptions, body: (command: StartCommand, io: CliIo) => Promise<number>): Promise<number> {
  const io = options.io ?? defaultIo();
  io.stdout.on('error', () => {});
  try {
    const command = parseArgs(name, argv);
    if (command.help) {
      printJson(io, HELP[name]);
      return 0;
    }
    if (agentMarkersIn(io.env).length > 0) {
      throw new GrimoireError('HUMAN_ONLY', `${name} is for a person: it signs a browser in to this clone’s dashboard, so it never runs from an agent’s shell`, {});
    }
    return await body(command, io);
  } catch (error) {
    if (error instanceof UsageError) {
      printJson(io, { usage_error: { message: error.message, help: `grimoire ${name} --help` } });
      io.stderr.write(`grimoire: ${error.message} (see grimoire ${name} --help)\n`);
      return 2;
    }
    const body: ErrorBody = errorBodyOf(error, (line) => io.stderr.write(`grimoire: ${line}\n`));
    printJson(io, { error: body });
    return 1;
  } finally {
    io.stdin.pause();
  }
}

/** What the running instance answers to `sign-in`. */
interface SignedIn {
  readonly url: string;
  readonly port: number;
  readonly version: string;
  readonly pin: string | null;
  readonly pid: number;
}

/** Sends `op` to the running `start`, wherever this user's process put its control channel. */
async function ask(clone: Clone, running: RunningStart, io: CliIo, op: ControlOp, args: Record<string, unknown> = {}): Promise<unknown> {
  const paths = await findControlPaths(clone.cloneId, running.nonce, io.env);
  if (paths === null) throw new ControlError('grimoire start has no control channel this user can reach', 'unreachable');
  return callControl(paths, op, args);
}

/** Asks the running `start` for a sign-in URL, waiting a moment for one that is still opening its control channel. */
async function signInTo(clone: Clone, running: RunningStart, io: CliIo, ref: string | null): Promise<SignedIn> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const answer = (await ask(clone, running, io, 'sign-in', ref === null ? {} : { ref })) as Partial<SignedIn> | null;
      if (!answer || typeof answer.url !== 'string' || typeof answer.port !== 'number') throw new ControlError('the running grimoire start answered sign-in without a URL', 'failed');
      return {
        url: answer.url,
        port: answer.port,
        version: typeof answer.version === 'string' ? answer.version : 'unknown',
        pin: typeof answer.pin === 'string' ? answer.pin : null,
        pid: typeof answer.pid === 'number' ? answer.pid : running.pid,
      };
    } catch (error) {
      if (!(error instanceof ControlError) || error.reason !== 'unreachable' || Date.now() > deadline) {
        throw new GrimoireError('INTERNAL', `couldn't reach the running grimoire start (pid ${running.pid}) over its control channel: ${error instanceof Error ? error.message : String(error)}`, {});
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

async function showSignIn(url: string, command: { open: boolean }, io: CliIo, tty: boolean): Promise<boolean> {
  const opened = command.open ? await openBrowser(url, io.env) : false;
  if (tty) io.stderr.write(`Sign in: ${url}\n`);
  return opened;
}

/** `grimoire open [<ref>]`. */
export function runOpenVerb(argv: readonly string[], options: StartVerbOptions): Promise<number> {
  return verb('open', argv, options, async (command, io) => {
    const clone = await cloneAt(io, command, options.startDir);
    const running = await runningStart(clone.store);
    if (running === null) {
      throw new GrimoireError('NOT_FOUND', 'grimoire start isn’t running for this clone; run `grimoire start` in a terminal first', { start: null });
    }
    const signedIn = await signInTo(clone, running, io, command.ref);
    if (!(await openBrowser(signedIn.url, io.env))) {
      throw new GrimoireError('INTERNAL', 'couldn’t open a browser; run `grimoire start` in a terminal, which prints the sign-in URL', {});
    }
    printJson(io, { opened: true, port: signedIn.port, ref: command.ref });
    return 0;
  });
}

/** `grimoire start`. */
export function runStartVerb(argv: readonly string[], options: StartVerbOptions): Promise<number> {
  return verb('start', argv, options, async (command, io) => {
    const clone = await cloneAt(io, command, options.startDir);
    const tty = io.stderr.isTTY === true;
    for (let round = 0; round < 5; round++) {
      const running = await runningStart(clone.store);
      if (running !== null) {
        const outcome = await secondStart(clone, running, command, io, tty);
        if (outcome !== 'take-over') return outcome;
        continue;
      }
      const served = await serve(clone, command, io, tty, options.bin);
      if (served !== 'lost') return served;
    }
    throw new GrimoireError('BUSY', 'another grimoire start kept taking this clone’s start lock; try again', {});
  });
}

/** A second `start`: signs a browser in to the running one, or (at a terminal, when asked to) stops it to take over. */
async function secondStart(clone: Clone, running: RunningStart, command: StartCommand, io: CliIo, tty: boolean): Promise<number | 'take-over'> {
  const signedIn = await signInTo(clone, running, io, null);
  const differs = signedIn.version !== VERSION;
  if (differs) {
    io.stderr.write(`grimoire start ${signedIn.version} already serves this clone (pid ${signedIn.pid}); this worktree runs ${VERSION}.\n`);
    const terminal = terminalOn(io);
    if (tty && io.stdin.isTTY === true) {
      const answer = await terminal.ask(`Stop it and start ${VERSION} instead? [y/N] `);
      if (answer !== null && /^y(es)?$/i.test(answer.trim())) {
        await stopRunning(clone, running, io);
        return 'take-over';
      }
    }
  }
  const opened = await showSignIn(signedIn.url, command, io, tty);
  printJson(io, {
    running: { url: `http://127.0.0.1:${signedIn.port}/`, port: signedIn.port, version: signedIn.version, pid: signedIn.pid },
    signed_in: opened,
    version_differs: differs,
  });
  return 0;
}

async function stopRunning(clone: Clone, running: RunningStart, io: CliIo): Promise<void> {
  await ask(clone, running, io, 'stop');
  const deadline = Date.now() + TAKEOVER_WAIT_MS;
  while ((await clone.store.locks.inspect(START_LOCK, { staleIf: startStaleness() })).status === 'held') {
    if (Date.now() > deadline) throw new GrimoireError('BUSY', `the running grimoire start (pid ${running.pid}) didn't stop within ${TAKEOVER_WAIT_MS / 1000} s`, {});
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** The port to try first: `--port`, else the `dashboard.port` machine setting, else the clone's own. */
async function firstPort(clone: Clone, command: StartCommand): Promise<number> {
  if (command.port !== null) return command.port;
  // A machine marker this release can't read gives UPGRADE_REQUIRED here: start serves on regardless.
  const setting = await readMachineSetting(clone.commonDir, 'dashboard.port').catch(() => undefined);
  if (typeof setting === 'number' && Number.isInteger(setting) && setting > 0 && setting < 65_536) return setting;
  return defaultDashboardPort(clone.commonDir);
}

/** Serves until stopped; `lost` when another `start` took the lock first. */
async function serve(clone: Clone, command: StartCommand, io: CliIo, tty: boolean, bin: string): Promise<number | 'lost'> {
  const { root, store } = clone;
  const nonce = randomBytes(8).toString('hex');
  const startedAt = Date.now();
  const say = (line: string) => void io.stderr.write(`${line}\n`);
  let person: { value: Identity; at: number } | null = null;
  const pinNow = async () => (await readCheckoutConfig(root).catch(() => null))?.pin ?? null;
  const context = async (): Promise<CallContext> => {
    const config = await readCheckoutConfig(root).catch(() => null);
    if (person === null || Date.now() - person.at > PERSON_TTL_MS) person = { value: await readPerson(root), at: Date.now() };
    return {
      surface: 'dashboard',
      repo: { root, pin: config?.pin ?? null, installFormat: config?.installFormat ?? null },
      person: person.value,
      client: { name: 'dashboard' },
      nonce,
    };
  };

  // Long-lived: syncs in this process after the writes that trigger one.
  const core = createCore();
  const signIns = new SignIns();
  const tracker = openTracker(root);
  tracker.catch(() => {});
  const live = new LiveEvents({
    root,
    machineDir: store.dir,
    tips: async () => (await tracker).tips(),
    pin: pinNow,
  });
  let port = 0;
  const instance = async () => {
    const pin = await pinNow();
    const differs = pin !== null && pin !== VERSION;
    return {
      version: VERSION,
      pin,
      pin_differs: differs,
      notice: differs ? `this worktree now pins ${pin}; restart \`start\`` : null,
      port,
      pid: process.pid,
      root,
      started_at: new Date(startedAt).toISOString(),
    };
  };
  // The runner trigger's last evaluation (spec §20 Knowledge, the runner card: the preflight result, refusals), for GET /api/runner.
  let lastTrigger: { at: string; outcome: 'ran' | 'nothing due' | 'refused'; code?: string; message?: string; preflight?: boolean } | null = null;
  const server = createDashboardServer({
    core,
    context,
    cloneId: clone.cloneId,
    nonce,
    assetsDir: path.join(path.dirname(bin), 'dashboard'),
    signIns,
    live,
    instance,
    runner: async () => {
      const status = await runnerStatus(store, new Date());
      const kind = (status.value as { kind?: unknown }).kind;
      return {
        ...(status.value as Record<string, unknown>),
        trigger: lastTrigger,
        lines: status.lines,
        warnings: kind === 'claude' || kind === 'codex' ? enableWarnings(kind) : [],
        commands: { enable: ['grimoire runner enable claude', 'grimoire runner enable codex'], disable: 'grimoire runner disable' },
      };
    },
    log: (line) => say(`grimoire start: ${line}`),
  });
  const closeServer = () =>
    new Promise<void>((resolve) => {
      live.close();
      server.close(() => resolve());
      server.closeAllConnections();
    });
  const closeCore = async () => {
    await core.close();
    await (await tracker.catch(() => null))?.close();
  };

  try {
    port = await listenOnLoopback(server, await firstPort(clone, command));
  } catch (error) {
    await closeCore();
    throw error;
  }
  const acquired = await store.locks.acquire(START_LOCK, { data: { port, nonce }, staleIf: startStaleness() });
  if (acquired.status === 'held') {
    await closeServer();
    await closeCore();
    return 'lost';
  }
  const lock = acquired.lock;

  let requestStop: () => void = () => {};
  const stopped = new Promise<void>((resolve) => (requestStop = resolve));
  const handleControl = async (request: { op: string; args: Record<string, unknown> }): Promise<{ answer: ControlAnswer; after?: () => void }> => {
    if (request.op === 'sign-in') {
      const ref = typeof request.args.ref === 'string' && request.args.ref.trim() !== '' ? request.args.ref : null;
      return { answer: { result: { url: loginUrl(port, signIns.issueCode(), ref), port, version: VERSION, pin: await pinNow(), pid: process.pid } } };
    }
    if (request.op === 'stop') return { answer: { result: { stopping: true, pid: process.pid } }, after: () => requestStop() };
    return { answer: { error: { code: 'UNKNOWN_OP', message: `this grimoire start (${VERSION}) has no control op ${request.op}` } } };
  };

  let control: Awaited<ReturnType<typeof serveControl>>;
  try {
    control = await serveControl(controlPaths(clone.cloneId, nonce, io.env), handleControl);
  } catch (error) {
    await closeServer();
    await lock.release();
    await closeCore();
    throw error;
  }
  await removeStaleSockets(control.paths);
  const registration = await store.processes
    .register({ role: 'start', client: null, worktree: root, pin: VERSION, pathSource: null })
    .catch(() => null);

  // Upkeep at launch and on its timers (spec §13); the 10-minute sync (spec §4).
  const upkeep = startUpkeep({
    root,
    surface: 'dashboard',
    nonce,
    ...(io.env.GRIMOIRE_DEBUG ? { debug: (line: string) => say(`grimoire ${line}`) } : {}),
    onReport: (report) => report.notices.forEach(say),
  });
  // A worktree registered while start runs gets its upkeep (the generated output's reconcile) at once (spec §15).
  const worktrees = watchNewWorktrees({ commonDir: clone.commonDir, loop: upkeep });
  // The runner (spec §16 Triggers): while one is configured, due chores run at launch, on trace writes,
  // outcome changes and decisions, and every 30 min. A pin mismatch doesn't stop it.
  const runner = startRunnerTrigger({
    root,
    tips: async () => (await tracker).tips(),
    configured: async () => (await readRunnerConfig(store)) !== null,
    run: async () => {
      const at = new Date().toISOString();
      try {
        const report = await runChores({ root, core, env: io.env, due: true });
        lastTrigger = { at, outcome: report.runs.length > 0 ? 'ran' : 'nothing due', message: report.summary };
        return report;
      } catch (error) {
        const body = errorBodyOf(error, () => {});
        const fields = (body.details as { fields?: Record<string, unknown> }).fields;
        lastTrigger = { at, outcome: 'refused', code: body.code, message: body.message, preflight: fields?.preflight === 'refused' };
        throw error;
      }
    },
    log: say,
  });
  let syncing: Promise<void> | null = null;
  const syncTimer = setInterval(() => {
    if (syncing) return;
    syncing = (async () => {
      const opened = await openTracker(root);
      try {
        const ctx = await context();
        await autoSync(opened, syncRequestOf(ctx, actorOf(ctx)));
      } finally {
        await opened.close();
      }
    })()
      .catch(() => {})
      .finally(() => (syncing = null));
  }, START_SYNC_EVERY_MS);
  syncTimer.unref();

  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'];
  const onSignal = () => requestStop();
  for (const signal of signals) process.on(signal, onSignal);

  const home = `http://127.0.0.1:${port}/`;
  printJson(io, { started: { url: home, port, pid: process.pid, version: VERSION, pin: await pinNow() } });
  say(`grimoire start ${VERSION} serves this clone's dashboard at ${home} (Ctrl-C stops it)`);
  await showSignIn(loginUrl(port, signIns.issueCode(), null), command, io, tty);
  if (!tty) say('sign a browser in with `grimoire open`');

  await stopped;
  for (const signal of signals) process.off(signal, onSignal);
  say('grimoire start: stopping');
  clearInterval(syncTimer);
  worktrees.stop();
  await runner.stop();
  await closeServer();
  await control.close();
  await Promise.all([upkeep.stop(2_000), syncing]);
  await closeCore();
  await registration?.unregister().catch(() => {});
  await lock.release();
  return 0;
}

/** The sign-in URL: the code rides in the fragment, which never reaches a server log or a Referer. */
function loginUrl(port: number, code: string, ref: string | null): string {
  const next = ref === null ? '' : `&next=${encodeURIComponent(`/open?ref=${encodeURIComponent(ref)}`)}`;
  return `http://127.0.0.1:${port}/login#code=${encodeURIComponent(code)}${next}`;
}
