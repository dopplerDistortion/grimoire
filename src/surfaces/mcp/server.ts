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
import { GrimoireError, invalid } from '../../errors';
import { SERVER_INSTRUCTIONS } from '../../instructions';
import { errorBodyOf } from '../internal';
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
  /** `GRIMOIRE_CHORE_ORIGIN` from the spawn env: `scheduled` restricts chore runs to the Wiki Maintainer (spec §16). */
  readonly choreOrigin?: string;
  /** Told about every tools/call as it starts, so the process can let running calls finish before it exits. */
  readonly track?: (call: Promise<unknown>) => void;
  /** Told the connecting client once a request names it (tools/list or tools/call): the process record notes it. */
  readonly onClient?: (client: ClientInfo) => void;
  /**
   * Told once the opening is done: the 2025-era `initialized` notification, or
   * the first tools/list or tools/call (the 2026-07-28 era has no handshake).
   * Upkeep starts after it (spec §13).
   */
  readonly onOpened?: () => void;
}

/** Connection facts the server keeps from its spawn env: ids only (spec §8, §14). */
export function spawnEnvFacts(env: NodeJS.ProcessEnv): Pick<McpDeps, 'spawnEnvId' | 'choreOrigin'> {
  const id = env.CLAUDE_CODE_SESSION_ID?.trim();
  const origin = env.GRIMOIRE_CHORE_ORIGIN?.trim();
  return { ...(id ? { spawnEnvId: id } : {}), ...(origin ? { choreOrigin: origin } : {}) };
}

export function grimoireServerFactory(deps: McpDeps): McpServerFactory {
  /** Codex sessions this process already told about the hook's approval (once each). */
  const announced = new Set<string>();
  return ({ era }) => {
    const server = new Server(
      { name: 'grimoire', version: VERSION },
      { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
    );

    server.oninitialized = () => deps.onOpened?.();

    server.setRequestHandler('tools/list', async (_request, extra) => {
      deps.onOpened?.();
      noteClient(clientOf(extra.mcpReq.envelope as Record<string, unknown> | undefined));
      const core = await deps.core();
      // Only agent ops are ever offered, and only those the registry marks as MCP tools (spec §7, §8).
      const tools: Tool[] = core.ops
        .filter((op) => op.mcp)
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

    let clientNoted = false;
    /** Hands the connecting client to `deps.onClient` the first time a request names one. */
    const noteClient = (client: ClientInfo | null): void => {
      if (clientNoted || client === null || !deps.onClient) return;
      clientNoted = true;
      deps.onClient(client);
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
      const client = clientOf(extra.mcpReq.envelope as Record<string, unknown> | undefined);
      noteClient(client);
      const core = await deps.core();
      const op = core.ops.find((candidate) => candidate.name === name);
      if (op?.policy === 'human-only' || op?.policy === 'human-read') {
        // Never offered here (spec §7); the message names no agent markers.
        throw new GrimoireError(
          'HUMAN_ONLY',
          `${name} is for a person only, in the dashboard or an interactive terminal; ask the user to do it`,
        );
      }
      if (!op?.mcp) {
        throw invalid({ name: 'is not a grimoire tool' }, `there is no grimoire tool named ${name}`);
      }
      const root = await findHostRoot(deps.startDir);
      const config = await readCheckoutConfig(root);
      const ctx: CallContext = {
        surface: 'mcp',
        repo: { root, pin: config?.pin ?? null, installFormat: config?.installFormat ?? null },
        person: await readPerson(root),
        client,
        evidence: deps.spawnEnvId ? { spawnEnvId: deps.spawnEnvId } : {},
        mcp: { era, hint, meta: metaIds(extra.mcpReq._meta) },
        ...(deps.choreOrigin ? { choreOrigin: deps.choreOrigin } : {}),
        nonce: deps.nonce,
      };
      notices.push(...noticesFor(root, deps.startDir, config?.pin ?? null));
      const unapproved = await codexHookNotice(root, client, ctx.mcp?.meta ?? null, announced).catch(() => null);
      if (unapproved) notices.push(unapproved);
      const outcome = await core.call(name, input, ctx);
      return outcome.ok
        ? toolResult(outcome.result as Record<string, unknown>, notices)
        : toolResult({ error: outcome.error }, notices, true);
    };

    // A per-call failure never ends the process, and never reaches the client as
    // a protocol error: the SDK would answer a throw with JSON-RPC -32603.
    server.setRequestHandler('tools/call', (request, extra) => {
      deps.onOpened?.();
      const notices: string[] = [];
      const call = callTool(request, extra, notices).catch((error: unknown) =>
        toolResult({ error: errorBodyOf(error, (line) => process.stderr.write(`grimoire mcp: ${line}\n`)) }, notices, true),
      );
      deps.track?.(call);
      return call;
    });

    return server;
  };
}

/** What a Codex session hears when grimoire's SessionStart hook didn't run for it (spec §21, Codex re-approval). */
export const CODEX_HOOK_NOTICE =
  'Codex will skip grimoire’s hook until you approve it in `/hooks`, once per clone of this repo; Codex runs the main checkout’s .codex/ in every linked worktree';

/**
 * Once per Codex session: when its SessionStart hook left no mark (the
 * transcript root it reveals, keyed by the session id `_meta` carries),
 * Codex skipped the hook, so the session is told to approve it. Null for
 * every other client and call.
 */
async function codexHookNotice(
  root: string,
  client: ClientInfo | null,
  meta: Readonly<Record<string, unknown>> | null,
  announced: Set<string>,
): Promise<string | null> {
  const turn = meta?.['x-codex-turn-metadata.session_id'];
  const session = typeof turn === 'string' ? turn : client?.name.startsWith('codex') && typeof meta?.sessionId === 'string' ? meta.sessionId : null;
  if (session === null || announced.has(session)) return null;
  // Taken before any await: two calls of one session at once still announce once.
  announced.add(session);
  const [{ locateMachineLocalStore }, { revealedRoot }] = await Promise.all([import('../../machine-local'), import('../../capture/transcript-roots')]);
  const store = await locateMachineLocalStore(root);
  if (!store) return null;
  const mark = await revealedRoot(store, session).catch(() => undefined);
  return mark?.client === 'codex' ? null : CODEX_HOOK_NOTICE;
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
