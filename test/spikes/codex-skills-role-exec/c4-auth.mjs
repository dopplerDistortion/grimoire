// Spike F (GOK-131) C4, partial: is a saved ChatGPT-mode login in
// CODEX_HOME/auth.json still loaded when `codex exec --ignore-user-config`
// skips CODEX_HOME/config.toml? There is no real login on this machine, so the
// auth.json holds FAKE, unsigned tokens, and the stand-in provider is declared
// with requires_openai_auth = true so Codex sends that login to it. The
// stand-in logs only the Authorization scheme and length, plus the
// chatgpt-account-id header. Whether OpenAI accepts the login is not tested.
//
//   node c4-auth.mjs <scratch-dir> <ignore|plain|keyring>
//     ignore   --ignore-user-config (the runner's flags)
//     plain    without --ignore-user-config, as a control
//     keyring  --ignore-user-config, with config.toml asking for the keyring store
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { plan, readRequests, runCodex, startMock } from './kit.mjs';

const [scratchArg = '.', variant = 'ignore'] = process.argv.slice(2);
const R = path.join(path.resolve(scratchArg), 'runs', `c4-${variant}`);
rmSync(R, { recursive: true, force: true });
const home = path.join(R, 'home');
mkdirSync(home, { recursive: true });
/** @param {unknown} o */
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** @param {Record<string, unknown>} claims */
const jwt = (claims) => `${b64({ alg: 'none', typ: 'JWT' })}.${b64(claims)}.fake-signature`;
const auth = {
  'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_user_id: 'user-fake', chatgpt_account_id: 'acct-fake-0001' },
};
writeFileSync(
  path.join(home, 'auth.json'),
  JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: jwt({ email: 'fake@example.com', exp: 4102444800, ...auth }),
      access_token: jwt({ exp: 4102444800, ...auth }),
      refresh_token: 'fake-refresh-token',
      account_id: 'acct-fake-0001',
    },
    last_refresh: new Date().toISOString(),
  }),
);
const mock = await startMock(path.join(R, 'mock'));
const provider = `{ name = "mock", base_url = "http://127.0.0.1:${mock.port}/v1", wire_api = "responses", requires_openai_auth = true }`;
// The user config (skipped under --ignore-user-config) also declares the provider.
writeFileSync(
  path.join(home, 'config.toml'),
  `${variant === 'keyring' ? 'cli_auth_credentials_store = "keyring"\n' : ''}model = "gpt-5.5"\nmodel_provider = "mock"\n[model_providers.mock]\nname = "mock"\nbase_url = "http://127.0.0.1:${mock.port}/v1"\nwire_api = "responses"\nrequires_openai_auth = true\n`,
);
const tmp = path.join(os.tmpdir(), `gok131-c4-${variant}-${process.pid}`);
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp);
const args = [
  'exec',
  '--json',
  '--ephemeral',
  ...(variant === 'plain' ? [] : ['--ignore-user-config']),
  '--ignore-rules',
  '--skip-git-repo-check',
  '--cd',
  tmp,
  '--sandbox',
  'read-only',
  '-c',
  `model_providers.mock=${provider}`,
  '-c',
  'model_provider="mock"',
  '-c',
  'model="gpt-5.5"',
];
const result = await runCodex(args, { cwd: tmp, home, stdin: plan([{ say: 'ok' }]), env: { CODEX_API_KEY: '', OPENAI_API_KEY: '' } });
mock.stop();
rmSync(tmp, { recursive: true, force: true });
const reqs = readRequests(path.join(R, 'mock')).filter((r) => r.url.includes('/responses'));
console.log(
  JSON.stringify({
    variant,
    code: result.code,
    requests: reqs.length,
    auth: reqs.map((r) => r.auth),
    accountHeader: reqs.map((r) => r.headers['chatgpt-account-id'] ?? null),
    stdout: result.stdout.trim().split('\n').slice(-2),
  }),
);
