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
// 3. A `.git` file is followed (`gitdir: <path>`), then that git dir's
//    `commondir`, to the git common directory. A `.git` folder is its own.
// 4. If `<common>/grimoire/launcher.cjs` exists it calls
//    `require(launcher)(args, root)`.
// 5. Otherwise, with `<root>/.grimoire/config.yml` present, `mcp` and
//    `hook session-start` read the pin from its top-level `version:` line and
//    print the not-set-up line: stdout for session-start (exit 0), stderr for
//    `mcp` (exit 3). Other hooks print nothing and never read the file. A pin
//    that isn't `<n>.<n>.<n>[-…|+…]`, or none, gets the join command without a
//    version rather than a wrong one. With no config.yml (a checkout from
//    before the install) it exits 0 quietly.
// 6. Whatever throws in 4 or 5 fails `mcp` (exit 1, the error on stderr) but
//    never a hook: a hook exits 0 and says nothing.
//
// The text avoids `$ " \ % ^` and backticks, so it survives JSON, TOML,
// PowerShell, cmd and sh unchanged; the not-set-up line's apostrophe and
// backticks are made with String.fromCharCode, and the pin's line start is a
// lookbehind for "no printable character before `version:`" in place of `^`.
//
// It is about 820 characters, not the spec's "about 400" (a deviation the spec
// should record): it prints the not-set-up line itself and reads the pin the
// way the launcher does. Handing that off to the committed `.grimoire/run.cjs`
// instead would let a branch run code under Codex's hook approval, which is
// keyed on this exact command.

/** The bootstrap script, `node -e`'s argument. Frozen. */
export const BOOTSTRAP =
  "const f=require('fs'),p=require('path'),a=process.argv.slice(1),i=a[0]=='--from',[v,e]=i?a.slice(2):a,r=x=>f.readFileSync(x,'utf8').trim();" +
  "let d=p.resolve(i?a[1]:'.'),g,u;for(;!f.existsSync(g=d+'/.git');d=u)if((u=p.dirname(d))==d)process.exit();" +
  "try{g=p.resolve(d,r(g).slice(8));g=p.resolve(g,r(g+'/commondir'))}catch{}" +
  "const l=g+'/grimoire/launcher.cjs',y=d+'/.grimoire/config.yml';" +
  "try{if(f.existsSync(l))require(l)(a,d);else if(f.existsSync(y)&&(v=='mcp'||e=='session-start')){" +
  "const[s,b]=String.fromCharCode(39,96),k=r(y).match(/(?<![ -~])version:[ -']*([0-9]+[.][0-9]+[.][0-9]+([-+][(-~]*)?)(?![(-~])/)," +
  "m='grimoire isn'+s+'t set up on this machine; ask the user to run '+b+'npx @goksening/grimoire'+(k?'@'+k[1]:'')+' init'+b;" +
  "v=='mcp'?(console.error(m),process.exitCode=3):console.log(m)}}catch(x){if(v!='hook')throw x}";

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

/** The join command for a pin; null (a pin that can't be named) leaves the version out. */
export function joinCommand(pin: string | null): string {
  return `npx @goksening/grimoire${pin === null ? '' : `@${pin}`} init`;
}

/**
 * The not-set-up line (spec §11): printed by the bootstrap with no launcher,
 * and by the launcher and the shell shim with no copy or join record.
 */
export function notSetUpLine(pin: string | null): string {
  return `grimoire isn't set up on this machine; ask the user to run \`${joinCommand(pin)}\``;
}
