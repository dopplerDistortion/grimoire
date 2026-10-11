// Spike F (GOK-131): a scripted stand-in for the OpenAI Responses API, so the
// real Codex CLI runs whole turns without a login. Adapted from Spike E's
// fake-responses.mjs (GOK-130); spike scaffolding only, never part of the package.
//
// Usage: node scripted-responses.mjs <state-dir>
//   Writes <state-dir>/port once listening, and appends every request Codex
//   sends to <state-dir>/requests.jsonl ({at, method, url, headers, auth, body}).
//   The Authorization header is never logged, only its scheme and length.
//
// The model's behaviour is a PLAN embedded in the newest user message holding
// "PLAN:" (the prompt, or a spawn_agent message):
//   PLAN: [{"call":"<tool>","ns":"<namespace>","args":{...}}, {"calls":[...]},
//          {"call":"apply_patch","custom":true,"input":"<freeform>"},
//          {"search":"<tool_search query>"}, {"say":"text"},
//          {"http":500,"error":"text"}, {"failed":"text"}]
// Each request plays the next step of that plan (per thread). Past the end it
// says "done". "$AGENT" in args becomes the first thread id in the last tool
// output.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/**
 * One tool call of a step.
 * @typedef {{ call?: string, ns?: string, args?: unknown, custom?: boolean, input?: string, search?: string, limit?: number }} Call
 */
/**
 * One step of a PLAN.
 * @typedef {Call & { calls?: Call[], say?: string, http?: number, error?: string, failed?: string }} Step
 */
/**
 * A Responses API input item, as Codex sends it (only the fields read here).
 * @typedef {{ type?: string, role?: string, content?: { text?: string }[], output?: unknown, tools?: unknown }} Item
 */

const stateDir = path.resolve(process.argv[2] ?? '.');
mkdirSync(stateDir, { recursive: true });
const log = path.join(stateDir, 'requests.jsonl');
let responseSeq = 0;

/** @param {Item | undefined} item */
const textOf = (item) => (Array.isArray(item?.content) ? item.content.map((c) => c.text ?? '').join('') : '');
/** @param {Item | undefined} item */
const isOutput = (item) =>
  item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output' || item?.type === 'tool_search_output';

/** @param {Item[]} items */
function lastOutputText(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item && isOutput(item)) {
      const o = item.output ?? item.tools;
      return typeof o === 'string' ? o : JSON.stringify(o);
    }
  }
  return '';
}

/**
 * @param {unknown} value
 * @param {Item[]} items
 */
function substitute(value, items) {
  let json = JSON.stringify(value);
  if (json.includes('$AGENT')) {
    const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(lastOutputText(items));
    json = json.replaceAll('$AGENT', m ? m[0] : 'none');
  }
  return JSON.parse(json);
}

/** @type {Map<string, number>} Steps already played, per (thread, plan text). */
const played = new Map();

/**
 * @param {{ input?: Item[] }} body
 * @param {string} threadId
 * @returns {{ step: Step | null, after: Item[] }}
 */
function planStep(body, threadId) {
  const input = Array.isArray(body.input) ? body.input : [];
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (item?.type !== 'message' || item.role !== 'user') continue;
    const text = textOf(item);
    const idx = text.indexOf('PLAN:');
    if (idx < 0) continue;
    const rest = text.slice(idx + 5).trim();
    const planText = rest.slice(0, rest.lastIndexOf(']') + 1);
    /** @type {Step[]} */
    let plan;
    try {
      plan = JSON.parse(planText);
    } catch {
      plan = [{ say: 'could not parse PLAN' }];
    }
    const key = `${threadId}|${planText}`;
    const k = played.get(key) ?? 0;
    played.set(key, k + 1);
    return { step: plan[k] ?? null, after: input.slice(i + 1) };
  }
  return { step: null, after: [] };
}

/**
 * @param {string} id
 * @param {string} text
 */
const message = (id, text) => ({
  type: 'response.output_item.done',
  item: { type: 'message', role: 'assistant', id, content: [{ type: 'output_text', text }] },
});

/**
 * The SSE events answering one request.
 * @param {Step | null} step
 * @param {Item[]} after
 * @returns {{ type: string, [key: string]: unknown }[]}
 */
function events(step, after) {
  const id = `resp_${++responseSeq}`;
  /** @type {{ type: string, [key: string]: unknown }[]} */
  const out = [{ type: 'response.created', response: { id } }];
  if (step?.failed) {
    out.push({ type: 'response.failed', response: { id, error: { code: 'server_error', message: step.failed } } });
    return out;
  }
  if (step == null) {
    out.push(message(`${id}_m`, 'done'));
  } else {
    const calls = step.calls ?? (step.call || step.search ? [step] : []);
    calls.forEach((c, n) => {
      const callId = `call_${responseSeq}_${n}`;
      const item = c.search
        ? { type: 'tool_search_call', call_id: callId, execution: 'client', arguments: { query: c.search, limit: c.limit ?? 8 } }
        : c.custom
        ? { type: 'custom_tool_call', call_id: callId, name: c.call, input: c.input ?? '' }
        : {
            type: 'function_call',
            call_id: callId,
            name: c.call,
            ...(c.ns && { namespace: c.ns }),
            arguments: JSON.stringify(substitute(c.args ?? {}, after)),
          };
      out.push({ type: 'response.output_item.done', item });
    });
    if (step.say !== undefined) out.push(message(`${id}_m`, step.say));
  }
  out.push({
    type: 'response.completed',
    response: {
      id,
      usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 },
    },
  });
  return out;
}

/** @param {{ type: string }[]} evs */
const sse = (evs) => evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

const server = http.createServer((req, res) => {
  /** @type {Buffer[]} */
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = raw ? JSON.parse(raw) : null;
    } catch {
      body = { unparsed: raw.slice(0, 2000) };
    }
    const headers = { ...req.headers };
    const authHeader = headers.authorization;
    delete headers.authorization;
    const auth = authHeader ? { scheme: authHeader.split(' ')[0], length: authHeader.length } : null;
    const url = req.url ?? '';
    appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), method: req.method, url, headers, auth, body })}\n`);
    if (req.method === 'POST' && /\/responses(\?|$)/.test(url)) {
      const threadHeader = req.headers['thread-id'];
      const { step, after } = planStep(body ?? {}, typeof threadHeader === 'string' ? threadHeader : '');
      if (step?.http) {
        res.writeHead(step.http, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: step.error ?? 'scripted error', type: 'invalid_request_error', code: null } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(sse(events(step, after)));
      return;
    }
    if (req.method === 'GET' && /\/models(\?|$)/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not scripted' } }));
  });
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  writeFileSync(path.join(stateDir, 'port'), String(typeof address === 'object' && address ? address.port : ''));
});
