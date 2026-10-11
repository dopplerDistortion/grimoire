import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Finding a Codex thread's transcript by its id (spec §14 Roots), under
// `$CODEX_HOME` or `~/.codex` (spike E):
// - a live transcript is `sessions/YYYY/MM/DD/rollout-<local time>-<thread>.jsonl`,
//   in the folder of the day the thread was created, in local time;
// - archiving moves the file, same name, into the flat `archived_sessions/`;
// - a cold transcript becomes `….jsonl.zst` (Codex reads the plain file when both
//   exist), and a reverted thread `…-<thread>_<rollout id>.jsonl`.
// Thread ids are UUIDv7, so the creation day is read from the id and searched
// first (with the days either side, for the local time zone); then the archive;
// then every other day folder up to the call's day, newest first.
// This supersedes the spec's "date folders from the call date onward": spike E
// found the folder is the thread's creation day, which is at or before the call's.

export interface FindCodexTranscriptOptions {
  /** `$CODEX_HOME`, or `~/.codex`. */
  readonly codexHome: string;
  /** The thread (`_meta.threadId`). */
  readonly context: string;
  /** A time the thread is known to have existed at (its latest binding call): no later day folder can hold it. */
  readonly existedAt?: string;
  /** Epoch milliseconds after which the search gives up with `budget`. */
  readonly deadline?: number;
}

export type FindCodexTranscriptResult =
  | { readonly status: 'found'; readonly file: string }
  | { readonly status: 'not_found' }
  | { readonly status: 'budget' };

const DAY_MS = 86_400_000;

/** The Codex home Codex itself uses: `$CODEX_HOME` when set, else `~/.codex`. */
export function defaultCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.CODEX_HOME;
  return set !== undefined && set.trim() !== '' ? set : path.join(os.homedir(), '.codex');
}

export async function findCodexTranscript(options: FindCodexTranscriptOptions): Promise<FindCodexTranscriptResult> {
  const sessions = path.join(options.codexHome, 'sessions');
  const isThreadTranscript = transcriptMatcher(options.context);
  const overrun = () => options.deadline !== undefined && Date.now() > options.deadline;
  const searched = new Set<string>();

  const lookIn = async (dir: string): Promise<string | null | 'budget'> => {
    if (overrun()) return 'budget';
    searched.add(dir);
    return pick(dir, (await names(dir)).filter(isThreadTranscript));
  };

  const created = uuidV7Time(options.context);
  const nearCreation = (created === null ? [] : [created, created - DAY_MS, created + DAY_MS]).map((at) =>
    path.join(sessions, ...localDay(at)),
  );
  for (const dir of [...nearCreation, path.join(options.codexHome, 'archived_sessions')]) {
    const hit = await lookIn(dir);
    if (hit === 'budget') return { status: 'budget' };
    if (hit !== null) return { status: 'found', file: hit };
  }

  const existed = options.existedAt === undefined ? NaN : Date.parse(options.existedAt);
  const lastDay = Number.isFinite(existed) ? localDay(existed + DAY_MS).join('/') : null;
  for (const year of await numbered(sessions)) {
    for (const month of await numbered(path.join(sessions, year))) {
      for (const day of await numbered(path.join(sessions, year, month))) {
        if (lastDay !== null && `${year}/${month}/${day}` > lastDay) continue;
        const dir = path.join(sessions, year, month, day);
        if (searched.has(dir)) continue;
        const hit = await lookIn(dir);
        if (hit === 'budget') return { status: 'budget' };
        if (hit !== null) return { status: 'found', file: hit };
      }
    }
  }
  return { status: 'not_found' };
}

/** Matches the thread's transcript file names: `rollout-…-<thread>[_<rollout id>].jsonl[.zst]`. */
function transcriptMatcher(context: string): (name: string) => boolean {
  const id = context.toLowerCase().replace(/[^0-9a-z-]/g, '');
  const pattern = new RegExp(`^rollout-.*-${id}(?:_[^.\\\\/]+)?\\.jsonl(?:\\.zst)?$`);
  return (name) => id !== '' && pattern.test(name.toLowerCase());
}

/** The file to read among a thread's transcripts in one folder: plain before `.zst`, then the latest written. */
async function pick(dir: string, matches: string[]): Promise<string | null> {
  if (matches.length === 0) return null;
  const ranked = await Promise.all(
    matches.map(async (name) => {
      const file = path.join(dir, name);
      const mtime = await stat(file).then((info) => info.mtimeMs, () => 0);
      return { file, zst: /\.zst$/i.test(name), mtime };
    }),
  );
  ranked.sort((a, b) => Number(a.zst) - Number(b.zst) || b.mtime - a.mtime);
  return ranked[0]!.file;
}

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** A folder's all-digit entries, newest (largest) first. */
async function numbered(dir: string): Promise<string[]> {
  return (await names(dir)).filter((name) => /^\d+$/.test(name)).sort().reverse();
}

/** The local `YYYY`, `MM` and `DD` of a time, as Codex names its day folders. */
function localDay(at: number): [string, string, string] {
  const date = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return [String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate())];
}

/** The creation time a UUIDv7 holds in its first 48 bits, or `null` for any other id. */
function uuidV7Time(id: string): number | null {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.exec(id);
  return match ? parseInt(match[1]! + match[2]!, 16) : null;
}
