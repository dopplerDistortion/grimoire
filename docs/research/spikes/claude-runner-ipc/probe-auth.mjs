// Spike D (GOK-129) throwaway probe: `claude auth status` under the runner child's env, with variations.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const BIN = process.env.CLAUDE_BIN ?? join(homedir(), '.local', 'bin', 'claude.exe');
function childEnv({ stripSession = true, set = {}, remove = [] } = {}) {
  const env = { ...process.env };
  if (stripSession) for (const k of Object.keys(env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || ['CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_AGENT_SDK_VERSION'].includes(k)) delete env[k];
  delete env.CLAUDE_CODE_SIMPLE;
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '1';
  for (const k of remove) delete env[k];
  return Object.assign(env, set);
}
const emptyCfg = mkdtempSync(join(tmpdir(), 'grimoire-cfg-empty-'));
const helperCfg = mkdtempSync(join(tmpdir(), 'grimoire-cfg-helper-'));
writeFileSync(join(helperCfg, 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo sk-ant-api03-FAKEHELPER' }));
const cases = [
  ...Array.from({ length: 5 }, (_, i) => [`clean-${i + 1}`, {}]),
  ['inherited-session-env', { stripSession: false }],
  ['ANTHROPIC_API_KEY', { set: { ANTHROPIC_API_KEY: 'sk-ant-api03-FAKEFAKEFAKE' } }],
  ['ANTHROPIC_AUTH_TOKEN', { set: { ANTHROPIC_AUTH_TOKEN: 'fake-bearer-token' } }],
  ['CLAUDE_CODE_OAUTH_TOKEN', { set: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-FAKEFAKEFAKE' } }],
  ['CLAUDE_CODE_USE_BEDROCK', { set: { CLAUDE_CODE_USE_BEDROCK: '1' } }],
  ['CLAUDE_CODE_USE_VERTEX', { set: { CLAUDE_CODE_USE_VERTEX: '1' } }],
  ['CLAUDE_CODE_USE_FOUNDRY', { set: { CLAUDE_CODE_USE_FOUNDRY: '1' } }],
  ['CLAUDE_CODE_SIMPLE', { set: { CLAUDE_CODE_SIMPLE: '1' } }],
  ['config-dir-empty', { set: { CLAUDE_CONFIG_DIR: emptyCfg } }],
  ['config-dir-apiKeyHelper', { set: { CLAUDE_CONFIG_DIR: helperCfg } }],
];
const out = [];
for (const [name, opts] of cases) {
  const cwd = mkdtempSync(join(tmpdir(), 'grimoire-runner-'));
  const t = Date.now();
  const r = spawnSync(BIN, ['auth', 'status'], { cwd, env: childEnv(opts), windowsHide: true, encoding: 'utf8', timeout: 60000 });
  const ms = Date.now() - t;
  rmSync(cwd, { recursive: true, force: true });
  let j = null; try { j = JSON.parse(r.stdout); } catch {}
  out.push({ name, exit: r.status, ms, authMethod: j?.authMethod, apiProvider: j?.apiProvider, loggedIn: j?.loggedIn, keys: j ? Object.keys(j) : null, raw: r.stdout, stderr: r.stderr });
  console.log(JSON.stringify({ name, exit: r.status, ms, authMethod: j?.authMethod, apiProvider: j?.apiProvider, loggedIn: j?.loggedIn, apiKeySource: j?.apiKeySource, keys: j ? Object.keys(j).join(',') : r.stdout.slice(0, 200), stderr: r.stderr.slice(0, 200) }));
}
writeFileSync(join(process.argv[2] ?? '.', 'p6-auth.json'), JSON.stringify(out, null, 2));
rmSync(emptyCfg, { recursive: true, force: true });
rmSync(helperCfg, { recursive: true, force: true });
