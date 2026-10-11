'use strict';
// grimoire's launcher (spec §11, ADR 0009). `grimoire init` writes this file to
// <git-common-dir>/grimoire/launcher.cjs, under a header line that carries its
// version and a hash of everything below it; never edit it by hand.
//
// The bootstrap in every agent-client entry calls `launch(args, root)`, and so
// does the shell shim (.grimoire/run.cjs): `args` are the entry's arguments
// (process.argv.slice(1) under `node -e`), `root` is the checkout that holds
// `.git`. The launcher never reads process.argv itself.
//
// It runs only the checkout's pinned version: `pkg/<pin>/` with its
// `.complete` marker, and only once this clone has a join record for the pin.
// It never falls back to node_modules and never fetches. A copy is entered
// through `pkg/<pin>/dist/launch.mjs`, whose `launch(args, info)` owns the
// verb and the exit code from there (the launcher↔package contract, frozen).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const LAUNCHER_VERSION = 1;

// semver.org's strict pattern: no leading v, no ranges.
const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** @param {string} pin */
function notSetUpLine(pin) {
  return "grimoire isn't set up on this machine; ask the user to run `npx @goksening/grimoire@" + pin + ' init`';
}

/**
 * The machine-local records file name for a key, as the store names it
 * (src/machine-local/names.ts): the key itself when it is a short, safe,
 * lowercase name, else `~` plus a sha256 prefix.
 * @param {string} key
 */
function recordFileName(key) {
  const base = key.split('.')[0] || '';
  if (/^[a-z0-9_-][a-z0-9._-]{0,79}$/.test(key) && !key.endsWith('.') && !/^(con|prn|aux|nul|com\d|lpt\d)$/.test(base)) {
    return key;
  }
  return '~' + crypto.createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 40);
}

/**
 * The pinned version as data: `version:` in the checkout's config.yml.
 * undefined when there is no config.yml (a checkout from before the install).
 * @param {string} root
 * @returns {string | null | undefined}
 */
function readPin(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, '.grimoire', 'config.yml'), 'utf8');
  } catch (error) {
    return undefined;
  }
  const match = /^version:[ \t]*["']?([^"'\s#]+)/m.exec(text);
  return match ? match[1] : null;
}

/**
 * @param {readonly string[]} args the entry's arguments, `--from <dir>` included
 * @param {string} root the checkout that holds `.git`
 */
function launch(args, root) {
  const verb = args[0] === '--from' ? args.slice(2) : args;
  const hook = verb[0] === 'hook';
  /** Hooks print only session-start's line and always exit 0; every other verb says it on stderr and exits 3. */
  const tell = (/** @type {string} */ line) => {
    if (hook) {
      if (verb[1] === 'session-start') process.stdout.write(line + '\n');
      return;
    }
    process.stderr.write(line + '\n');
    process.exitCode = 3;
  };

  const pin = readPin(root);
  if (pin === undefined) return Promise.resolve();
  if (pin === null || !STRICT_SEMVER.test(pin)) {
    tell("grimoire can't run here: .grimoire/config.yml pins " + JSON.stringify(pin) + ', which is not a strict semver version');
    return Promise.resolve();
  }

  const copy = path.join(__dirname, 'pkg', pin);
  const joined = fs.existsSync(path.join(__dirname, 'records', 'join', recordFileName(pin) + '.json'));
  if (!joined || !fs.existsSync(path.join(copy, '.complete'))) {
    tell(notSetUpLine(pin));
    return Promise.resolve();
  }

  const info = { root, pin, home: __dirname, copy, launcher: LAUNCHER_VERSION };
  return import(url.pathToFileURL(path.join(copy, 'dist', 'launch.mjs')).href)
    .then((entry) => entry.launch(args, info))
    .catch((/** @type {unknown} */ error) => {
      if (hook) return;
      process.stderr.write('grimoire: ' + pin + ' failed to run from ' + copy + ': ' + (error instanceof Error ? error.stack || error.message : String(error)) + '\n');
      process.exitCode = 1;
    });
}

module.exports = launch;
