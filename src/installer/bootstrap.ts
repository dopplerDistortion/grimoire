// The frozen bootstrap and the client entries that run it (spec §11, §21's
// cross-pin contract, §22 R1–R3). Every agent-client entry runs
// `node -e "<BOOTSTRAP>" [--] [--from <dir>] <verb>`; pointer files embed these
// strings byte for byte, so none of them may ever change within
// install_format 1.
//
// What the bootstrap does, without spawning git:
// 1. args = process.argv.slice(1) (under -e there is no script path; spike A R3);
//    the walk starts at `--from <dir>` when it comes first, else at the cwd.
// 2. It walks up to the first ancestor that holds `.git` and never crosses it;
//    none: exit 0 quietly.
// 3. A `.git` file is followed (`gitdir: <path>`), then `commondir`, to the git
//    common directory.
// 4. If `<common>/grimoire/launcher.cjs` exists it calls
//    `require(launcher)(args, root)`; a throw fails `mcp` but never a hook.
// 5. Otherwise, with `<root>/.grimoire/config.yml` present, it reads the pin
//    and prints the not-set-up line: stdout for `hook session-start` (exit 0),
//    nothing for other hooks (exit 0), stderr for `mcp` (exit 3). With no
//    config.yml (a checkout from before the install) it exits 0 quietly.
//
// The text avoids `$ " \ % ^` and backticks, so it survives JSON, TOML,
// PowerShell, cmd and sh unchanged; the not-set-up line's apostrophe and
// backticks are made with String.fromCharCode. It is longer than the spec's
// "about 400 characters" because it prints that line itself: handing off to
// the committed `.grimoire/run.cjs` instead would let a branch run code under
// Codex's hook approval, which is keyed on this exact command.

/** The bootstrap script, `node -e`'s argument. Frozen. */
export const BOOTSTRAP =
  "const f=require('fs'),p=require('path'),a=process.argv.slice(1),i=a[0]=='--from',[v,e]=i?a.slice(2):a,r=x=>f.readFileSync(x,'utf8').trim();" +
  "let d=p.resolve(i?a[1]:'.'),g,u;for(;!f.existsSync(g=p.join(d,'.git'));d=u)if((u=p.dirname(d))==d)process.exit();" +
  "try{g=p.resolve(d,r(g).slice(8))}catch{}try{g=p.resolve(g,r(g+'/commondir'))}catch{}" +
  "const l=g+'/grimoire/launcher.cjs',y=d+'/.grimoire/config.yml';" +
  "if(f.existsSync(l))try{require(l)(a,d)}catch(x){if(v!='hook')throw x}" +
  "else if(f.existsSync(y)){const[s,b]=String.fromCharCode(39,96)," +
  "m='grimoire isn'+s+'t set up on this machine; ask the user to run '+b+'npx @goksening/grimoire@'+(r(y).match(/version:[ -/]*([0-9][0-9A-Za-z.+-]*)/)||[])[1]+' init'+b;" +
  "v=='mcp'?(console.error(m),process.exitCode=3):e=='session-start'&&console.log(m)}";

/** `.mcp.json` and Codex's `[mcp_servers.grimoire]`: command `node`, these args. Frozen. */
export const MCP_ENTRY_ARGS: readonly string[] = Object.freeze(['-e', BOOTSTRAP, 'mcp']);

/** The hook events grimoire's entries name. Frozen entry verbs. */
export type HookEvent = 'session-start' | 'pre-tool-use';

/**
 * A Claude Code exec-form hook (`.claude/settings.json`): command `node`, these
 * args. `--` ends node's own option parsing, so `--from` reaches the bootstrap
 * (spike A R3, spike C); Claude Code substitutes `${CLAUDE_PROJECT_DIR}` inside
 * the args element (R1). Frozen.
 */
export function claudeHookArgs(event: HookEvent): string[] {
  return ['-e', BOOTSTRAP, '--', '--from', '${CLAUDE_PROJECT_DIR}', 'hook', event];
}

/**
 * Codex's `[[hooks.SessionStart]]` command string. Codex runs it through the
 * session shell (PowerShell, cmd or sh) in the session cwd, so it carries no
 * `--from`; it runs unchanged under all of them (spike E R2). Frozen.
 */
export function codexHookCommand(): string {
  return `node -e "${BOOTSTRAP}" -- hook session-start`;
}

/** The join command for a pin. */
export function joinCommand(pin: string): string {
  return `npx @goksening/grimoire@${pin} init`;
}

/**
 * The not-set-up line (spec §11): printed by the bootstrap with no launcher,
 * and by the launcher and the shell shim with no copy or join record.
 */
export function notSetUpLine(pin: string): string {
  return `grimoire isn't set up on this machine; ask the user to run \`${joinCommand(pin)}\``;
}
