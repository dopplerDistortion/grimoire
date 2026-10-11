// Scripted stand-in for the OpenAI Responses API, so the real Codex CLI can run
// whole turns (tool calls, subagents, compaction) without a login.
//
// Usage: node fake-responses.mjs <state-dir>
//   Writes <state-dir>/port once listening, and appends every request Codex
//   sends to <state-dir>/requests.jsonl ({at, method, url, headers, body}).
//
// The model's behaviour is a PLAN embedded in the prompt:
//   PLAN: [{"call":"<tool>","args":{...}}, {"calls":[...]}, {"say":"text"}]
// For each request, the server finds the newest user message holding "PLAN:"
// and plays the next step of that plan for that thread: it counts the requests
// already answered per (thread-id header, plan text), not the tool outputs.
// Past the end it says "done". The input items after the plan message are used
// only to fill in "$SESSION" (the last "session ID N") and "$AGENT" (the last
// thread id). A step may carry "tokens": N to report N total tokens (to trigger
// auto-compaction). A request whose x-codex-turn-metadata request_kind is
// "compaction" gets a summary and doesn't advance the plan.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const stateDir = path.resolve(process.argv[2] ?? '.');
mkdirSync(stateDir, { recursive: true });
const log = path.join(stateDir, 'requests.jsonl');
let responseSeq = 0;

/**
 * A Responses API input item, a request body, or a PLAN step: loose JSON.
 * @typedef {Record<string, any>} Json
 */
/**
 * One server-sent event: its `type` names the event, the rest is its payload.
 * @typedef {{ type: string, [key: string]: unknown }} SseEvent
 */

/** @param {Json | null | undefined} item */
function textOf(item) {
  if (!item || !Array.isArray(item.content)) return '';
  return item.content.map((/** @type {{ text?: string }} */ c) => c.text ?? '').join('');
}

/** @param {Json | undefined} item */
function isOutput(item) {
  return item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output' || item?.type === 'tool_search_output';
}

/** @param {Json[]} items */
function lastOutputText(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    if (isOutput(items[i])) {
      const o = items[i]?.output;
      return typeof o === 'string' ? o : JSON.stringify(o);
    }
  }
  return '';
}

/**
 * @param {unknown} value
 * @param {Json[]} items
 */
function substitute(value, items) {
  let json = JSON.stringify(value);
  const last = lastOutputText(items);
  if (json.includes('$SESSION')) {
    const m = /session ID (\d+)/i.exec(last);
    json = json.replaceAll('"$SESSION"', m?.[1] ?? '0');
  }
  if (json.includes('$AGENT')) {
    const m = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(last);
    json = json.replaceAll('$AGENT', m ? m[0] : 'none');
  }
  return JSON.parse(json);
}

/** Steps already played, per (thread, plan text): each request plays the next. */
/** @type {Map<string, number>} */
const played = new Map();

/**
 * @param {Json} body
 * @param {string | string[]} threadId
 * @returns {{ step: Json | null, after: Json[] }}
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

/** @param {import('node:http').IncomingHttpHeaders} headers */
function requestKind(headers) {
  try {
    return JSON.parse(/** @type {string | undefined} */ (headers['x-codex-turn-metadata']) ?? '{}').request_kind ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {Json} body
 * @param {import('node:http').IncomingHttpHeaders} headers
 */
function events(body, headers) {
  const id = `resp_${++responseSeq}`;
  /** @type {SseEvent[]} */
  const out = [{ type: 'response.created', response: { id } }];
  let tokens = 0;
  if (requestKind(headers) === 'compaction') {
    out.push(message(`${id}_m`, 'SUMMARY: the user asked for scripted probe calls; all ran.'));
  } else {
    const { step, after } = planStep(body, headers['thread-id'] ?? '');
    if (step == null) {
      out.push(message(`${id}_m`, 'done'));
    } else {
      tokens = step.tokens ?? 0;
      /** @type {Json[]} */
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
      if (step.say) out.push(message(`${id}_m`, step.say));
    }
  }
  out.push({
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: tokens,
        input_tokens_details: null,
        output_tokens: 0,
        output_tokens_details: null,
        total_tokens: tokens,
      },
    },
  });
  return out;
}

/**
 * @param {string} id
 * @param {string} text
 */
function message(id, text) {
  return {
    type: 'response.output_item.done',
    item: { type: 'message', role: 'assistant', id, content: [{ type: 'output_text', text }] },
  };
}

/** @param {SseEvent[]} evs */
function sse(evs) {
  return evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

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
    delete headers.authorization;
    appendFileSync(
      log,
      `${JSON.stringify({ at: new Date().toISOString(), method: req.method, url: req.url, headers, body })}\n`,
    );
    if (req.method === 'POST' && /\/responses(\?|$)/.test(req.url ?? '')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.end(sse(events(body ?? {}, req.headers)));
      return;
    }
    if (req.method === 'GET' && /\/models(\?|$)/.test(req.url ?? '')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [] }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not scripted' } }));
  });
});

server.listen(0, '127.0.0.1', () => {
  writeFileSync(path.join(stateDir, 'port'), String(/** @type {import('node:net').AddressInfo} */ (server.address()).port));
});
