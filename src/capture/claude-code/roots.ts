import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isCall } from '../steps';
import { readClaudeCodeTranscript } from './reader';

// Finding a Claude Code context's transcript by id (spec §14 Roots), under
// `$CLAUDE_CONFIG_DIR` or `~/.claude`, in `projects/<slug>/`:
// - a session's main line is `<slug>/<session>.jsonl`;
// - a subagent's own transcript is `<slug>/<session>/subagents/**/agent-<agent_id>.jsonl`.
// A hook's `transcript_path` is tried first. A known session is then looked for
// in the spawn-env session's project folder, then in every project folder. With
// no session, only a tool-use id to go on, the transcript holding the call is
// searched for: the spawn-env session's files first, then every transcript
// modified at or after the call, newest first. A transcript holds a call only
// if it wrote it: a fork that holds it only in the history it copied from
// another session doesn't (spec §14 Forks).

export interface FindClaudeTranscriptOptions {
  /** `$CLAUDE_CONFIG_DIR`, or `~/.claude`. */
  readonly configDir: string;
  /** The session, when the evidence names it. */
  readonly session?: string;
  /** Main transcripts a hook revealed (`transcript_path`), tried first for the session. */
  readonly revealed?: readonly string[];
  /** The MCP server's spawn-env session: its project folder is searched first. */
  readonly spawnEnv?: string;
  /** With no session: tool-use ids the context made; the transcript holding one of them is the context's. */
  readonly callIds?: readonly string[];
  /** The earliest of those calls: a transcript last modified before it can't hold them. */
  readonly calledAt?: string;
  /** Epoch milliseconds after which the search gives up with `budget`. */
  readonly deadline?: number;
}

export type FindClaudeTranscriptResult =
  | {
      readonly status: 'found';
      /** The session's main transcript (the reader finds a subagent's own file from it). */
      readonly transcript: string;
      readonly session: string;
      /** The subagent whose own transcript held the call, when one did. */
      readonly agentId?: string;
    }
  | { readonly status: 'not_found' }
  | { readonly status: 'budget' };

/** The Claude Code config folder Claude Code itself uses: `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`. */
export function defaultClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.CLAUDE_CONFIG_DIR;
  return set !== undefined && set.trim() !== '' ? set : path.join(os.homedir(), '.claude');
}

const SESSION_FILE = /^(.+)\.jsonl$/i;
const AGENT_FILE = /^agent-(.+)\.jsonl$/i;

export async function findClaudeTranscript(options: FindClaudeTranscriptOptions): Promise<FindClaudeTranscriptResult> {
  const projects = path.join(options.configDir, 'projects');
  const overrun = () => options.deadline !== undefined && Date.now() > options.deadline;
  const slugs = await names(projects);
  const spawnSlug = options.spawnEnv === undefined ? undefined : await slugOf(projects, slugs, options.spawnEnv);
  const ordered = spawnSlug === undefined ? slugs : [spawnSlug, ...slugs.filter((slug) => slug !== spawnSlug)];

  if (options.session !== undefined) {
    const file = `${options.session}.jsonl`;
    for (const revealed of options.revealed ?? []) {
      if (path.basename(revealed).toLowerCase() === file.toLowerCase() && (await isFile(revealed))) {
        return { status: 'found', transcript: revealed, session: options.session };
      }
    }
    for (const slug of ordered) {
      if (overrun()) return { status: 'budget' };
      const candidate = path.join(projects, slug, file);
      if (await isFile(candidate)) return { status: 'found', transcript: candidate, session: options.session };
    }
    return { status: 'not_found' };
  }

  const ids = (options.callIds ?? []).filter((id) => id !== '');
  if (ids.length === 0) return { status: 'not_found' };
  const holds = async (file: { path: string; agentId?: string }, slug: string, session: string) => {
    const text = await readFile(file.path, 'utf8').catch(() => '');
    if (!ids.some((id) => text.includes(JSON.stringify(id)))) return false;
    // Only the transcript that wrote the call: a fork's copied history holds its origin's calls too.
    const read = await readClaudeCodeTranscript(path.join(projects, slug, `${session}.jsonl`), file.agentId !== undefined ? { agentId: file.agentId } : {}).catch(
      () => null,
    );
    if (read === null || !read.found) return true;
    const own = new Set(read.transcript.steps.slice(read.transcript.copiedSteps).flatMap((step) => (isCall(step) ? [step.id] : [])));
    return ids.some((id) => own.has(id));
  };
  // The spawn-env session's own files first.
  if (spawnSlug !== undefined && options.spawnEnv !== undefined) {
    for (const file of await sessionFiles(projects, spawnSlug, options.spawnEnv)) {
      if (overrun()) return { status: 'budget' };
      if (await holds(file, spawnSlug, options.spawnEnv)) return found(projects, spawnSlug, options.spawnEnv, file.agentId);
    }
  }
  const since = options.calledAt === undefined ? NaN : Date.parse(options.calledAt);
  const candidates: { path: string; slug: string; session: string; agentId?: string; mtime: number }[] = [];
  for (const slug of slugs) {
    if (overrun()) return { status: 'budget' };
    for (const name of await names(path.join(projects, slug))) {
      const session = SESSION_FILE.exec(name)?.[1];
      if (session === undefined) continue;
      for (const file of await sessionFiles(projects, slug, session)) {
        const mtime = await stat(file.path).then((info) => info.mtimeMs, () => NaN);
        // Written to at or after the call (a second's slack: commit times are whole seconds).
        if (Number.isFinite(since) && !(mtime >= since - 1_000)) continue;
        candidates.push({ ...file, slug, session, mtime });
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  for (const candidate of candidates) {
    if (overrun()) return { status: 'budget' };
    if (await holds(candidate, candidate.slug, candidate.session)) return found(projects, candidate.slug, candidate.session, candidate.agentId);
  }
  return { status: 'not_found' };
}

function found(projects: string, slug: string, session: string, agentId: string | undefined): FindClaudeTranscriptResult {
  return {
    status: 'found',
    transcript: path.join(projects, slug, `${session}.jsonl`),
    session,
    ...(agentId !== undefined ? { agentId } : {}),
  };
}

/** A session's main transcript and its subagents' own, when they exist. */
async function sessionFiles(projects: string, slug: string, session: string): Promise<{ path: string; agentId?: string }[]> {
  const files: { path: string; agentId?: string }[] = [];
  const main = path.join(projects, slug, `${session}.jsonl`);
  if (await isFile(main)) files.push({ path: main });
  const subagents = path.join(projects, slug, session, 'subagents');
  let entries: string[] = [];
  try {
    entries = await readdir(subagents, { recursive: true });
  } catch {
    // No subagents.
  }
  for (const entry of entries) {
    const agentId = AGENT_FILE.exec(path.basename(entry))?.[1];
    if (agentId !== undefined) files.push({ path: path.join(subagents, entry), agentId });
  }
  return files;
}

/** The project folder holding `session`'s main transcript. */
async function slugOf(projects: string, slugs: readonly string[], session: string): Promise<string | undefined> {
  for (const slug of slugs) if (await isFile(path.join(projects, slug, `${session}.jsonl`))) return slug;
  return undefined;
}

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
