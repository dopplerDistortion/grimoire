// The launcher file (spec §11): `<git-common-dir>/grimoire/launcher.cjs`,
// written only by `init`. It carries its own version and only moves forward:
// an existing launcher is replaced only by a newer one, or when it fails its
// self-check. The swap is a temp file plus a rename, retried on EPERM/EBUSY.
//
// On disk the file is a header line, then the launcher's source:
//
//   // grimoire-launcher <version> <sha256 hex of everything after this line>
//
// The header format is frozen: every later release reads it to decide whether
// to move a launcher forward. The self-check recomputes the hash, so a
// truncated, edited or garbled launcher fails it.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { readTextIfExists, writeFileAtomic, type MachineLocalStore } from '../machine-local';
import LAUNCHER_SOURCE from './launcher.cjs?raw';
import { withInstallLock } from './lock';

const HEADER = /^\/\/ grimoire-launcher (\d+) ([0-9a-f]{64})\n/;

const body = LAUNCHER_SOURCE.replace(/\r\n/g, '\n');

/** The version of the launcher this release ships. */
export const LAUNCHER_VERSION: number = Number(/^const LAUNCHER_VERSION = (\d+);$/m.exec(body)?.[1]);

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The launcher file this release writes, header included. */
export function launcherText(): string {
  return `// grimoire-launcher ${LAUNCHER_VERSION} ${sha256(body)}\n${body}`;
}

/** `<git-common-dir>/grimoire/launcher.cjs`. */
export function launcherPath(store: MachineLocalStore): string {
  return path.join(store.dir, 'launcher.cjs');
}

export type LauncherState =
  | { readonly status: 'missing' }
  /** Its header parses and its hash matches what follows. */
  | { readonly status: 'intact'; readonly version: number }
  /** Unreadable header, or a body that doesn't match its hash. */
  | { readonly status: 'corrupt' };

/** The launcher on disk and whether it passes its self-check. */
export async function inspectLauncher(store: MachineLocalStore): Promise<LauncherState> {
  const text = await readTextIfExists(launcherPath(store));
  if (text === undefined) return { status: 'missing' };
  const header = HEADER.exec(text);
  if (!header || sha256(text.slice(header[0].length)) !== header[2]) return { status: 'corrupt' };
  return { status: 'intact', version: Number(header[1]) };
}

export interface LauncherInstall {
  /** `written`: there was none; `replaced`: older or corrupt; `kept`: same or newer, intact. */
  readonly action: 'written' | 'replaced' | 'kept';
  /** The version on disk afterwards. */
  readonly version: number;
  readonly before: LauncherState;
}

/**
 * Moves the launcher forward if needed (init's step 5; upgrade's step 2).
 * Never moves it backward: an intact launcher of this version or newer stays.
 */
export async function installLauncher(store: MachineLocalStore): Promise<LauncherInstall> {
  return withInstallLock(store, async () => {
    const before = await inspectLauncher(store);
    if (before.status === 'intact' && before.version >= LAUNCHER_VERSION) {
      return { action: 'kept', version: before.version, before };
    }
    await writeFileAtomic(launcherPath(store), launcherText());
    return { action: before.status === 'missing' ? 'written' : 'replaced', version: LAUNCHER_VERSION, before };
  });
}
