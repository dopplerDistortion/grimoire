// The package `init` installs as the version copy (spec §11, Version copies):
// the running package itself, as npx installed it. npx installs into
// `<prefix>/node_modules/@goksening/grimoire/` and records npm's tarball
// integrity in `<prefix>/node_modules/.package-lock.json`; the copy's
// `.complete` keeps that integrity, so `doctor` can check the copy later. A
// package run from anywhere else (a global install, a checkout) records none.
import path from 'node:path';
import { readTextIfExists } from '../machine-local';
import { PACKAGE_NAME, type CopySource } from './copies';

/** The package folder of the running bin (`<package>/dist/grimoire.mjs`). */
export function packageDirOf(bin: string): string {
  return path.dirname(path.dirname(bin));
}

/** npm's recorded integrity for the package at `packageDir`, or null. */
async function npmIntegrity(packageDir: string): Promise<string | null> {
  const scope = path.dirname(packageDir);
  const nodeModules = path.dirname(scope);
  if (path.basename(nodeModules) !== 'node_modules' || path.join(path.basename(scope), path.basename(packageDir)) !== path.join(...PACKAGE_NAME.split('/'))) {
    return null;
  }
  const key = `node_modules/${PACKAGE_NAME}`;
  for (const lockfile of [path.join(nodeModules, '.package-lock.json'), path.join(path.dirname(nodeModules), 'package-lock.json')]) {
    const text = await readTextIfExists(lockfile);
    if (text === undefined) continue;
    try {
      const integrity = (JSON.parse(text) as { packages?: Record<string, { integrity?: unknown }> }).packages?.[key]?.integrity;
      if (typeof integrity === 'string') return integrity;
    } catch {
      // An unreadable lockfile records nothing.
    }
  }
  return null;
}

/** The running package as a copy source. */
export async function runningPackage(bin: string): Promise<CopySource> {
  const dir = packageDirOf(bin);
  return { dir, integrity: await npmIntegrity(dir) };
}
