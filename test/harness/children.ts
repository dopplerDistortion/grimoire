// The process-leak guard. Every process a test file starts in its own process
// (test code, the harness, or the code under test: `spawn`, `execFile`,
// `exec`, `fork`, and so whatever is built on them, such as the MCP SDK's
// stdio transport) is registered here, as are the pid files of stand-ins
// whose processes are no one's child. A test that leaves one running fails:
// its process tree is killed, and the test says what was left. Processes
// started outside a test (beforeAll) are held to the same rule at the end of
// the file. `installLeakGuard` (the Vitest setup file) wires it in.
import { spawnSync, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, aroundEach } from 'vitest';
import { isPidAlive, processStartTimes } from '../../src/machine-local/process-info';

interface Started {
  readonly child: ChildProcess;
  readonly command: string;
}

/** How long a process told to stop (stdin closed, `close()` called) gets to exit before it counts as left running. */
const EXIT_GRACE_MS = 5_000;

/** Processes started and pid files named since the current test (or, outside tests, the file) began. */
let started: Started[] = [];
/** Every process started and not yet seen to exit, whatever its scope. */
const live = new Set<ChildProcess>();
/** The pid files named in the current scope, with what each last held: a test's fixtures may remove them before it is settled. */
let pidFiles = new Map<string, string>();

function describeCommand(file: unknown, args: unknown): string {
  return [String(file), ...(Array.isArray(args) ? args.map(String) : [])].join(' ').slice(0, 200);
}

/**
 * esbuild's API keeps one `esbuild --service` process for the life of the
 * process that built: it is the build tool's, not the test's.
 */
function exempt(command: string): boolean {
  return /esbuild(\.exe)?\b.*--service/.test(command);
}

function register(child: ChildProcess, command: string): ChildProcess {
  if (exempt(command)) return child;
  started.push({ child, command });
  live.add(child);
  child.once('exit', () => live.delete(child));
  return child;
}

/** Registers `file` (lines of `<pid> <epoch ms it was known to run>`): its processes must be gone when the test ends. */
export function trackPidFile(file: string): void {
  pidFiles.set(file, '');
}

/** Reads each pid file again, keeping what it last held once it is gone. */
function readPidFiles(files: Map<string, string>): void {
  for (const file of files.keys()) {
    try {
      files.set(file, readFileSync(file, 'utf8'));
    } catch {
      // Removed (with its test's temp dir): what it last held stands.
    }
  }
}

const running = (child: ChildProcess) => child.pid !== undefined && child.exitCode === null && child.signalCode === null;

/** How long a synchronous taskkill may take before the guard falls back to process.kill. */
const KILL_TIMEOUT_MS = 30_000;

/** Kills `pid` and every process it started (by parent pid), as a hung test's would be. */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    // Bounded: a taskkill that stalls on a busy machine must not block the
    // worker past every vitest timeout (it runs synchronously in the guard).
    const run = spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: KILL_TIMEOUT_MS,
    });
    if (run.error !== undefined || run.signal !== null) {
      console.warn(`leak guard: taskkill of ${pid} did not finish in ${KILL_TIMEOUT_MS} ms; killing it directly`);
      try {
        process.kill(pid);
      } catch {
        // Gone already.
      }
    }
    return;
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGKILL');
    } catch {
      // Not a group leader, or gone.
    }
  }
}

/** Those of the pid files' processes that still run: a pid counts only while its process started no later than recorded. */
async function stillRunningIn(files: Map<string, string>): Promise<{ pid: number; file: string }[]> {
  readPidFiles(files);
  const listed = [...files].flatMap(([file, text]) => {
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [pid = NaN, at = NaN] = line.split(' ').map(Number);
        return { pid, at, file };
      })
      .filter(({ pid }) => isPidAlive(pid));
  });
  if (listed.length === 0) return [];
  const startTimes = await processStartTimes(listed.map(({ pid }) => pid));
  return listed.filter(({ pid, at }) => {
    const startedAt = startTimes.get(pid);
    return startedAt === undefined ? isPidAlive(pid) : !(startedAt > at);
  });
}

/**
 * Settles what `scope` (a test, or the file) started: waits a grace time for
 * its processes to exit, then kills those still running, with their trees,
 * and throws naming them.
 */
async function settle(scope: string, children: readonly Started[], files: Map<string, string>): Promise<void> {
  const until = Date.now() + EXIT_GRACE_MS;
  let left = children.filter(({ child }) => running(child));
  let orphans = await stillRunningIn(files);
  while ((left.length > 0 || orphans.length > 0) && Date.now() < until) {
    await sleep(100);
    left = left.filter(({ child }) => running(child));
    if (orphans.length > 0) orphans = await stillRunningIn(files);
  }
  if (left.length === 0 && orphans.length === 0) return;
  for (const { child } of left) killTree(child.pid!);
  for (const { pid } of orphans) killTree(pid);
  const lines = [...left.map(({ child, command }) => `pid ${child.pid}: ${command}`), ...orphans.map(({ pid, file }) => `pid ${pid} (from ${file})`)];
  throw new Error(`${scope} left ${lines.length} process(es) running (now killed with their trees):\n  ${lines.join('\n  ')}`);
}

let installed = false;

/**
 * Wraps node:child_process's process starters (the module object every
 * importer shares) so each process started is registered, and holds every
 * test, then the file, to leaving none running.
 */
export function installLeakGuard(): void {
  if (installed) return;
  installed = true;
  const childProcess = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process');
  for (const name of ['spawn', 'execFile', 'exec', 'fork'] as const) {
    const original = childProcess[name] as (...args: unknown[]) => ChildProcess;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const child = original.apply(this, args);
      const command = name === 'exec' ? String(args[0]) : name === 'fork' ? describeCommand(process.execPath, [args[0], ...(Array.isArray(args[1]) ? args[1] : [])]) : describeCommand(args[0], args[1]);
      return register(child, command);
    };
    Object.defineProperty(wrapped, 'name', { value: name });
    // Keeps what hangs off the original, such as execFile's util.promisify.custom (not enumerable).
    for (const key of Reflect.ownKeys(original)) {
      if (key !== 'name' && key !== 'length' && key !== 'prototype') Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(original, key)!);
    }
    (childProcess as unknown as Record<string, unknown>)[name] = wrapped;
  }
  // Named imports of node:child_process (ESM) see the wrapped functions too.
  syncBuiltinESMExports();

  // A worker torn down mid-test still takes its processes with it.
  process.once('exit', () => {
    for (const child of live) if (running(child)) killTree(child.pid!);
  });

  aroundEach(async (runTest, { task }) => {
    const outer = { started, pidFiles };
    started = [];
    pidFiles = new Map();
    try {
      await runTest();
    } finally {
      const mine = { started, pidFiles };
      started = outer.started;
      pidFiles = outer.pidFiles;
      await settle(`the test "${task.name}"`, mine.started, mine.pidFiles);
    }
  });
  // Before the test's fixtures are cleaned up (with the temp dirs its pid files may be in).
  afterEach(() => readPidFiles(pidFiles));
  afterAll(async () => {
    await settle('this file, outside its tests,', started, pidFiles);
  });
}
