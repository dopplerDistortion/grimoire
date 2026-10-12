// Commit facts (spec §14 Facts: Commits): which commits an attempt actually
// produced, never a person's commits from other worktrees.
//
// - `via: observed`, in a bound context's session record: git's
//   `[<branch> <hash>] <subject>` creation line in the result of a shell call
//   running `git commit` (`--amend` included), `cherry-pick` or `revert`, in
//   the context's window or a subagent launched in it; or a creating
//   HEAD-reflog entry in the session's worktree timed inside one of the
//   context's tool calls (a merge commit git made on its own, by `merge` or
//   `pull`, included; a fast-forward or a rebase creates none). Hashes printed by `log`, `show`, `pull`, `branch` or
//   `worktree` never count: only a creating command's result is read.
// - `via: referenced`, in `end.md`: a commit on any branch of the clone whose
//   `Refs:` trailer names the issue, with a commit time inside the attempt.
//
// Each commit is snapshotted (subject, files touched, lines added and
// removed; no diffs). A hash this clone lacks is recorded bare. An agent
// context's observed commit touching `.grimoire/skills/**` is flagged
// `agent_skill_edit` (a merge only when a merged file matches neither
// parent); so is a referenced commit with a known agent co-author trailer
// that touches them, and in a human attempt such a commit is `agent_assisted`.
import { runGit, type StallLimit } from '../git/run';
import { CHORES_AGENT } from './cut';
import type { Step, Transcript } from './steps';

export type CommitVia = 'observed' | 'referenced';

/** One commit as a session record's `commits` slice, or `end.md`'s, holds it. */
export interface CommitFact {
  /** The full hash; as printed, when this clone lacks the commit (then nothing else is known of it). */
  readonly hash: string;
  readonly via: CommitVia;
  /** Observed: the context whose tool result or tool call showed it being made. */
  readonly session?: string | null;
  readonly context?: string | null;
  /** The commit time (ISO 8601, whole seconds). */
  readonly at?: string;
  readonly subject?: string;
  /** Files touched, against the first parent (every file for a root commit). */
  readonly files?: readonly string[];
  readonly added?: number;
  readonly removed?: number;
  /** An agent's edit of the generated skill copies, which nobody commits. */
  readonly agent_skill_edit?: true;
  /** A referenced commit an agent co-authored, in an attempt whose worker kind is human. */
  readonly agent_assisted?: true;
}

/** A commit a context's tool result shows git creating: the hash as printed, when the call was made, and by whom. */
export interface SeenCommit {
  readonly hash: string;
  readonly at: string;
  readonly session: string | null;
  readonly context: string | null;
}

/** Tools that run a shell command: Claude Code's, and Codex's in both history modes. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'PowerShell', 'exec_command', 'shell', 'local_shell', 'shell_command', 'unified_exec']);

/** A shell command running a git verb that creates a commit and prints its creation line. */
const CREATING_GIT = /(?<![\w.-])git(?:\.exe)?(?:\s+(?:-[cC]\s+\S+|--?[\w-]+(?:=\S+)?))*[\s",]+(?:commit|cherry-pick|revert)(?![\w-])/;

/** git's creation line: `[main 1a2b3c4] subject`, `[main (root-commit) 1a2b3c4] …`, `[detached HEAD 1a2b3c4] …`. */
const CREATION_LINE = /^\[(?:[^\]\n]*?\s)?(?:\(root-commit\)\s)?([0-9a-f]{7,64})\]\s/gm;

/**
 * The commits a context's steps (its window, before any cut, or a launched
 * subagent's transcript) show git creating: creation lines in the result of
 * a shell call running a creating git verb. `transcript` names the session
 * and context they are credited to.
 */
export function transcriptCommitLines(transcript: Pick<Transcript, 'session' | 'context'>, steps: readonly Step[]): SeenCommit[] {
  const who = { session: transcript.session === '' ? null : transcript.session, context: transcript.context === '' ? null : transcript.context };
  const creating = new Map<string, string>();
  for (const step of steps) {
    if (step.kind !== 'tool_call' || !SHELL_TOOLS.has(step.name)) continue;
    const command = typeof step.input === 'string' ? step.input : JSON.stringify(step.input ?? null);
    if (CREATING_GIT.test(command)) creating.set(step.id, step.at);
  }
  const seen: SeenCommit[] = [];
  const hashes = new Set<string>();
  for (const step of steps) {
    if (step.kind !== 'tool_result') continue;
    const at = creating.get(step.id);
    if (at === undefined) continue;
    for (const match of step.text.matchAll(CREATION_LINE)) {
      const hash = match[1]!;
      if (hashes.has(hash)) continue;
      hashes.add(hash);
      seen.push({ hash, at, ...who });
    }
  }
  return seen;
}

/** When one of a context's tool calls ran: from the call to its result (epoch ms). */
export interface CallSpan {
  readonly start: number;
  readonly end: number;
  /** A subagent launch's span: the subagent's whole run, not a call of the context's own. */
  readonly launch?: true;
}

/** The answered calls among `steps`, other than `grimoire-chores` launches: each launch with the subagent it ran, when known. */
function answeredCalls(steps: readonly Step[]): { span: CallSpan; agentId: string | null }[] {
  const calls = new Map<string, number>();
  for (const step of steps) {
    if (step.kind === 'tool_call' || (step.kind === 'subagent_launch' && step.agentType !== CHORES_AGENT)) {
      if (!calls.has(step.id)) calls.set(step.id, Date.parse(step.at));
    }
  }
  const answered: { span: CallSpan; agentId: string | null }[] = [];
  for (const step of steps) {
    if (step.kind !== 'tool_result' && step.kind !== 'subagent_result') continue;
    const start = calls.get(step.id);
    if (start === undefined) continue;
    calls.delete(step.id);
    const end = Date.parse(step.at);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    answered.push(step.kind === 'subagent_result' ? { span: { start, end, launch: true }, agentId: step.agentId } : { span: { start, end }, agentId: null });
  }
  return answered;
}

/**
 * The spans of a context's answered tool calls: a shell call from its call to
 * its result, a subagent launch over the whole subagent run. A
 * `grimoire-chores` subagent's launch is no span of the context's work, nor is
 * a `bound` subagent's: that one's commits are its own record's.
 */
export function callSpans(steps: readonly Step[], bound: ReadonlySet<string> = new Set()): CallSpan[] {
  return answeredCalls(steps).flatMap(({ span, agentId }) => (agentId !== null && bound.has(agentId) ? [] : [span]));
}

/** The runs of the `bound` subagents `steps` launched: a launcher's record credits no commit made inside one. */
export function boundRuns(steps: readonly Step[], bound: ReadonlySet<string>): CallSpan[] {
  return answeredCalls(steps).flatMap(({ span, agentId }) => (agentId !== null && bound.has(agentId) ? [span] : []));
}

/** A HEAD-reflog entry that created a commit: its new hash and when (epoch ms, whole seconds). */
export interface ReflogCreation {
  readonly hash: string;
  readonly at: number;
}

/** Reflog subjects of the committing verbs: `commit:`, `commit (initial|amend|merge):`, `cherry-pick:`, `revert:`. */
const CREATING_REFLOG = /^(?:commit(?: \((?:initial|amend|merge)\))?|cherry-pick|revert):/;
/**
 * Reflog subjects of a merge git may finish on its own: `merge <what>: …`, and
 * `pull[ <args>]: …` merging what it fetched. Only one whose entry is a merge
 * commit created one: a fast-forward moves HEAD to a commit made before. A
 * rebase (`rebase (pick): …`, `pull --rebase (pick): …`) creates none either:
 * it replays commits already made, by whoever made them.
 */
const MERGING_REFLOG = /^(?:merge|pull)(?: [^:(]*)?:/;
const REFLOG_ENTRIES = 5_000;

/** The creating entries of `worktree`'s own HEAD reflog, newest first; empty when it can't be read. */
export async function reflogCreations(worktree: string, options: { stallMs?: StallLimit } = {}): Promise<ReflogCreation[]> {
  const run = await runGit(worktree, ['log', '-g', `-n${REFLOG_ENTRIES}`, '--date=unix', '--format=%H%x1f%P%x1f%gd%x1f%gs', 'HEAD', '--'], options);
  if (run.code !== 0) return [];
  const entries: ReflogCreation[] = [];
  for (const line of run.stdout.toString('utf8').split('\n')) {
    const [hash, parents, selector, subject] = line.split('\x1f');
    if (!hash || parents === undefined || selector === undefined || subject === undefined) continue;
    // A fast-forward can land on a merge someone else made: its subject tells it apart.
    const merged = MERGING_REFLOG.test(subject) && !subject.endsWith(': Fast-forward') && parents.split(' ').filter(Boolean).length >= 2;
    if (!merged && !CREATING_REFLOG.test(subject)) continue;
    const seconds = /@\{(\d+)\}$/.exec(selector)?.[1];
    if (seconds !== undefined) entries.push({ hash, at: Number(seconds) * 1000 });
  }
  return entries;
}

/**
 * The reflog creations timed inside one of `spans`. Reflog times are whole
 * seconds: an entry counts from the second its call started in to the end of
 * the second its result came in. One inside a subagent launch's span counts
 * only outside `excluded` (the runs of bound subagents, launched in it or in
 * the window): those are credited to their own records.
 */
export function creationsInSpans(entries: readonly ReflogCreation[], spans: readonly CallSpan[], excluded: readonly CallSpan[] = []): ReflogCreation[] {
  const inside = (at: number, { start, end }: CallSpan) => at >= Math.floor(start / 1000) * 1000 && at <= end;
  return entries.filter(({ at }) => spans.some((span) => inside(at, span) && (!span.launch || !excluded.some((run) => inside(at, run)))));
}

/** Where the generated skill copies live (spec §15): an agent committing them is flagged. */
const SKILLS_DIR = '.grimoire/skills';

interface Snapshot {
  readonly hash: string;
  readonly at: string;
  readonly subject: string;
  readonly files: string[];
  readonly added: number;
  readonly removed: number;
  /** Whether a skills file differs from every parent's (for a merge: matches neither). */
  readonly editsSkills: boolean;
}

type GitOptions = { stallMs?: StallLimit };

/**
 * What `repo` knows of each of `hashes` (full or as printed), by the hash
 * asked for: null for a commit it lacks. A handful of git processes however
 * many commits: one resolves them, one lists them with what they changed
 * against their first parent, one reads the skills files of those touching
 * them.
 */
async function snapshots(repo: string, hashes: readonly string[], options: GitOptions): Promise<Map<string, Snapshot | null>> {
  const found = new Map<string, Snapshot | null>(hashes.map((hash) => [hash, null]));
  if (hashes.length === 0) return found;
  const resolved = await batchCheck(repo, hashes.map((hash) => `${hash}^{commit}`), options);
  const fulls = new Map<string, string>();
  hashes.forEach((hash, i) => {
    const full = resolved[i];
    if (full !== null && full !== undefined) fulls.set(hash, full);
  });
  if (fulls.size === 0) return found;
  const unique = [...new Set(fulls.values())];
  const run = await runGit(
    repo,
    ['-c', 'core.quotePath=false', 'log', '--no-walk=unsorted', '--no-show-signature', '--root', '-m', '--first-parent', '--numstat', '--no-renames', '--format=%x1e%H%x1f%P%x1f%ct%x1f%s', ...unique, '--'],
    options,
  );
  if (run.code !== 0) return found;
  const listed = new Map<string, Snapshot & { parents: string[] }>();
  for (const record of run.stdout.toString('utf8').split('\x1e')) {
    const [header, ...rest] = record.split('\n');
    const [full, parentList, time, subject] = (header ?? '').split('\x1f');
    if (!full || time === undefined || subject === undefined || listed.has(full)) continue;
    const files: string[] = [];
    let added = 0;
    let removed = 0;
    for (const line of rest) {
      const match = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line);
      if (!match) continue;
      files.push(unquote(match[3]!));
      // A binary file counts `-`.
      if (match[1] !== '-') added += Number(match[1]);
      if (match[2] !== '-') removed += Number(match[2]);
    }
    const parents = (parentList ?? '').split(' ').filter(Boolean);
    listed.set(full, { hash: full, at: new Date(Number(time) * 1000).toISOString(), subject, files, added, removed, editsSkills: false, parents });
  }
  const skillEdits = await editsSkills(repo, [...listed.values()], options);
  for (const [hash, full] of fulls) {
    const shot = listed.get(full);
    if (!shot) continue;
    const { parents: _parents, ...snapshot } = shot;
    found.set(hash, { ...snapshot, editsSkills: skillEdits.has(full) });
  }
  return found;
}

const inSkills = (file: string) => file === SKILLS_DIR || file.startsWith(`${SKILLS_DIR}/`);

/**
 * The commits among `commits` with a skills file that differs from every
 * parent's (for a root commit, any skills file): for a merge, one whose
 * merged file matches neither parent. Such a file differs from the first
 * parent's, so only the skills files a commit changed against it are read.
 */
async function editsSkills(repo: string, commits: readonly (Snapshot & { parents: readonly string[] })[], options: GitOptions): Promise<Set<string>> {
  const asked: { commit: string; file: string; revs: string[] }[] = [];
  for (const commit of commits) {
    for (const file of commit.files.filter(inSkills)) asked.push({ commit: commit.hash, file, revs: [commit.hash, ...commit.parents] });
  }
  const flagged = new Set<string>();
  if (asked.length === 0) return flagged;
  const blobs = await batchCheck(repo, asked.flatMap(({ file, revs }) => revs.map((rev) => `${rev}:${file}`)), options);
  let at = 0;
  for (const { commit, revs } of asked) {
    const [own, ...parents] = revs.map(() => blobs[at++] ?? null);
    if (parents.every((parent) => parent !== own)) flagged.add(commit);
  }
  return flagged;
}

/** The object each of `names` names, in order; null for one `repo` lacks (or can't tell apart). */
async function batchCheck(repo: string, names: readonly string[], options: GitOptions): Promise<(string | null)[]> {
  const run = await runGit(repo, ['cat-file', '--batch-check=%(objectname)'], { ...options, input: `${names.join('\n')}\n` });
  if (run.code !== 0) return names.map(() => null);
  const lines = run.stdout.toString('utf8').split('\n');
  return names.map((_name, i) => {
    const line = lines[i] ?? '';
    return /^[0-9a-f]{40,64}$/.test(line) ? line : null;
  });
}

/** Git's C-style escapes in a quoted path. */
const ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, '\\': 92 };

/** A path as git quotes one with a quote, a backslash or a control character in it. */
function unquote(file: string): string {
  if (!file.startsWith('"') || !file.endsWith('"')) return file;
  const bytes: number[] = [];
  const body = Buffer.from(file.slice(1, -1), 'utf8');
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== 92) {
      bytes.push(body[i]!);
      continue;
    }
    const next = String.fromCharCode(body[i + 1] ?? 0);
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(body.subarray(i + 1, i + 4).toString('latin1'), 8));
      i += 3;
    } else {
      bytes.push(ESCAPES[next] ?? body[i + 1]!);
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function factOf(base: Pick<CommitFact, 'hash' | 'via' | 'session' | 'context'>, shot: Snapshot | null, flagged: boolean): CommitFact {
  if (shot === null) return base;
  return {
    ...base,
    hash: shot.hash,
    at: shot.at,
    subject: shot.subject,
    files: shot.files,
    added: shot.added,
    removed: shot.removed,
    ...(flagged && shot.editsSkills ? { agent_skill_edit: true as const } : {}),
  };
}

/**
 * The observed commits of an agent context: what its tool results showed git
 * creating, and the reflog creations timed inside its calls, each once,
 * snapshotted from `repo`. Every one is an agent context's, so a skills edit
 * is flagged.
 */
export async function observedCommits(
  repo: string,
  seen: readonly SeenCommit[],
  reflog: readonly ReflogCreation[],
  who: { readonly session: string | null; readonly context: string | null },
  options: GitOptions = {},
): Promise<CommitFact[]> {
  const credited: { hash: string; session: string | null; context: string | null }[] = [
    ...seen,
    ...[...reflog].sort((a, b) => a.at - b.at).map(({ hash }) => ({ hash, ...who })),
  ];
  const shots = await snapshots(repo, [...new Set(credited.map(({ hash }) => hash))], options).catch(() => new Map<string, Snapshot | null>());
  const facts: CommitFact[] = [];
  const known = new Set<string>();
  for (const { hash, session, context } of credited) {
    const shot = shots.get(hash) ?? null;
    const id = shot?.hash ?? hash;
    if (known.has(id) || (shot === null && [...known].some((full) => full.startsWith(hash)))) continue;
    known.add(id);
    facts.push(factOf({ hash, via: 'observed', session, context }, shot, true));
  }
  return facts;
}

/** A referenced commit, and whether a known agent co-authored it. */
export interface ReferencedCommit {
  readonly fact: CommitFact;
  readonly coAuthored: boolean;
}

/** Co-author trailers of the agent clients grimoire knows: Claude Code's and Codex's. */
const AGENT_CO_AUTHOR = /^\s*(?:claude|codex)\b|<[^>]*@anthropic\.com>|<(?:codex|noreply)@openai\.com>/i;

/** Whether a `Co-authored-by` trailer value names a known agent. */
export function isAgentCoAuthor(value: string): boolean {
  return AGENT_CO_AUTHOR.test(value);
}

/** Commit times are whole seconds, and clocks drift: the search reaches a day earlier, then filters exactly. */
const SINCE_SLACK_S = 86_400;

/**
 * The commits on any branch of the clone at `repo` whose `Refs:` trailer
 * names `issue`, committed from `from` to `to` (epoch ms), oldest first,
 * snapshotted. Grimoire's own refs are left out.
 */
export async function referencedCommits(repo: string, issue: string, from: number, to: number, options: GitOptions = {}): Promise<ReferencedCommit[]> {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
  const since = Math.floor(from / 1000);
  const until = Math.ceil(to / 1000);
  const run = await runGit(
    repo,
    [
      'log',
      '--exclude=refs/grimoire/*',
      '--all',
      `--since=@${since - SINCE_SLACK_S}`,
      '-i',
      '--grep=^refs:',
      '--format=%H%x1f%ct%x1f%(trailers:key=Refs,valueonly,separator=%x1d)%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1d)%x1e',
      '--',
    ],
    options,
  );
  if (run.code !== 0) return [];
  const names = new RegExp(`(?<![\\w-])${issue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);
  const found: { hash: string; at: number; coAuthored: boolean }[] = [];
  for (const record of run.stdout.toString('utf8').split('\x1e')) {
    const [hash, time, refs, coAuthors] = record.replace(/^\n/, '').split('\x1f');
    if (!hash || time === undefined || refs === undefined) continue;
    const at = Number(time);
    if (!(at >= since && at <= until)) continue;
    if (!refs.split('\x1d').some((value) => names.test(value))) continue;
    found.push({ hash, at, coAuthored: (coAuthors ?? '').split('\x1d').some((value) => value.trim() !== '' && isAgentCoAuthor(value)) });
  }
  found.sort((a, b) => a.at - b.at);
  const shots = await snapshots(repo, found.map(({ hash }) => hash), options).catch(() => new Map<string, Snapshot | null>());
  return found.map(({ hash, coAuthored }) => ({ fact: factOf({ hash, via: 'referenced' }, shots.get(hash) ?? null, coAuthored), coAuthored }));
}

/** The referenced commits as `end.md` records them: an agent-co-authored one is `agent_assisted` in a human attempt. */
export function referencedFacts(commits: readonly ReferencedCommit[], workerKind: string): CommitFact[] {
  return commits.map(({ fact, coAuthored }) => (coAuthored && workerKind === 'human' ? { ...fact, agent_assisted: true as const } : fact));
}
