// Where each record lives on the tracker (spec §3, Layout). Only the tracker
// store knows these paths.
import { shardOf } from './ids';

export const TRACKER_REF = 'refs/grimoire/tracker';
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
export const KEYS_DIR = 'keys';

export function issueFile(id: string): string {
  const [a, b] = shardOf(id);
  return `${ISSUES_DIR}/${a}/${b}/${id}/issue.md`;
}

/** `keys/<yyyy-mm>/<h2>/<sha256>.json` */
export function keyFile(month: string, keyHash: string): string {
  return `${KEYS_DIR}/${month}/${keyHash.slice(0, 2)}/${keyHash}.json`;
}
