// Spike F (GOK-131) C4 fallback: the runner keeps the user config (so the
// login is found wherever it is stored) and switches off what that config
// adds. Does `-c mcp_servers.<name>.enabled=false` keep a user MCP server from
// starting, and `-c features.hooks=false` keep a user hook from running? And
// what does `codex mcp list --json` print, to get the names from?
//
//   node c4-fallback.mjs <scratch-dir> <on|off>
//     on    the user config's MCP server and SessionStart hook left as they are
//     off   -c mcp_servers.usermcp.enabled=false -c features.hooks=false
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KIT, plan, providerToml, runCodex, startMock } from './kit.mjs';

const [scratchArg = '.', variant = 'off'] = process.argv.slice(2);
const R = path.join(path.resolve(scratchArg), 'runs', `c4-fallback-${variant}`);
rmSync(R, { recursive: true, force: true });
const home = path.join(R, 'home');
mkdirSync(home, { recursive: true });
const mcpLog = path.join(R, 'usermcp.jsonl').replaceAll('\\', '/');
const hookMark = path.join(R, 'hook-ran.txt').replaceAll('\\', '/');
const mock = await startMock(path.join(R, 'mock'));
const hookCmd = `node -e "require('fs').writeFileSync('${hookMark}', 'x')"`;
writeFileSync(
  path.join(home, 'config.toml'),
  `${providerToml(mock.port)}
[mcp_servers.usermcp]
command = "node"
args = [${JSON.stringify(path.join(KIT, 'stub-mcp.mjs').replaceAll('\\', '/'))}]
env = { GOK131_MCP_LOG = ${JSON.stringify(mcpLog)} }

[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type = "command"
command = ${JSON.stringify(hookCmd)}
timeout = 10
`,
);
const list = await runCodex(['mcp', 'list', '--json'], { cwd: R, home });
writeFileSync(path.join(R, 'mcp-list.json'), list.stdout);
const tmp = path.join(os.tmpdir(), `gok131-c4f-${variant}-${process.pid}`);
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp);
const off = variant === 'off' ? ['-c', 'mcp_servers.usermcp.enabled=false', '-c', 'features.hooks=false'] : [];
const args = [
  'exec',
  '--json',
  '--ephemeral',
  '--ignore-rules',
  '--skip-git-repo-check',
  '--dangerously-bypass-hook-trust',
  '--cd',
  tmp,
  '--sandbox',
  'read-only',
  ...off,
];
const result = await runCodex(args, { cwd: tmp, home, stdin: plan([{ say: 'ok' }]) });
mock.stop();
rmSync(tmp, { recursive: true, force: true });
console.log(
  JSON.stringify({
    variant,
    code: result.code,
    mcpListExit: list.code,
    mcpList: list.stdout.trim().slice(0, 400),
    userMcpStarted: existsSync(mcpLog) && readFileSync(mcpLog, 'utf8').includes('"initialize"'),
    userHookRan: existsSync(hookMark),
    last: result.stdout.trim().split('\n').at(-1),
  }),
);
