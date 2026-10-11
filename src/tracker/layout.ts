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

/** `issues/<a>/<b>/<id>/conflicts/<hash>.md` */
export function conflictFile(issue: string, name: string): string {
  return `${issueDir(issue)}/${CONFLICTS_DIR}/${name}.md`;
}
