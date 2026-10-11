import path from 'node:path';
import { Caches } from './caches';
import { DocStore } from './docs';
import { findGitDirs, type FindGitDirsOptions } from './git-dirs';
import { Leases } from './leases';
import { Locks } from './locks';
import { checkMachineMarker, MachineMarkerFile } from './marker';
import { currentHost } from './process-info';
import { ProcessRecords } from './processes';

export interface MachineLocalStoreOptions {
  /** This machine's name, as recorded in holders and process records. Defaults to the OS hostname. */
  readonly host?: string;
}

export interface LocateOptions extends FindGitDirsOptions, MachineLocalStoreOptions {}

/**
 * The never-committed half of the live store, `<git-common-dir>/grimoire/`,
 * shared by every worktree of a clone (spec §6). Its layout is a product
 * contract; the coordination class is frozen by the cross-pin contract (§21):
 *
 *   format                          the machine marker: format / compat / requires
 *   leases/<name>/<gen>.json        coordination: leases
 *   locks/<name>/<gen>.json         coordination: locks
 *   processes/<pid>-<nonce>.json    coordination: process records
 *   coordination/<kind>/<key>.json  coordination: every other kind (seen-here rows, ...)
 *   records/<kind>/<key>.json       records, under the marker's J..K rule
 *   caches/<name>.json              caches, versioned per cache
 *
 * `<name>` and `<key>` are the name itself when it is a short lowercase file
 * name, otherwise `~` plus a hash; the original is kept inside the file.
 * Coordination files carry no version field. `pkg/` and `launcher.cjs` sit
 * alongside (§11) and belong to the installer.
 */
export class MachineLocalStore {
  /** `<git-common-dir>/grimoire`. */
  readonly dir: string;
  /** This machine's name. */
  readonly host: string;
  /** Non-blocking, expiring leases (coordination). */
  readonly leases: Leases;
  /** Exclusive locks, held while their holder process lives (coordination). */
  readonly locks: Locks;
  /** Records of running grimoire processes (coordination). */
  readonly processes: ProcessRecords;
  /** Coordination data: version-free, part of the frozen cross-pin contract. */
  readonly coordination: DocStore;
  /** Caches, versioned per cache and rebuilt when missing or older. */
  readonly caches: Caches;
  /** The store's own `format` / `compat` / `requires` marker. */
  readonly marker: MachineMarkerFile;
  /** Records: under the machine marker's J..K rule (UPGRADE_REQUIRED outside it). */
  readonly records: DocStore;

  constructor(
    /** The git common directory. */
    readonly commonDir: string,
    /** The worktree this store was located from, or null. */
    readonly worktree: string | null = null,
    options: MachineLocalStoreOptions = {},
  ) {
    this.dir = path.join(commonDir, 'grimoire');
    this.host = options.host ?? currentHost();
    this.leases = new Leases(path.join(this.dir, 'leases'), this.host);
    this.locks = new Locks(path.join(this.dir, 'locks'), this.host);
    this.processes = new ProcessRecords(path.join(this.dir, 'processes'), this.host);
    this.coordination = new DocStore(path.join(this.dir, 'coordination'), {
      beforeRead: async () => {},
      beforeWrite: async () => {},
      exclusive: (kind, fn) => this.locks.withLock(`coordination/${kind}`, fn),
    });
    this.caches = new Caches(path.join(this.dir, 'caches'));
    this.marker = new MachineMarkerFile(this.dir);
    this.records = new DocStore(path.join(this.dir, 'records'), {
      beforeRead: () => this.marker.check(),
      beforeWrite: async () => checkMachineMarker(await this.marker.ensure()),
      exclusive: (kind, fn) => this.locks.withLock(`records/${kind}`, fn),
    });
  }
}

/**
 * Finds the machine-local store of the clone that `from` is inside, without
 * spawning git. Returns null outside a git checkout.
 */
export async function locateMachineLocalStore(
  from: string,
  options: LocateOptions = {},
): Promise<MachineLocalStore | null> {
  const dirs = await findGitDirs(from, options);
  if (!dirs) return null;
  return new MachineLocalStore(dirs.commonDir, dirs.worktree, options);
}
