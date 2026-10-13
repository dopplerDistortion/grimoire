import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// Is a process still the one a record names? A pid is reused after its process
// exits, so a live pid counts only if its start time matches the recorded one.

/**
 * How far a recorded start time may be from the one the OS reports and still
 * name the same process. It covers the gap between the OS creating the process
 * and Node's time origin, and the OS's own rounding (whole seconds on macOS).
 */
export const START_TIME_TOLERANCE_MS = 5_000;

/** This process's start time, epoch milliseconds. */
export function currentProcessStartTime(): number {
  return Math.round(performance.timeOrigin);
}

export function currentHost(): string {
  return os.hostname();
}

/** False only when no process with this pid exists on this host. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The OS's start time for each pid, epoch milliseconds. A pid that is gone, or
 * whose start time the OS won't tell, is missing from the map.
 */
export async function processStartTimes(pids: readonly number[]): Promise<Map<number, number>> {
  const wanted = [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  if (wanted.length === 0) return new Map();
  try {
    if (process.platform === 'linux') return await linuxStartTimes(wanted);
    if (process.platform === 'win32') return await windowsStartTimes(wanted);
    return await psStartTimes(wanted);
  } catch {
    return new Map();
  }
}

/** Live and the same process: pid alive here, and its start time matches when the OS tells it. */
export async function liveProcesses(
  candidates: readonly { pid: number; start_time: number }[],
): Promise<boolean[]> {
  const alive = candidates.map((c) => isPidAlive(c.pid));
  const startTimes = await processStartTimes(candidates.filter((_, i) => alive[i]).map((c) => c.pid));
  return candidates.map((c, i) => {
    if (!alive[i]) return false;
    const actual = startTimes.get(c.pid);
    if (actual === undefined) return true; // can't tell: never call a live pid dead
    return Math.abs(actual - c.start_time) <= START_TIME_TOLERANCE_MS;
  });
}

function run(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', windowsHide: true, timeout: 15_000, env: env ?? process.env },
      // A non-zero exit still carries the lines for the pids that exist.
      (error, stdout) => (stdout ? resolve(stdout) : error ? reject(error) : resolve('')),
    );
  });
}

async function linuxStartTimes(pids: number[]): Promise<Map<number, number>> {
  // /proc/<pid>/stat field 22 is the start time in clock ticks after boot
  // (USER_HZ, 100 on every mainstream kernel); /proc/stat's btime is the boot time.
  const stat = await readFile('/proc/stat', 'utf8');
  const btime = Number(/^btime (\d+)$/m.exec(stat)?.[1]);
  if (!Number.isFinite(btime)) return new Map();
  const result = new Map<number, number>();
  for (const pid of pids) {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
    if (text === null) continue;
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[19]); // field 22 counted from 1, after pid and comm
    if (Number.isFinite(ticks)) result.set(pid, Math.round(btime * 1000 + ticks * 10));
  }
  return result;
}

async function windowsStartTimes(pids: number[]): Promise<Map<number, number>> {
  const powershell = path.join(
    process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const command =
    `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ` +
    `ForEach-Object { try { '{0} {1}' -f $_.Id, ([DateTimeOffset]$_.StartTime).ToUnixTimeMilliseconds() } catch {} }`;
  const stdout = await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', command]);
  return parsePairs(stdout, (value) => Number(value));
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

async function psStartTimes(pids: number[]): Promise<Map<number, number>> {
  // `lstart` is the local time the process started, e.g. "Sat Oct 11 06:14:03 2026".
  const stdout = await run('ps', ['-o', 'pid=,lstart=', '-p', pids.join(',')], {
    ...process.env,
    LC_ALL: 'C',
  });
  return parsePairs(stdout, (value) => {
    const [, month, day, time, year] = value.trim().split(/\s+/);
    const [h, m, s] = (time ?? '').split(':').map(Number);
    const monthIndex = MONTHS.indexOf((month ?? '').toLowerCase());
    if (monthIndex < 0) return NaN;
    return new Date(Number(year), monthIndex, Number(day), h, m, s).getTime();
  });
}

function parsePairs(stdout: string, parse: (value: string) => number): Map<number, number> {
  const result = new Map<number, number>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const value = parse(match[2]!);
    if (Number.isFinite(value)) result.set(Number(match[1]), value);
  }
  return result;
}
