// Probe launcher for spike E (GOK-130): the bootstrap stand-in requires this
// from <git-common-dir>/grimoire/launcher.cjs and calls it with (args, root).
// It logs what the hook process saw, tries the P3 writes, and prints one line.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const execFileSync = require('child_process').execFileSync;

function parentImage() {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${process.ppid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return (out.split(',')[0] ?? '').replace(/"/g, '').trim();
  } catch (e) {
    return `unknown (${/** @type {NodeJS.ErrnoException} */ (e).code})`;
  }
}

/**
 * @param {string[]} args process.argv.slice(1), as the bootstrap passes it
 * @param {string} root the folder holding the `.git` the bootstrap found
 */
module.exports = function launcher(args, root) {
  let stdin = '';
  try {
    stdin = fs.readFileSync(0, 'utf8');
  } catch (e) {
    stdin = `ERR ${/** @type {NodeJS.ErrnoException} */ (e).code}`;
  }
  const commonDir = path.dirname(__dirname);
  const at = new Date().toISOString();
  /** @type {Record<string, string | undefined>} */
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CODEX|COMSPEC$|SHELL$|PSModulePath$|PSExecutionPolicyPreference$)/i.test(k)) env[k] = v;
  }
  /** @type {Record<string, unknown>} */
  const entry = {
    at,
    tag: process.env.GRIMOIRE_PROBE_TAG ?? null,
    argv: process.argv,
    execArgv: process.execArgv,
    bootstrapSha256: crypto.createHash('sha256').update(process.execArgv[1] ?? '').digest('hex'),
    args,
    root,
    cwd: process.cwd(),
    parent: parentImage(),
    env,
    stdin,
  };
  const targets = [
    path.join(root, '.agents', 'skills', 'grimoire-p3-probe', 'probe.txt'),
    path.join(root, '.grimoire', 'skills', 'p3-probe', 'probe.txt'),
    path.join(commonDir, 'grimoire', 'p3-marker.txt'),
  ];
  if (process.env.GRIMOIRE_PROBE_SKILL) {
    // A valid skill folder, to see from which turn Codex lists it (B2 evidence).
    const dir = path.join(root, '.agents', 'skills', process.env.GRIMOIRE_PROBE_SKILL);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${process.env.GRIMOIRE_PROBE_SKILL}\ndescription: Written by the SessionStart hook at ${at}.\n---\nBody.\n`,
    );
  }
  entry.writes = targets.map((t) => {
    try {
      fs.mkdirSync(path.dirname(t), { recursive: true });
      fs.writeFileSync(t, `written by the SessionStart hook at ${at}\n`);
      return { path: t, ok: true };
    } catch (e) {
      return { path: t, ok: false, error: /** @type {NodeJS.ErrnoException} */ (e).code };
    }
  });
  fs.appendFileSync(path.join(commonDir, 'grimoire', 'hook-log.jsonl'), `${JSON.stringify(entry)}\n`);
  // GRIMOIRE_PROBE_OUTPUT picks the stdout shape: plain text (default), Codex's
  // JSON schema (`codex-json`), Claude Code's real shape with `reloadSkills`
  // inside hookSpecificOutput (`claude-json`, as spike C captured it), or the
  // same key at the top level (`claude-json-top`, the first, inexact run).
  const line = `grimoire probe: session line from the hook (${args.join(' ')})`;
  const context = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: line } };
  const mode = process.env.GRIMOIRE_PROBE_OUTPUT;
  if (mode === 'claude-json') {
    const claude = { hookSpecificOutput: { hookEventName: 'SessionStart', reloadSkills: true, additionalContext: line } };
    process.stdout.write(`${JSON.stringify(claude)}\n`);
  } else if (mode === 'claude-json-top') process.stdout.write(`${JSON.stringify({ reloadSkills: true, ...context })}\n`);
  else if (mode === 'codex-json') process.stdout.write(`${JSON.stringify(context)}\n`);
  else process.stdout.write(`${line}\n`);
};
