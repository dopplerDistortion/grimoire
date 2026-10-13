// Summarize a rollout: one line per JSONL line, long strings clipped.
import fs from 'node:fs';
/**
 * @param {unknown} v
 * @param {number} n
 */
const clip = (v, n) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? `${s.slice(0, n)}…[${s.length}]` : s; };
const file = process.argv[2];
if (file === undefined) {
  console.error('usage: node rsum.mjs <rollout.jsonl> [<clip-length>]');
  process.exit(2);
}
const n = Number(process.argv[3] ?? 220);
for (const line of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
  const l = JSON.parse(line);
  const p = l.payload ?? {};
  let info = '';
  if (l.type === 'session_meta') info = clip({ id: p.id, session_id: p.session_id, source: p.source, forked_from_id: p.forked_from_id, agent_nickname: p.agent_nickname, agent_role: p.agent_role, agent_path: p.agent_path, originator: p.originator, cli_version: p.cli_version, keys: Object.keys(p) }, 900);
  else if (p.type === 'function_call') info = clip({ name: p.name, ns: p.namespace, call_id: p.call_id, args: p.arguments }, n);
  else if (p.type === 'function_call_output') info = clip({ call_id: p.call_id, output: p.output }, n);
  else if (p.type === 'message') info = clip({ role: p.role, text: (p.content ?? []).map((/** @type {{ text?: string, type?: string }} */ c) => c.text ?? `[${c.type}]`).join('') }, n);
  else if (p.type === 'item_completed') info = clip({ item: p.item?.type, thread_id: p.thread_id, rest: p.item }, n);
  else info = clip(p, n);
  console.log(`${l.ordinal ?? '-'} ${l.type}:${p.type ?? ''} ${info}`);
}
