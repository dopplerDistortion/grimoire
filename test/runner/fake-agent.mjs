// A stand-in for `claude` and `codex` (seam 1, spec Testing Decisions: "the
// runner, against fake claude and codex executables placed on PATH that
// record their argv, env and stdin"). Run through test/harness/fake-exe.ts as
// `<dir>/<name>.mjs`. It answers from `<dir>/<name>.plan.json` and records
// every call as `<dir>/<name>.calls/<n>.json`:
//
//   plan: { auth?, login?, mcp?, answers?: [] }  each entry {stdout, stderr?, code, out?, sleepMs?}
//
// - `claude auth status …`  -> plan.auth
// - `codex login status`    -> plan.login
// - `codex … mcp list …`    -> plan.mcp
// - anything else (a run)   -> the next of plan.answers; `out` is written to the path after `-o`
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const script = process.argv[1] ?? '';
const dir = path.dirname(script);
const name = path.basename(script, '.mjs');
const argv = process.argv.slice(2);

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) stdin += chunk;

const plan = JSON.parse(readFileSync(path.join(dir, `${name}.plan.json`), 'utf8'));
const callsDir = path.join(dir, `${name}.calls`);
mkdirSync(callsDir, { recursive: true });
const earlier = readdirSync(callsDir).map((file) => JSON.parse(readFileSync(path.join(callsDir, file), 'utf8')));

const has = (/** @type {string[]} */ ...words) => words.every((word) => argv.includes(word));
const type = has('auth', 'status') ? 'auth' : has('login', 'status') ? 'login' : has('mcp', 'list') ? 'mcp' : 'answer';
const entry = type === 'answer' ? (plan.answers ?? [])[earlier.filter((call) => call.type === 'answer').length] : plan[type];

const cwd = process.cwd();
writeFileSync(
  path.join(callsDir, `${String(earlier.length).padStart(3, '0')}.json`),
  JSON.stringify({ type, argv, env: process.env, cwd, cwdEntries: existsSync(cwd) ? readdirSync(cwd) : null, stdin }),
);

if (!entry) {
  process.stderr.write(`fake ${name}: no planned answer for ${type}\n`);
  process.exit(70);
}
// A run that hangs (the kill timeout's test): it sleeps first, its pid recorded for the leak check.
if (entry.sleepMs) {
  writeFileSync(path.join(dir, `${name}.pid`), String(process.pid));
  await new Promise((resolve) => setTimeout(resolve, entry.sleepMs));
}
if (entry.out !== undefined) {
  const at = argv.indexOf('-o');
  if (at >= 0) writeFileSync(argv[at + 1] ?? '', entry.out);
}
if (entry.stderr) process.stderr.write(entry.stderr);
process.stdout.write(entry.stdout ?? '', () => process.exit(entry.code ?? 0));
