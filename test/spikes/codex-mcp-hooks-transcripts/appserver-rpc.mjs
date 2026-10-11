// node appserver-rpc.mjs <codex-home> <cwd> <wait-ms> <method> [<params-json>] [<method> [<params-json>]]...
// Sends each request to `codex app-server` in order (experimental API on),
// prints each response, then waits <wait-ms> before exiting (for background
// workers such as rollout/compress).
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const [home, cwd, waitMs, ...rest] = process.argv.slice(2);
/** @type {{ method: string, params: unknown }[]} */
const calls = [];
for (let i = 0; i < rest.length; i++) {
  const method = /** @type {string} */ (rest[i]);
  /** @type {unknown} */
  let params;
  const next = rest[i + 1];
  if (next !== undefined && /^[{[]/.test(next)) {
    i++;
    params = JSON.parse(next);
  }
  calls.push({ method, params });
}
const child = spawn('codex', ['app-server'], {
  cwd,
  env: { ...process.env, CODEX_HOME: home },
  stdio: ['pipe', 'pipe', 'inherit'],
  shell: process.platform === 'win32',
});
const pending = new Map();
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && msg.method === undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  } catch {}
});
let nextId = 0;
/**
 * @param {string} method
 * @param {unknown} [params]
 */
const request = (method, params) => {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify(params === undefined ? { id, method } : { id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
};
await request('initialize', { clientInfo: { name: 'gok130_probe', title: null, version: '0.0.0' }, capabilities: { experimentalApi: true } });
child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
for (const { method, params } of calls) {
  const r = await request(method, params);
  console.log(method, JSON.stringify(r.error ?? r.result).slice(0, 400));
}
await new Promise((r) => setTimeout(r, Number(waitMs)));
child.kill();
process.exit(0);
