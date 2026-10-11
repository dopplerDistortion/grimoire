// Spike F (GOK-131) C4 fallback: the runner keeps the user config (so the
// login is found wherever it is stored) and switches off what that config
// adds. What does `codex mcp list --json` print, to get the names from, and
// which `-c` overrides neutralize the user config's MCP servers, hooks,
// `notify` program, `developer_instructions` and model provider?
//
//   node c4-fallback.mjs <scratch-dir> <variant>
//
// The throwaway user config.toml always declares: the stand-in as
// `model_provider = "mock"`, an MCP server `usermcp`, a SessionStart hook, a
// legacy `notify` program (which records the payload it is handed) and
// `developer_instructions` carrying a marker.
//
//   on            nothing turned off
//   off           -c mcp_servers.usermcp.enabled=false -c features.hooks=false
//   off-notify    off, plus -c notify=[] -c developer_instructions=""
//   pin-provider  off-notify, plus -c model_provider="openai": does the pin beat
//                 the user config's provider? (No login, so a 401 is expected.)
//   projmcp       a trusted repo whose .codex/config.toml declares
//                 [mcp_servers.grimoire]. `mcp list --json` run in the repo lists
//                 it; run in the runner's empty temp dir it does not. The exec
//                 (in the temp dir) then disables every name the in-repo list gave.
//   final         the final runner invocation from the findings, verbatim, with
//                 `[windows] sandbox = "unelevated"` also in the user config.
//                 The one test-only addition: -c openai_base_url=<stand-in>, so
//                 the pinned openai provider reaches the stand-in.
//
// Every variant but `final` also passes --dangerously-bypass-hook-trust.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KIT, git, mkRepo, plan, providerToml, readRequests, runCodex, startMock } from './kit.mjs';

const VARIANTS = ['on', 'off', 'off-notify', 'pin-provider', 'projmcp', 'final'];
const [scratchArg = '.', variant = 'off'] = process.argv.slice(2);
if (!VARIANTS.includes(variant)) throw new Error(`variant must be one of ${VARIANTS.join(', ')}`);
const R = path.join(path.resolve(scratchArg), 'runs', `c4-fallback-${variant}`);
rmSync(R, { recursive: true, force: true });
const home = path.join(R, 'home');
mkdirSync(home, { recursive: true });
/** @param {string} p */
const fwd = (p) => p.replaceAll('\\', '/');
const mcpLog = fwd(path.join(R, 'usermcp.jsonl'));
const hookMark = fwd(path.join(R, 'hook-ran.txt'));
const notifyMark = fwd(path.join(R, 'notify-payload.json'));
const mock = await startMock(path.join(R, 'mock'));
const hookCmd = `node -e "require('fs').writeFileSync('${hookMark}', 'x')"`;
const notifyScript = `require('fs').writeFileSync('${notifyMark}', process.argv.at(-1))`;
const repo = variant === 'projmcp' ? mkRepo(path.join(R, 'repo')) : null;
writeFileSync(
  path.join(home, 'config.toml'),
  `notify = ["node", "-e", ${JSON.stringify(notifyScript)}]
developer_instructions = "GRIM-C4-USER-DEVELOPER-INSTRUCTIONS"
${providerToml(mock.port)}
[mcp_servers.usermcp]
command = "node"
args = [${JSON.stringify(fwd(path.join(KIT, 'stub-mcp.mjs')))}]
env = { GOK131_MCP_LOG = ${JSON.stringify(mcpLog)} }

[[hooks.SessionStart]]
[[hooks.SessionStart.hooks]]
type = "command"
command = ${JSON.stringify(hookCmd)}
timeout = 10
${variant === 'final' ? '\n[windows]\nsandbox = "unelevated"\n' : ''}${repo ? `\n[projects.'${repo}']\ntrust_level = "trusted"\n` : ''}`,
);
if (repo) {
  mkdirSync(path.join(repo, '.codex'), { recursive: true });
  writeFileSync(
    path.join(repo, '.codex', 'config.toml'),
    `[mcp_servers.grimoire]\ncommand = "node"\nargs = [${JSON.stringify(fwd(path.join(KIT, 'stub-mcp.mjs')))}]\n`,
  );
  git(repo, 'add', '.');
  git(repo, '-c', 'user.email=a@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'project mcp');
}

// The runner's fresh, empty temp dir.
const tmp = path.join(os.tmpdir(), `gok131-c4f-${variant}-${process.pid}`);
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp);
const schemaFile = path.join(R, 'schema.json');
const outFile = path.join(R, 'last-message.txt');
writeFileSync(
  schemaFile,
  JSON.stringify({
    type: 'object',
    properties: { verdict: { type: 'string' }, pairs: { type: 'array', items: { type: 'string' } } },
    required: ['verdict', 'pairs'],
    additionalProperties: false,
  }),
);

// The flags that switch off what the user config adds, before the MCP names.
const base = ['-c', 'features.apps=false', '-c', 'features.plugins=false'];
/** @type {Record<string, string[]>} */
const neutralize = {
  on: [],
  off: ['-c', 'features.hooks=false'],
  'off-notify': ['-c', 'features.hooks=false', '-c', 'notify=[]', '-c', 'developer_instructions=""'],
  'pin-provider': ['-c', 'features.hooks=false', '-c', 'notify=[]', '-c', 'developer_instructions=""', '-c', 'model_provider="openai"'],
  projmcp: ['-c', 'features.hooks=false', '-c', 'notify=[]', '-c', 'developer_instructions=""'],
  final: [
    '-c', 'features.hooks=false',
    '-c', 'notify=[]',
    '-c', 'developer_instructions=""',
    '-c', 'features.shell_tool=false',
    '-c', 'web_search="disabled"',
    '-c', 'skills.include_instructions=false',
    '-c', 'model_provider="openai"',
  ],
};
/**
 * `codex mcp list --json`, names only.
 * @param {string} cwd
 * @param {string[]} flags
 */
async function mcpNames(cwd, flags) {
  const r = await runCodex([...flags, 'mcp', 'list', '--json'], { cwd, home });
  /** @type {{ name: string }[]} */
  let list = [];
  try {
    list = JSON.parse(r.stdout);
  } catch {
    // reported below through the exit code
  }
  return { code: r.code, names: list.map((s) => s.name), stderr: r.stderr.trim().split('\n').slice(-3).join('\n') };
}
const flags = neutralize[variant] ?? [];
const listFlags = [...base, ...flags];
const inTmp = await mcpNames(tmp, listFlags);
const inRepo = repo ? await mcpNames(repo, listFlags) : null;
const names = variant === 'on' ? [] : (inRepo ?? inTmp).names;
const mcpOff = names.flatMap((n) => ['-c', `mcp_servers.${n}.enabled=false`]);

const args = [
  'exec',
  '--json',
  '--ephemeral',
  '--ignore-rules',
  '--skip-git-repo-check',
  // Stands for a user who trusted their own hook, so `off` shows that
  // features.hooks=false stops even a trusted one. Not part of the runner's argv.
  ...(variant === 'final' ? [] : ['--dangerously-bypass-hook-trust']),
  '--cd',
  tmp,
  '--sandbox',
  'read-only',
  '--output-schema',
  schemaFile,
  '-o',
  outFile,
  ...base,
  ...flags,
  ...mcpOff,
  ...(variant === 'final' ? ['-c', `openai_base_url="http://127.0.0.1:${mock.port}/v1"`] : []),
];
const answer = JSON.stringify({ verdict: 'no_pattern', pairs: ['pair-1'] });
const steps =
  variant === 'final'
    ? [
        { call: 'exec_command', args: { cmd: 'Get-ChildItem -Force -Name' } },
        { call: 'chore_start', ns: 'mcp__usermcp', args: {} },
        { say: answer },
      ]
    : [{ say: answer }];
const bundle = `grimoire chore bundle (stand-in)\n\n${plan(steps)}\n`;
const result = await runCodex(args, { cwd: tmp, home, stdin: bundle, timeoutMs: 120_000 });
// The legacy notify program is spawned, not awaited: give it a moment.
for (let i = 0; i < 40 && !existsSync(notifyMark) && variant !== 'off-notify'; i++) await new Promise((r) => setTimeout(r, 100));
mock.stop();
rmSync(tmp, { recursive: true, force: true });
writeFileSync(path.join(R, 'args.json'), JSON.stringify(args, null, 2));
writeFileSync(path.join(R, 'stdout.jsonl'), result.stdout);
writeFileSync(path.join(R, 'stderr.txt'), result.stderr);
const reqs = readRequests(path.join(R, 'mock')).filter((r) => r.url.includes('/responses'));
const first = JSON.stringify(reqs[0]?.body ?? {});
const last = reqs.at(-1)?.body;
/** @type {Record<string, unknown> | null} */
let notifyPayload = null;
if (existsSync(notifyMark)) {
  try {
    notifyPayload = JSON.parse(readFileSync(notifyMark, 'utf8'));
  } catch {
    notifyPayload = { unparsed: readFileSync(notifyMark, 'utf8').slice(0, 200) };
  }
}
console.log(
  JSON.stringify(
    {
      variant,
      code: result.code,
      ms: result.ms,
      mcpListInTmp: inTmp,
      mcpListInRepo: inRepo,
      disabled: names,
      userMcpStarted: existsSync(mcpLog) && readFileSync(mcpLog, 'utf8').includes('"initialize"'),
      userHookRan: existsSync(hookMark),
      notifyRan: notifyPayload !== null,
      notifyPayloadKeys: notifyPayload && Object.keys(notifyPayload),
      notifyCarriesBundle: notifyPayload !== null && JSON.stringify(notifyPayload).includes('grimoire chore bundle (stand-in)'),
      requestsToStandIn: reqs.length,
      userDeveloperInstructions: first.includes('GRIM-C4-USER-DEVELOPER-INSTRUCTIONS'),
      tools: last?.tools?.map((/** @type {{ name?: string, type?: string }} */ t) => t.name ?? t.type),
      toolOutputs: (last?.input ?? [])
        .filter((/** @type {{ type: string }} */ i) => i.type === 'function_call_output')
        .map((/** @type {{ output: string }} */ i) => String(i.output).slice(0, 160)),
      out: existsSync(outFile) ? readFileSync(outFile, 'utf8') : null,
      events: result.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).type),
      stderrTail: result.stderr.trim().split('\n').slice(-4).join('\n'),
    },
    null,
    1,
  ),
);
