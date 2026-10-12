// Where each record lives on the tracker (spec §3, Layout). Only the tracker
// store knows these paths.
import { shardOf } from './ids';

export const TRACKER_REF = 'refs/grimoire/tracker';
/** The tracker's branch on a remote: what fetch and push name in their explicit refspecs (spec §3, Refs). */
export const TRACKER_BRANCH = 'refs/heads/grimoire/tracker';
/** The remote-tracking ref of `remote`'s `grimoire/tracker` branch. */
export function remoteTrackerRef(remote: string): string {
  return `refs/remotes/${remote}/grimoire/tracker`;
}

export const FORMAT_FILE = 'format';
export const SETTINGS_FILE = 'settings.yml';
export const GITATTRIBUTES_FILE = '.gitattributes';
/** Tracker blobs are data: no checkout or forge view may convert their line endings. */
export const GITATTRIBUTES = '* -text\n';

export const ISSUES_DIR = 'issues';
export const DELETED_DIR = 'deleted';
export const FORWARDS_DIR = 'forwards';
export const PURGES_DIR = 'purges';
export const KEYS_DIR = 'keys';

/** `issues/<a>/<b>/<id>`: everything one issue owns. */
export function issueDir(id: string): string {
  const [a, b] = shardOf(id);
  return `${ISSUES_DIR}/${a}/${b}/${id}`;
}

export function issueFile(id: string): string {
  return `${issueDir(id)}/issue.md`;
}

export const COMMENTS_DIR = 'comments';

/** `issues/<a>/<b>/<id>/comments/<comment id>.md` */
export function commentFile(issue: string, comment: string): string {
  return `${issueDir(issue)}/${COMMENTS_DIR}/${comment}.md`;
}

/** `keys/<yyyy-mm>/<h2>/<sha256>.json` */
export function keyFile(month: string, keyHash: string): string {
  return `${KEYS_DIR}/${month}/${keyHash.slice(0, 2)}/${keyHash}.json`;
}

export const ATTEMPTS_DIR = 'attempts';
export const OUTCOMES_DIR = 'outcomes';
export const ACTIVITY_DIR = 'activity';
export const SESSIONS_DIR = 'sessions';

/** `attempts/<a>/<b>/<issue-id>/<attempt-id>`: one attempt's directory, sharded by its issue. */
export function attemptDir(issue: string, attempt: string): string {
  const [a, b] = shardOf(issue);
  return `${ATTEMPTS_DIR}/${a}/${b}/${issue}/${attempt}`;
}

/** Whether `file` is an attempt's `end.md`, the seal an attempt-ending write puts on it. */
export function isAttemptEnd(file: string): boolean {
  const parts = file.split('/');
  return parts.length === 6 && parts[0] === ATTEMPTS_DIR && parts[5] === 'end.md';
}

/** `attempts/<a>/<b>/<issue-id>/<attempt-id>/activity/<entry>.md` */
export function activityFile(issue: string, attempt: string, entry: string): string {
  return `${attemptDir(issue, attempt)}/${ACTIVITY_DIR}/${entry}.md`;
}

/** `outcomes/<a>/<b>/<issue-id>/<attempt-id>.md` */
export function outcomeFile(issue: string, attempt: string): string {
  const [a, b] = shardOf(issue);
  return `${OUTCOMES_DIR}/${a}/${b}/${issue}/${attempt}.md`;
}

export const CONFLICTS_DIR = 'conflicts';

/** `issues/<a>/<b>/<id>/conflicts`: the issue's fold conflict records. */
export function conflictsDir(issue: string): string {
  return `${issueDir(issue)}/${CONFLICTS_DIR}`;
}

/** `issues/<a>/<b>/<id>/conflicts/<hash>.md` */
export function conflictFile(issue: string, name: string): string {
  return `${conflictsDir(issue)}/${name}.md`;
}

/** `deleted/<id>.md`: the delete tombstone. */
export function deletedFile(id: string): string {
  return `${DELETED_DIR}/${id}.md`;
}

/** `forwards/<id>.md`: the forwarding record of a resolved id collision. */
export function forwardFile(id: string): string {
  return `${FORWARDS_DIR}/${id}.md`;
}

/** `knowledge/ledger/<id>.md`: the skill ledger, one write-once record per file, named by its sha256 (spec §18). */
export const LEDGER_DIR = 'knowledge/ledger';
/** `knowledge/skill-versions/<sha256>.md`: each skill version's normalized text, named by its sha256 (spec §18). */
export const SKILL_VERSIONS_DIR = 'knowledge/skill-versions';

export function ledgerFile(id: string): string {
  return `${LEDGER_DIR}/${id}.md`;
}

export function skillVersionFile(version: string): string {
  return `${SKILL_VERSIONS_DIR}/${version}.md`;
}

/** A session key (spec §3): the hex hash naming one bound context's session record within its attempt. */
export const SESSION_KEY_PATTERN = /^[0-9a-f]{16,64}$/;

/** `attempts/<a>/<b>/<issue-id>/<attempt-id>/sessions/<session-key>.md`: one bound context's session record (spec §3, §14). */
export function sessionFile(issue: string, attempt: string, key: string): string {
  return `${attemptDir(issue, attempt)}/${SESSIONS_DIR}/${key}.md`;
}

/** `purges/<attempt-id>.md`: the tombstone of a purged trace (spec §3). */
export function tracePurgeFile(attempt: string): string {
  return `${PURGES_DIR}/${attempt}.md`;
}

/** `purges/<attempt-id>/<session-key>.md`: the tombstone of one purged session record (spec §3, §14). */
export function sessionPurgeFile(attempt: string, key: string): string {
  return `${PURGES_DIR}/${attempt}/${key}.md`;
}
