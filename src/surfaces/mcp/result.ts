// How a grimoire result goes on the wire (spec §8; spikes B and E): compact
// JSON, sent as both `structuredContent` and one identical text block. Claude
// Code and Codex show the model only the compact JSON of `structuredContent`.
import type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * The hard ceiling on a result's JSON text, in UTF-8 bytes. The core cuts
 * results well under it (~24 KB, with `truncated` and a cursor); the margin is
 * for the notices this surface adds.
 */
export const RESULT_LIMIT = 24 * 1024;

/**
 * `body` as a tool result: `notices` (when any) go after the result's own
 * fields, and `truncated` and `cursor` go last, so a client that middle-cuts a
 * long output (Codex keeps the head and the tail) still shows them.
 * `notices` come most important first: rather than push a result past the
 * limit, they are dropped from the end, one at a time.
 */
export function toolResult(body: Record<string, unknown>, notices: readonly string[], isError = false): CallToolResult {
  let kept = notices.length;
  let text = JSON.stringify(arrange(body, notices));
  while (kept > 0 && Buffer.byteLength(text, 'utf8') > RESULT_LIMIT) {
    text = JSON.stringify(arrange(body, notices.slice(0, --kept)));
  }
  return {
    content: [{ type: 'text', text }],
    // Parsed back from the text, so the two can never differ (undefined fields included).
    structuredContent: JSON.parse(text) as Record<string, unknown>,
    ...(isError ? { isError: true } : {}),
  };
}

const LAST = ['truncated', 'cursor'] as const;

function arrange(body: Record<string, unknown>, notices: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!(LAST as readonly string[]).includes(key)) out[key] = value;
  }
  if (notices.length > 0) out.notices = [...notices];
  for (const key of LAST) if (key in body) out[key] = body[key];
  return out;
}
