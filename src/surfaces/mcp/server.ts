// The MCP surface (spec §8): one low-level SDK `Server` per connection, built by
// a factory `serveStdio` may call twice (a discarded `server/discover` probe), so
// the factory does no I/O. The core loads on the first tools/list or tools/call,
// after the opening is answered. Thin: transport and gating only.
import path from 'node:path';
import {
  CLIENT_INFO_META_KEY,
  Server,
  type CallToolRequest,
  type CallToolResult,
  type McpServerFactory,
  type ServerContext,
  type Tool,
} from '@modelcontextprotocol/server';
import type { CallContext, ClientInfo, Core } from '../../core';
import { findHostRoot, readCheckoutConfig, readPerson } from '../../core/host';
import { GrimoireError, invalid, type ErrorBody } from '../../errors';
import { SERVER_INSTRUCTIONS } from '../../instructions';
import { VERSION } from '../../version';
import { metaIds, takeHint } from './hint';
import { toolResult } from './result';

/** What the surface needs from the core. */
export type McpCore = Pick<Core, 'ops' | 'call'>;

export interface McpDeps {
  /** The core, loaded once on first use. */
  readonly core: () => Promise<McpCore>;
  /** Where the client started the server: `--from`, else the spawn cwd. */
  readonly startDir: string;
  /** This process's nonce. */
  readonly nonce: string;
  /**
   * The spawn env's session id (`CLAUDE_CODE_SESSION_ID`, which Claude Code
   * gives its MCP servers; Codex gives none). Recorded as the actor's
   * `spawn_env`; it goes stale after a `/clear`, so it is never trusted alone.
   */
  readonly spawnEnvId?: string;
  /** Told about every tools/call as it starts, so the process can let running calls finish before it exits. */
  readonly track?: (call: Promise<unknown>) => void;
}

/** Connection facts the server keeps from its spawn env: ids only (spec §8, §14). */
export function spawnEnvFacts(env: NodeJS.ProcessEnv): Pick<McpDeps, 'spawnEnvId'> {
  const id = env.CLAUDE_CODE_SESSION_ID?.trim();
  return id ? { spawnEnvId: id } : {};
}

export function grimoireServerFactory(deps: McpDeps): McpServerFactory {
  return ({ era }) => {
    const server = new Server(
      { name: 'grimoire', version: VERSION },
      { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
    );

    server.setRequestHandler('tools/list', async () => {
      const core = await deps.core();
      // Only agent ops are ever offered; human-only, human-read and internal ops never are (spec §7).
      const tools: Tool[] = core.ops
        .filter((op) => op.policy === 'agent')
        .map((op) => ({
          name: op.name,
          description: op.description,
          inputSchema: op.inputSchema as Tool['inputSchema'],
          annotations: { ...op.annotations },
        }));
      return { tools };
    });

    /** The connecting client, from `initialize` (2025 era) or the request envelope (2026-07-28). */
    const clientOf = (envelope: Record<string, unknown> | undefined): ClientInfo | null => {
      const info = era === 'legacy' ? server.getClientVersion() : envelope?.[CLIENT_INFO_META_KEY];
      if (!info || typeof info !== 'object') return null;
      const { name, version } = info as { name?: unknown; version?: unknown };
      if (typeof name !== 'string' || name === '') return null;
      return typeof version === 'string' ? { name, version } : { name };
    };

    /** Runs one call; `notices` collects what the result must also say, errors included. */
    const callTool = async (
      request: CallToolRequest,
      extra: ServerContext,
      notices: string[],
    ): Promise<CallToolResult> => {
      const { name } = request.params;
      // Before anything validates the arguments: take the reserved key out (spec §8, T2).
      const { input, hint } = takeHint(request.params.arguments);
      const core = await deps.core();
      const op = core.ops.find((candidate) => candidate.name === name);
      if (op?.policy === 'human-only' || op?.policy === 'human-read') {
        // Never offered here (spec §7); the message names no agent markers.
        throw new GrimoireError(
          'HUMAN_ONLY',
          `${name} is for a person only, in the dashboard or an interactive terminal; ask the user to do it`,
        );
      }
      if (op?.policy !== 'agent') {
        throw invalid({ name: 'is not a grimoire tool' }, `there is no grimoire tool named ${name}`);
      }
      const root = await findHostRoot(deps.startDir);
      const config = await readCheckoutConfig(root);
      const ctx: CallContext = {
        surface: 'mcp',
        repo: { root, pin: config?.pin ?? null, installFormat: config?.installFormat ?? null },
        person: await readPerson(root),
        client: clientOf(extra.mcpReq.envelope as Record<string, unknown> | undefined),
        evidence: deps.spawnEnvId ? { spawnEnvId: deps.spawnEnvId } : {},
        mcp: { era, hint, meta: metaIds(extra.mcpReq._meta) },
        nonce: deps.nonce,
      };
      notices.push(...noticesFor(root, deps.startDir, config?.pin ?? null));
      const outcome = await core.call(name, input, ctx);
      return outcome.ok
        ? toolResult(outcome.result as Record<string, unknown>, notices)
        : toolResult({ error: outcome.error }, notices, true);
    };

    // A per-call failure never ends the process, and never reaches the client as
    // a protocol error: the SDK would answer a throw with JSON-RPC -32603.
    server.setRequestHandler('tools/call', (request, extra) => {
      const notices: string[] = [];
      const call = callTool(request, extra, notices).catch((error: unknown) =>
        toolResult({ error: errorBody(error) }, notices, true),
      );
      deps.track?.(call);
      return call;
    });

    return server;
  };
}

/**
 * What every result of this call also says (spec §8, Other server output): a
 * checkout that moved to another pin since this process started, and a server
 * launched below the repo root (whose client then misses grimoire's pointer
 * files). Most important first: the restart notice, which every result must
 * carry, is the last a cut result gives up.
 */
function noticesFor(root: string, startDir: string, pin: string | null): string[] {
  const notices: string[] = [];
  if (pin !== null && pin !== VERSION) notices.push(`this checkout now pins ${pin}; this session runs ${VERSION}; restart it`);
  const below = path.relative(root, path.resolve(startDir));
  if (below !== '') {
    notices.push(
      `grimoire was launched in ${below.split(path.sep).join('/')}, below the repo root; launch the agent client from the repo root so grimoire's hooks, skills and instructions load`,
    );
  }
  return notices;
}

/** The envelope for a failure outside the core's own outcomes: grimoire's errors as they are, anything else as INTERNAL (ADR 0012). */
function errorBody(error: unknown): ErrorBody {
  if (error instanceof GrimoireError) return error.toBody();
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`grimoire mcp: ${error instanceof Error && error.stack ? error.stack : message}\n`);
  return {
    code: 'INTERNAL',
    message: `grimoire failed unexpectedly (${message}); re-read the issue before retrying, and tell the user if it keeps happening`,
    retryable: false,
    details: {},
  };
}
