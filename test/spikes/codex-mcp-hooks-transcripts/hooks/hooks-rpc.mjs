// node hooks-rpc.mjs <codex-home> <cwd> [--trust]
// Talks to `codex app-server` over stdio the way the TUI's /hooks screen does
// (tui/src/hooks_rpc.rs): hooks/list for <cwd>, and with --trust a
// config/batchWrite upserting hooks.state.<key>.trusted_hash = currentHash for
// every untrusted or modified hook. Prints the hooks (key, hash, status).
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const [home, cwd, ...flags] = process.argv.slice(2);
const child = spawn('codex', ['app-server'], {
  cwd,
  env: { ...process.env, CODEX_HOME: home },
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});
const pending = new Map();
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
let nextId = 0;
/**
 * @param {string} method
 * @param {unknown} params
 */
function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

const init = await request('initialize', { clientInfo: { name: 'gok130_probe', title: null, version: '0.0.0' } });
if (init.error) throw new Error(JSON.stringify(init.error));
child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);

/**
 * One hook as `hooks/list` reports it (the fields this probe reads).
 * @typedef {{ key: string, eventName: string, command: string | null, currentHash: string, trustStatus: string, sourcePath: string, displayOrder: number }} Hook
 */
/**
 * One `hooks/list` entry: a cwd's hooks with its config warnings and errors.
 * @typedef {{ hooks: Hook[], warnings: unknown[], errors: unknown[] }} HooksListEntry
 */

const rawIdx = flags.indexOf('--raw');
const rawOut = rawIdx >= 0 ? flags[rawIdx + 1] : null;
let rawN = 0;
async function list() {
  const r = await request('hooks/list', { cwds: [cwd] });
  if (r.error) throw new Error(JSON.stringify(r.error));
  if (rawOut) (await import('node:fs')).writeFileSync(rawOut.replace('{n}', String(rawN++)), `${JSON.stringify(r)}
`);
  return r.result.data.flatMap((/** @type {HooksListEntry} */ e) => e.hooks.map((h) => ({ ...h, warnings: e.warnings, errors: e.errors })));
}

let hooks = await list();
/** @param {Hook[]} hs */
const show = (hs) =>
  hs.map((h) => ({ key: h.key, eventName: h.eventName, command: (h.command ?? '').slice(0, 60), currentHash: h.currentHash, trustStatus: h.trustStatus, sourcePath: h.sourcePath, displayOrder: h.displayOrder }));
console.log(JSON.stringify({ before: show(hooks) }, null, 1));
if (flags.includes('--trust')) {
  /** @type {Record<string, { trusted_hash: string }>} */
  const value = {};
  for (const h of hooks) if (h.trustStatus !== 'trusted' && h.trustStatus !== 'managed') value[h.key] = { trusted_hash: h.currentHash };
  const w = await request('config/batchWrite', {
    edits: [{ keyPath: 'hooks.state', value, mergeStrategy: 'upsert' }],
    filePath: null,
    expectedVersion: null,
    reloadUserConfig: true,
  });
  if (w.error) throw new Error(JSON.stringify(w.error));
  hooks = await list();
  console.log(JSON.stringify({ after: show(hooks) }, null, 1));
}
child.kill();
process.exit(0);
