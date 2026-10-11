// The generated-path list (spec §6 Records; §11 "generated skill copies and
// stubs are not manifest entries"): every generated folder grimoire made in
// any worktree of the clone, one absolute path per line. Its format is
// frozen, so `leave` and `uninstall` at any release can read it; only writes
// go through the machine marker's rule, as every record's do.
import path from 'node:path';
import { readTextIfExists, writeFileAtomic, type MachineLocalStore } from '../machine-local';
import { checkMachineMarker } from '../machine-local/marker';

/** `<git-common-dir>/grimoire/records/generated-paths.txt`. */
export function pathListFile(store: MachineLocalStore): string {
  return path.join(store.dir, 'records', 'generated-paths.txt');
}

/** Paths as the default file systems compare them: Windows and macOS fold case. */
export function comparablePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

/** Every path on the list, as written. */
export async function readPathList(store: MachineLocalStore): Promise<string[]> {
  const text = await readTextIfExists(pathListFile(store));
  return text === undefined ? [] : text.split('\n').filter((line) => line !== '');
}

/** Adds `added` and drops `removed` (absolute folder paths), exclusively across processes. */
export async function updatePathList(store: MachineLocalStore, change: { readonly added?: readonly string[]; readonly removed?: readonly string[] }): Promise<void> {
  const added = (change.added ?? []).filter((entry) => !entry.includes('\n'));
  const removed = new Set((change.removed ?? []).map(comparablePath));
  if (added.length === 0 && removed.size === 0) return;
  checkMachineMarker(await store.marker.ensure());
  await store.locks.withLock('records/generated-paths', async () => {
    const kept = new Map<string, string>();
    for (const entry of await readPathList(store)) {
      if (!removed.has(comparablePath(entry))) kept.set(comparablePath(entry), entry);
    }
    for (const entry of added) kept.set(comparablePath(entry), entry);
    const lines = [...kept.values()].sort();
    await writeFileAtomic(pathListFile(store), lines.length === 0 ? '' : `${lines.join('\n')}\n`);
  });
}
