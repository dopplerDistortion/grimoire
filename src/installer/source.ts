// The package `init` installs as the version copy (spec §11, Version copies):
// the running package itself, as npx installed it. npx installs into
// `<prefix>/node_modules/@goksening/grimoire/` and records npm's tarball
// integrity in `<prefix>/node_modules/.package-lock.json`; the copy's
// `.complete` keeps that integrity, so `doctor` can check the copy later. A
// package run from anywhere else (a global install, a checkout) records none.
//
// `init --from-node-modules` takes the host repo's own devDependency instead
// (spec §11): `<root>/node_modules/@goksening/grimoire/`, when it is the
// version init installs, with the integrity the host's lockfile records.
import path from 'node:path';
import { GrimoireError } from '../errors';
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

/**
 * The host repo's devDependency as a copy source, when it is `version`.
 * Throws INVALID (`details.found`: the version node_modules holds, or null)
 * when node_modules has no grimoire package, or another version.
 */
export async function nodeModulesPackage(root: string, version: string): Promise<CopySource> {
  const relative = `node_modules/${PACKAGE_NAME}`;
  const dir = path.join(root, 'node_modules', ...PACKAGE_NAME.split('/'));
  let found: string | null = null;
  const text = await readTextIfExists(path.join(dir, 'package.json'));
  if (text !== undefined) {
    try {
      const manifest = JSON.parse(text) as { name?: unknown; version?: unknown };
      if (manifest.name === PACKAGE_NAME && typeof manifest.version === 'string') found = manifest.version;
    } catch {
      // An unreadable manifest is no package.
    }
  }
  const install = `npm install --save-dev --save-exact ${PACKAGE_NAME}@${version}`;
  if (found === null) {
    throw new GrimoireError(
      'INVALID',
      `init --from-node-modules found no ${relative} in ${root}: run \`${install}\` first, or init without --from-node-modules; nothing changed`,
      { version, found, command: install },
    );
  }
  if (found !== version) {
    throw new GrimoireError(
      'INVALID',
      `${relative} in ${root} holds grimoire ${found}, and init installs ${version}: run \`${install}\` first, or init without --from-node-modules; nothing changed`,
      { version, found, command: install },
    );
  }
  return { dir, integrity: await npmIntegrity(dir) };
}

/** The running package as a copy source. */
export async function runningPackage(bin: string): Promise<CopySource> {
  const dir = packageDirOf(bin);
  return { dir, integrity: await npmIntegrity(dir) };
}
