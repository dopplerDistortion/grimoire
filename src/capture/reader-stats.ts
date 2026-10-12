// `doctor --readers` (spec §12): how grimoire's transcript readers fare on
// this machine's transcripts of this repo, as structure statistics only:
// files, lines read, unknown and malformed, steps by kind, client versions.
// Never a path, a prompt, a tool name or any text. Opt-in, and skipped in
// `none` mode (the caller's check); only transcripts whose cwd is inside one
// of the repo's worktrees are read (their first lines say where they ran).
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import zlib from 'node:zlib';
import { CLAUDE_CODE_READER_VERSION, readClaudeCodeTranscript } from './claude-code';
import { CODEX_READER_VERSION, readCodexTranscript } from './codex';
import type { Step, Transcript } from './steps';

/** What one client's reader made of this repo's transcripts. */
export interface ReaderStats {
  readonly client: 'claude-code' | 'codex';
  readonly reader_version: number;
  /** Transcripts read (a Claude Code subagent's own file counts as one). */
  readonly transcripts: number;
  /** Transcripts of this repo the reader couldn't read at all; a compressed Codex one this Node can't open counts wherever it ran (its cwd can't be told). */
  readonly unreadable: number;
  readonly lines: { read: number; unknown: number; malformed: number };
  readonly steps: Record<Step['kind'], number>;
  /** The client versions the transcripts name, sorted. */
  readonly client_versions: string[];
  /** True when the newest `limit` transcripts were read and older ones left. */
  readonly capped: boolean;
}

export interface ReaderStatsOptions {
  /** The repo's worktrees: a transcript counts when its cwd is inside one. */
  readonly worktrees: readonly string[];
  /** Claude Code config folders (`$CLAUDE_CONFIG_DIR` or `~/.claude`, and those hooks revealed). */
  readonly claudeConfigDirs: readonly string[];
  /** Codex homes (`$CODEX_HOME` or `~/.codex`, and those hooks revealed). */
  readonly codexHomes: readonly string[];
  /** At most this many transcripts per client, newest first (default 200). */
  readonly limit?: number;
}

const DEFAULT_LIMIT = 200;
/** How many leading lines are searched for a Claude Code transcript's `cwd`. */
const CWD_LINES = 50;

/** The structure statistics of this repo's transcripts, per client. */
export async function readerStats(options: ReaderStatsOptions): Promise<ReaderStats[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const inside = insideAny(options.worktrees);
  return [await claudeStats(options, inside, limit), await codexStats(options, inside, limit)];
}

function emptyStats(client: ReaderStats['client'], readerVersion: number): ReaderStats {
  return {
    client,
    reader_version: readerVersion,
    transcripts: 0,
    unreadable: 0,
    lines: { read: 0, unknown: 0, malformed: 0 },
    steps: { prompt: 0, assistant: 0, tool_call: 0, tool_result: 0, compaction: 0, subagent_launch: 0, subagent_result: 0 },
    client_versions: [],
    capped: false,
  };
}

/** Folds one read transcript into `stats`. */
function count(stats: ReaderStats, transcript: Transcript, versions: Set<string>): ReaderStats {
  const steps = { ...stats.steps };
  for (const step of transcript.steps) steps[step.kind]++;
  if (transcript.client.version) versions.add(transcript.client.version);
  return {
    ...stats,
    transcripts: stats.transcripts + 1,
    lines: {
      read: stats.lines.read + transcript.lines.read,
      unknown: stats.lines.unknown + transcript.lines.unknown,
      malformed: stats.lines.malformed + transcript.lines.malformed,
    },
    steps,
  };
}

/** Whether a cwd is inside one of `worktrees` (case-insensitively on Windows). */
function insideAny(worktrees: readonly string[]): (cwd: string) => boolean {
  const fold = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const roots = worktrees.map(fold);
  return (cwd) => {
    const at = fold(cwd);
    return roots.some((root) => {
      const relative = path.relative(root, at);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
  };
}

/** Claude Code names a project folder by its cwd with every character but letters and digits made `-`. */
const slugOf = (dir: string) => path.resolve(dir).replace(/[^a-zA-Z0-9]/g, '-');

async function claudeStats(options: ReaderStatsOptions, inside: (cwd: string) => boolean, limit: number): Promise<ReaderStats> {
  const slugs = options.worktrees.map(slugOf).map((slug) => slug.toLowerCase());
  const candidates: { file: string; mtime: number }[] = [];
  for (const configDir of new Set(options.claudeConfigDirs.map((dir) => path.resolve(dir)))) {
    const projects = path.join(configDir, 'projects');
    for (const folder of await names(projects)) {
      // A cwd inside a worktree has a slug starting with the worktree's; the cwd itself settles it.
      if (!slugs.some((slug) => folder.toLowerCase().startsWith(slug))) continue;
      for (const name of await names(path.join(projects, folder))) {
        if (!/\.jsonl$/i.test(name)) continue;
        const file = path.join(projects, folder, name);
        const stats = await stat(file).catch(() => null);
        if (stats?.isFile()) candidates.push({ file, mtime: stats.mtimeMs });
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  let stats = emptyStats('claude-code', CLAUDE_CODE_READER_VERSION);
  const versions = new Set<string>();
  for (const { file } of candidates) {
    const cwd = await claudeCwd(file);
    if (cwd === null || !inside(cwd)) continue;
    if (stats.transcripts >= limit) {
      stats = { ...stats, capped: true };
      break;
    }
    const contexts = [undefined, ...(await subagentsOf(file))];
    for (const agentId of contexts) {
      const read = await readClaudeCodeTranscript(file, agentId === undefined ? {} : { agentId }).catch(() => null);
      if (read?.found) stats = count(stats, read.transcript, versions);
      else stats = { ...stats, unreadable: stats.unreadable + 1 };
    }
  }
  return { ...stats, client_versions: [...versions].sort() };
}

/** The ids of a Claude Code session's subagents, from their own files' names. */
async function subagentsOf(main: string): Promise<string[]> {
  const dir = path.join(path.dirname(main), path.basename(main).replace(/\.jsonl$/i, ''), 'subagents');
  const ids: string[] = [];
  for (const name of await names(dir)) {
    const match = /^agent-(.+)\.jsonl$/i.exec(name);
    if (match) ids.push(match[1]!);
  }
  return ids.sort();
}

/** The cwd a Claude Code transcript's first lines carry; null when none does. */
async function claudeCwd(file: string): Promise<string | null> {
  let found: string | null = null;
  await leadingLines(createReadStream(file, { encoding: 'utf8' }), CWD_LINES, (line) => {
    const cwd = jsonField(line, 'cwd');
    if (cwd !== null) found = cwd;
    return cwd !== null;
  });
  return found;
}

async function codexStats(options: ReaderStatsOptions, inside: (cwd: string) => boolean, limit: number): Promise<ReaderStats> {
  const candidates: { file: string; mtime: number }[] = [];
  for (const home of new Set(options.codexHomes.map((dir) => path.resolve(dir)))) {
    for (const file of [...(await walk(path.join(home, 'sessions'), 3)), ...(await walk(path.join(home, 'archived_sessions'), 0))]) {
      if (!/^rollout-.*\.jsonl(?:\.zst)?$/i.test(path.basename(file))) continue;
      const stats = await stat(file).catch(() => null);
      if (stats?.isFile()) candidates.push({ file, mtime: stats.mtimeMs });
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  let stats = emptyStats('codex', CODEX_READER_VERSION);
  const versions = new Set<string>();
  for (const { file } of candidates) {
    const cwd = await codexCwd(file);
    if (cwd === 'unreadable') {
      stats = { ...stats, unreadable: stats.unreadable + 1 };
      continue;
    }
    if (cwd === null || !inside(cwd)) continue;
    if (stats.transcripts >= limit) {
      stats = { ...stats, capped: true };
      break;
    }
    const read = await readCodexTranscript(file).catch(() => null);
    if (read?.found) stats = count(stats, read.transcript, versions);
    else stats = { ...stats, unreadable: stats.unreadable + 1 };
  }
  return { ...stats, client_versions: [...versions].sort() };
}

/**
 * The cwd of a Codex rollout's `session_meta` (its first line); `unreadable`
 * for a compressed one this Node can't open (whose cwd can't be told).
 */
async function codexCwd(file: string): Promise<string | null | 'unreadable'> {
  const compressed = /\.zst$/i.test(file);
  if (compressed && typeof zlib.createZstdDecompress !== 'function') return 'unreadable';
  let found: string | null = null;
  try {
    const raw = createReadStream(file);
    const stream = compressed ? raw.pipe(zlib.createZstdDecompress()) : raw;
    stream.setEncoding('utf8');
    await leadingLines(stream, 1, (line) => {
      try {
        const parsed = JSON.parse(line) as { type?: unknown; payload?: { cwd?: unknown } };
        if (parsed.type === 'session_meta' && typeof parsed.payload?.cwd === 'string') found = parsed.payload.cwd;
      } catch {
        // Not a session_meta line: no cwd.
      }
      return true;
    });
  } catch {
    return compressed ? 'unreadable' : null;
  }
  return found;
}

/** Feeds up to `max` leading lines of `stream` to `take`, stopping once it returns true. */
async function leadingLines(stream: NodeJS.ReadableStream & { destroy(): void }, max: number, take: (line: string) => boolean): Promise<void> {
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let seen = 0;
  try {
    for await (const line of lines) {
      if (take(line) || ++seen >= max) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** A top-level string field of a JSON line; null when it has none. */
function jsonField(line: string, key: string): string | null {
  try {
    const value = (JSON.parse(line) as Record<string, unknown> | null)?.[key];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

async function names(dir: string): Promise<string[]> {
  return readdir(dir).catch(() => [] as string[]);
}

/** Every file under `dir`, down `depth` folder levels (Codex's `YYYY/MM/DD`). */
async function walk(dir: string, depth: number): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) files.push(...(await walk(full, depth - 1)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}
