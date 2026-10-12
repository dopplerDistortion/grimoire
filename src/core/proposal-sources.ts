// What the Skill Proposer's checks read from the checkout of the process
// running them (spec §18 Names, Copying, Risk flags: Token origin): the
// hand-written instructions and skills, the client skill folders a
// `grimoire-<name>` stub would take, and where each token a proposal adds
// already appears.
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSessionRecord } from '../capture/session-record';
import { GENERATED_GITIGNORE, STUB_ROOTS } from '../generated/texts';
import { runGit } from '../git/run';
import { handwritten, type AddedToken } from '../knowledge/chores';
import { STUB_PREFIX } from '../knowledge';
import type { TokenOrigin, TrackerView } from '../tracker';
import { parseComment } from '../tracker/comment';

/** The texts of the hand-written instruction files and skills in the checkout at `root`. */
export async function handwrittenTexts(root: string): Promise<string[]> {
  const { skills, instructions } = await handwritten(root);
  const texts: string[] = [];
  for (const id of [...instructions, ...skills]) {
    const text = await readFile(path.join(root, id.slice('handwritten:'.length)), 'utf8').catch(() => null);
    if (text !== null) texts.push(text.replace(/\r\n?/g, '\n'));
  }
  return texts;
}

/**
 * Whether `grimoire-<name>` is taken in a client skill folder of the checkout
 * at `root`: anything there but a folder grimoire generated (one holding its
 * exact `.gitignore`), or any path git tracks under it.
 */
export async function stubCollides(root: string, name: string): Promise<boolean> {
  for (const stubRoot of Object.values(STUB_ROOTS)) {
    const folder = path.join(root, ...stubRoot.split('/'), `${STUB_PREFIX}${name}`);
    const info = await lstat(folder).catch(() => null);
    if (!info) continue;
    if (!info.isDirectory()) return true;
    const ignore = await readFile(path.join(folder, '.gitignore'), 'utf8').catch(() => null);
    if (ignore !== GENERATED_GITIGNORE) return true;
    const tracked = await runGit(root, ['ls-files', '-z', '--', `${stubRoot}/${STUB_PREFIX}${name}`]);
    if (tracked.code !== 0 || tracked.stdout.length > 0) return true;
  }
  return false;
}

/**
 * The baseline token origins are judged against: the merge-base of the
 * checkout's HEAD with the remote default branch, or HEAD alone when
 * `origin/HEAD` is unset; null when the checkout has no commit.
 */
async function baselineOf(root: string): Promise<{ base: string; head: string } | null> {
  const head = await runGit(root, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']);
  if (head.code !== 0) return null;
  const headOid = head.stdout.toString('utf8').trim();
  const remote = await runGit(root, ['rev-parse', '-q', '--verify', 'refs/remotes/origin/HEAD^{commit}']);
  if (remote.code !== 0) return { base: headOid, head: headOid };
  const base = await runGit(root, ['merge-base', 'HEAD', 'refs/remotes/origin/HEAD']);
  return { base: base.code === 0 ? base.stdout.toString('utf8').trim() : headOid, head: headOid };
}

/** The most of the local commits' log the amber check reads. */
const LOG_LIMIT = 4_000_000;

/**
 * Where each token was found (spec §18 Token origin): green in tracked files
 * at the baseline; amber only in agent-authored debriefs (of the cited
 * traces) or in the checkout's commits past the baseline; red only in the
 * cited traces' excerpts, or nowhere.
 */
export async function tokenOrigins(root: string, tokens: readonly AddedToken[], view: TrackerView, traces: readonly string[]): Promise<TokenOrigin[]> {
  if (tokens.length === 0) return [];
  const baseline = await baselineOf(root).catch(() => null);
  let commits = '';
  if (baseline && baseline.base !== baseline.head) {
    const log = await runGit(root, ['log', '-p', '--no-color', '--format=%B', `${baseline.base}..${baseline.head}`]).catch(() => null);
    commits = log && log.code === 0 ? log.stdout.subarray(0, LOG_LIMIT).toString('utf8') : '';
  }
  const debriefs: string[] = [];
  const excerpts: string[] = [];
  for (const trace of traces) {
    const record = view.attempt(trace);
    if (!record) continue;
    const debrief = record.end?.debrief;
    if (debrief) {
      const bytes = await view.traceFile(trace, `activity/${debrief}.md`);
      if (bytes) debriefs.push(parseComment(debrief, bytes).body);
    }
    for (const key of record.sessions.keys()) {
      const bytes = await view.sessionRecord(trace, key);
      if (bytes) excerpts.push(parseSessionRecord(bytes).text ?? '');
    }
  }
  const origins: TokenOrigin[] = [];
  for (const { token, kind } of tokens) {
    let found: string;
    if (baseline && (await runGit(root, ['grep', '-q', '-F', '-e', token, baseline.base, '--']).catch(() => null))?.code === 0) found = 'baseline';
    else if (debriefs.some((text) => text.includes(token))) found = 'debrief';
    else if (commits.includes(token)) found = 'commit';
    else if (excerpts.some((text) => text.includes(token))) found = 'excerpt';
    else found = 'nowhere';
    const origin = found === 'baseline' ? 'green' : found === 'debrief' || found === 'commit' ? 'amber' : 'red';
    origins.push({ token, kind, origin, found });
  }
  return origins;
}
