// `.grimoire/config.yml` (spec §11, The dotfolder): the pin, `install_format`,
// the tracker root R and the adapter decision. `init` writes it last: it is
// the commit point for its worktree. Every reader takes `version:` from a
// top-level line (the bootstrap, the launcher and the shim each read it
// themselves), so its layout is frozen: one `key: value` line per field.
import path from 'node:path';
import { INSTALL_FORMAT_RANGE } from '../core/host';
import { readTextIfExists } from '../machine-local';
import { TRACKER_ROOT_KEY, namedTrackerRoot } from '../tracker';

/** Where it lives, relative to the checkout root. */
export const CONFIG_PATH = '.grimoire/config.yml';

/** The adapter decision: the block was written (`grimoire`), or the person declined it. */
export type AdapterDecision = 'grimoire' | 'declined';

export interface InstallConfig {
  /** The pin. */
  readonly version: string;
  readonly install_format: number;
  /** The tracker root R. */
  readonly tracker_root: string;
  /** null: never asked (no adapter doc needed it). */
  readonly adapter: AdapterDecision | null;
}

/** What a checkout's config.yml says; fields it lacks are null. */
export interface CheckoutInstall {
  readonly version: string | null;
  readonly install_format: number | null;
  readonly tracker_root: string | null;
  readonly adapter: AdapterDecision | null;
  /** The file's text, as read. */
  readonly text: string;
}

/** The checkout's config.yml, or null when there is none. */
export async function readInstallConfig(root: string): Promise<CheckoutInstall | null> {
  const text = await readTextIfExists(path.join(root, CONFIG_PATH));
  if (text === undefined) return null;
  const scalar = (key: string) => new RegExp(`^${key}:[ \\t]*["']?([^"'\\s#]+)`, 'm').exec(text)?.[1] ?? null;
  const format = scalar('install_format');
  const adapter = scalar('adapter');
  return {
    version: scalar('version'),
    install_format: format !== null && /^\d+$/.test(format) ? Number(format) : null,
    tracker_root: namedTrackerRoot(text),
    adapter: adapter === 'grimoire' || adapter === 'declined' ? adapter : null,
    text,
  };
}

/** config.yml's text. */
export function serializeInstallConfig(config: InstallConfig): string {
  return [
    "# grimoire's install configuration for this checkout, written by `grimoire init`. Commit it with the rest of .grimoire/.",
    `version: ${config.version}`,
    `install_format: ${config.install_format}`,
    `${TRACKER_ROOT_KEY}: ${config.tracker_root}`,
    ...(config.adapter !== null ? [`adapter: ${config.adapter}`] : []),
    '',
  ].join('\n');
}

/** Whether an existing config.yml already says what `config` says (then it is left as it is). */
export function sameInstall(existing: CheckoutInstall | null, config: InstallConfig): boolean {
  return (
    existing !== null &&
    existing.version === config.version &&
    existing.install_format === config.install_format &&
    existing.tracker_root === config.tracker_root &&
    existing.adapter === config.adapter
  );
}

/** The install_format this release writes. */
export const INSTALL_FORMAT = INSTALL_FORMAT_RANGE.K;
