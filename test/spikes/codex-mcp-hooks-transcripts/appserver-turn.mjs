// node appserver-turn.mjs <codex-home> <cwd> <history-mode> <prompt>
// Drives `codex app-server` over stdio: initialize (experimental API on),
// thread/start with an explicit historyMode, then one turn/start per turn of
// <prompt> (turns are separated by a line '---TURN---'). Each turn waits for
// this thread's turn/completed; a subagent thread's own turn/completed is
// ignored. Exits after the last turn. Prints the thread id and each turn's status.
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const [home, cwd, historyMode, prompt] = process.argv.slice(2);
if (prompt === undefined) {
  console.error('usage: node appserver-turn.mjs <codex-home> <cwd> <history-mode> <prompt>');
  process.exit(2);
}
const child = spawn('codex', ['app-server'], {
  cwd,
  env: { ...process.env, CODEX_HOME: home },
  stdio: ['pipe', 'pipe', 'inherit'],
  shell: process.platform === 'win32',
});
const pending = new Map();
/** @type {(msg: Record<string, any>) => void} */
let onNotification = () => {};
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && msg.method === undefined && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method) {
    onNotification(msg);
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
  return new Promise((resolve, reject) =>
    pending.set(id, (/** @type {Record<string, any>} */ m) => (m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result))),
  );
}

await request('initialize', {
  clientInfo: { name: 'gok130_probe', title: null, version: '0.0.0' },
  capabilities: { experimentalApi: true },
});
child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
const started = await request('thread/start', {
  cwd,
  historyMode,
  approvalPolicy: 'never',
  sandbox: 'danger-full-access',
});
const threadId = started.thread.id;
console.log(JSON.stringify({ threadId, historyMode: started.thread.historyMode ?? null }));
// Several turns on the same thread: prompts separated by a line '---TURN---'.
for (const text of prompt.split(/\r?\n---TURN---\r?\n/)) {
  const done = new Promise((resolve) => {
    onNotification = (msg) => {
      if (msg.method === 'turn/completed' && msg.params?.threadId === threadId) resolve(msg.params);
    };
  });
  await request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
  const completed = await done;
  console.log(JSON.stringify({ turnStatus: completed.turn?.status ?? null }));
}
child.kill();
process.exit(0);
