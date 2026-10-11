#!/usr/bin/env node
'use strict';
// grimoire's shell shim (https://www.npmjs.com/package/@goksening/grimoire).
// `grimoire init` writes this file; it is committed and has no dependencies.
//
//   node .grimoire/run.cjs <verb> ...   (or `npm run -s grimoire -- <verb> ...`)
//   node .grimoire/run.cjs pin          prints the pinned version without loading grimoire
//
// It finds its checkout from its own location and runs the version that
// .grimoire/config.yml pins, in this process (so inside the caller's
// sandbox), through the clone's launcher in the git common directory.
// Exit 3: grimoire isn't set up on this machine for the pin (no launcher,
// one that fails to load, or no copy); the join command is on stderr. `pin`
// exits 2 with no config.yml and 3 for a pin that isn't strict semver. The
// hook verbs always exit 0, and only `hook session-start` prints the line.
const fs = require('fs');
const path = require('path');

const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** The checkout this shim belongs to: the folder that holds `.grimoire/`. */
const root = path.dirname(__dirname);

/**
 * The git common directory of the checkout at `dir`, found without spawning
 * git: `.git` itself, or the `gitdir:` a `.git` file names, followed through
 * `commondir`. null when there is none.
 * @param {string} dir
 * @returns {string | null}
 */
function gitCommonDir(dir) {
  let git = path.join(dir, '.git');
  let info;
  try {
    info = fs.statSync(git);
  } catch (error) {
    return null;
  }
  if (info.isFile()) {
    const match = /^gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(fs.readFileSync(git, 'utf8'));
    if (!match || match[1] === undefined) return null;
    git = path.resolve(dir, match[1]);
  }
  try {
    git = path.resolve(git, fs.readFileSync(path.join(git, 'commondir'), 'utf8').trim());
  } catch (error) {
    // A main checkout's .git (or a submodule's git dir) is its own common dir.
  }
  return git;
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {readonly string[]} args @returns {number | null} */
function main(args) {
  const words = args[0] === '--from' ? args.slice(2) : args;
  // The hook verbs keep their rules here too: only session-start speaks, on stdout, and every hook exits 0.
  const hook = words[0] === 'hook';
  /** @param {string} line @param {number} code */
  const tell = (line, code) => {
    if (!hook) {
      process.stderr.write(line + '\n');
      return code;
    }
    if (words[1] === 'session-start') process.stdout.write(line + '\n');
    return 0;
  };

  let config;
  try {
    config = fs.readFileSync(path.join(__dirname, 'config.yml'), 'utf8');
  } catch (error) {
    if (hook) return 0;
    process.stderr.write("grimoire isn't installed in this checkout: " + path.join(__dirname, 'config.yml') + ' is missing\n');
    return 2;
  }
  const match = /^version:[ \t]*["']?([^"'\s#]+)/m.exec(config);
  const pin = match && match[1] !== undefined ? match[1] : null;
  if (pin === null || !STRICT_SEMVER.test(pin)) {
    return tell("grimoire can't run here: .grimoire/config.yml pins " + JSON.stringify(pin) + ', which is not a strict semver version', 3);
  }
  if (args.length === 1 && args[0] === 'pin') {
    process.stdout.write(pin + '\n');
    return 0;
  }
  const join = "ask the user to run `npx @goksening/grimoire@" + pin + ' init`';
  const common = gitCommonDir(root);
  const launcher = common === null ? null : path.join(common, 'grimoire', 'launcher.cjs');
  if (launcher === null || !fs.existsSync(launcher)) return tell("grimoire isn't set up on this machine; " + join, 3);
  // A launcher that fails to load is one `init` replaces (it fails its self-check). A hook says
  // nothing, as the bootstrap does when the launcher throws.
  const failed = (/** @type {unknown} */ error) => (hook ? 0 : tell("grimoire's launcher " + launcher + ' failed to load (' + messageOf(error) + '); ' + join, 3));
  try {
    Promise.resolve(require(launcher)(args, root)).catch((error) => {
      process.exitCode = failed(error);
    });
  } catch (error) {
    return failed(error);
  }
  return null;
}

const code = main(process.argv.slice(2));
if (code !== null) process.exitCode = code;
