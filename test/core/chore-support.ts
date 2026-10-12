// Shared setup for the chore tests (seam 1; spec §16): call contexts built from
// real client artifacts (seam-2 hint and `_meta` fixtures), settled pairs made
// through the core's own ops, and a clock the tests move.
import { tmpdir } from 'node:os';
import { readFixture, readFixtureJson, type Checkout, type Clone } from '#harness';
import type { CallContext, Core, McpCallFacts } from '../../src/core';
import { preToolUse } from '../../src/surfaces/hooks/pre-tool-use';
import { metaIds, takeHint } from '../../src/surfaces/mcp/hint';
import { openTracker, type NewChoreRun } from '../../src/tracker';

interface ToolsCall {
  params: { arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };
}

export const DEBRIEF = { asked: 'fix the flaky test', tried: 'reran it', failed: 'none', worked: 'pinning the seed', next: 'none' };

/** A person at their own terminal (the human-only gate passes). */
export function terminal(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'cli', client: null, evidence: {}, tty: true };
}

/** The dashboard: a human actor. */
export function dashboard(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'dashboard', client: null, evidence: {} };
}

/**
 * An MCP call as Claude Code makes it from the context whose `PreToolUse`
 * payload is `payloadFixture` (spike C): grimoire's own hook fills the hint,
 * and the call carries `_meta` from `metaFixture`. Any `override` replaces
 * hint fields after the hook ran (a forged hint).
 */
export async function claudeCall(
  base: CallContext,
  payloadFixture: string,
  metaFixture = 'claude-code/meta/tools-call-chore-subagent.json',
  override: Record<string, unknown> = {},
  nonce = 'nonce-claude',
): Promise<CallContext> {
  const out = await preToolUse(readFixture(payloadFixture), { startDir: tmpdir() });
  const updated = (JSON.parse(out) as { hookSpecificOutput: { updatedInput: Record<string, unknown> } }).hookSpecificOutput.updatedInput;
  const args = { ...updated, _grimoire: { ...(updated._grimoire as Record<string, unknown>), ...override } };
  const { params } = readFixtureJson<ToolsCall>(metaFixture);
  const mcp: McpCallFacts = { era: 'modern', hint: takeHint(args).hint, meta: params._meta ? metaIds(params._meta) : null };
  return { ...base, surface: 'mcp', client: { name: 'claude-code', version: '2.1.296' }, evidence: {}, mcp, nonce };
}

/** The `grimoire-chores` subagent's call, its hint validated by its `_meta` (spike C, C1). */
export function choreAgent(base: CallContext): Promise<CallContext> {
  return claudeCall(base, 'claude-code/hook-payloads/pre-tool-use-chore-subagent.json');
}

/** An MCP call from Codex, its `_meta` from a real `tools/call` (spike E). */
export function codexCall(base: CallContext, fixture: string, nonce = 'nonce-codex'): CallContext {
  const { params } = readFixtureJson<ToolsCall>(fixture);
  const mcp: McpCallFacts = { era: 'legacy', hint: null, meta: params._meta ? metaIds(params._meta) : null };
  return { ...base, surface: 'mcp', client: { name: 'codex-mcp-client', version: '0.162.1' }, evidence: {}, mcp, nonce };
}

export const codexSubagent = (base: CallContext, nonce?: string) => codexCall(base, 'codex/meta/tools-call-subagent.json', nonce);
export const codexRoot = (base: CallContext, nonce?: string) => codexCall(base, 'codex/meta/tools-call.json', nonce);
/** The root session of the codex/meta/tools-call.json fixture. */
export const CODEX_ROOT_SESSION = '01a12946-7d23-7f93-b8c8-aa18d1bca5ef';

/** A generic MCP client with hooks off: nothing identifies the caller but the server process. */
export function genericCall(base: CallContext, nonce = 'nonce-generic'): CallContext {
  return { ...base, surface: 'mcp', client: { name: 'some-client' }, evidence: {}, mcp: { era: 'modern', hint: null, meta: null }, nonce };
}

/** A clock a test moves forward. */
export class Clock {
  constructor(private at: Date) {}
  readonly now = (): Date => this.at;
  advance(hours: number): void {
    this.at = new Date(this.at.getTime() + hours * 3_600_000);
  }
}

function ok<T>(outcome: { ok: true; result: T } | { ok: false; error: unknown }): T {
  if (!outcome.ok) throw new Error(`call failed: ${JSON.stringify(outcome.error)}`);
  return outcome.result;
}

/** One attempt worked to its end by `ctx`: a pass (closed as done) or a fail (released). Returns its handle. */
export async function workPair(core: Core, ctx: CallContext, verdict: 'pass' | 'fail', title = `Work ${verdict}`): Promise<string> {
  const { id } = ok(await core.call('create', { title, body: `Body of ${title}` }, ctx));
  const { attempt } = ok(await core.call('claim', { id }, ctx));
  if (verdict === 'pass') ok(await core.call('close', { id, attempt, reason: 'done', debrief: DEBRIEF }, ctx));
  else ok(await core.call('release', { id, attempt, debrief: DEBRIEF }, ctx));
  return attempt;
}

/** Writes a chore-run record onto `checkout`'s tracker, as a submit would (GOK-159 writes them through chore_submit). */
export async function commitChoreRun(checkout: Checkout, clone: Clone, record: NewChoreRun): Promise<void> {
  const tracker = await openTracker(checkout.dir);
  try {
    await tracker.transact(
      { op: 'compile', author: { name: clone.identity.name, email: clone.identity.email }, actor: { kind: 'agent', client: 'test', nonce: 'n' } },
      (draft) => {
        draft.choreRuns.add(record);
        return { result: null };
      },
    );
  } finally {
    await tracker.close();
  }
}

/** A compile run's record consuming `pairs` (`[trace, outcome]`), each to `no_pattern`. */
export function compileRecord(id: string, at: string, pairs: readonly (readonly [string, string])[], pages: Record<string, string> = {}): NewChoreRun {
  return {
    id,
    kind: 'wiki-maintainer',
    result: 'compiled',
    origin: 'session',
    isolation: 'claude-chore-agent',
    unverified: { client: null, model: null },
    actor: { person: 'alice@example.com', kind: 'agent' },
    started_at: at,
    at,
    consumption: pairs.map(([trace, outcome]) => ({ trace, outcome, slugs: Object.keys(pages), no_pattern: Object.keys(pages).length === 0 })),
    pages,
    served: [],
    consumed: [],
    proposal: null,
    reasons: [],
    pairs: [],
  };
}

/** Writes a wiki page with `sources` straight through the tracker store, as a compile would; returns its version. */
export async function putPage(checkout: Checkout, clone: Clone, slug: string, sources: string[]): Promise<string> {
  const tracker = await openTracker(checkout.dir);
  try {
    const write = await tracker.transact(
      { op: 'compile', author: { name: clone.identity.name, email: clone.identity.email }, actor: { kind: 'agent', client: 'test', nonce: 'n' } },
      async (draft) => {
        const at = draft.now.toISOString();
        const version = await draft.wiki.putPage({
          slug,
          title: `Page ${slug}`,
          kind: 'failure',
          summary: `About ${slug}`,
          sources,
          generated: at,
          verified: null,
          updated_at: at,
          body: `How ${slug} goes wrong.\n`,
          extra: {},
        });
        return { result: version };
      },
    );
    return write.result;
  } finally {
    await tracker.close();
  }
}
