// `grimoire mcp`: the stdio MCP server process (spec §8). One per Claude Code
// session, one per Codex thread. The CLI loads this module with a dynamic
// import, so no other verb pays for the SDK; this module in turn loads the core
// only on the first tools/list or tools/call, after the opening is answered.
//
// stdout carries the protocol and nothing else; diagnostics go to stderr.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { ClientInfo, Core } from '../../core';
import type { UpkeepLoop } from '../../upkeep';
import { grimoireServerFactory, spawnEnvFacts } from './server';

/** Upkeep starts this long after the opening, so the first calls go first (spec §13: after the handshake). */
const UPKEEP_AFTER_OPENING_MS = 1_000;
/** A client that never finishes an opening still gets upkeep this long after the start. */
const UPKEEP_FALLBACK_MS = 5_000;

/**
 * The start directory from `--from <dir>` (or `--from=<dir>`), else the spawn
 * cwd. Every other argument is ignored, so a newer launcher's flags never stop
 * an older server (spec §8).
 */
function startDirOf(argv: readonly string[], cwd: string): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--from=') && arg.length > '--from='.length) return path.resolve(cwd, arg.slice('--from='.length));
    if (arg === '--from' && argv[i + 1] !== undefined) return path.resolve(cwd, argv[i + 1]!);
  }
  return cwd;
}

export async function runMcp(argv: readonly string[]): Promise<void> {
  let core: Promise<Core> | null = null;
  const inFlight = new Set<Promise<unknown>>();
  const startDir = startDirOf(argv, process.cwd());
  const nonce = randomBytes(8).toString('hex');
  let client: ClientInfo | null = null;
  let closing = false;

  // Upkeep (spec §13): after the opening, then every 30 min, on the side of every call.
  let upkeep: Promise<UpkeepLoop | null> | null = null;
  const startUpkeep = () => {
    if (upkeep !== null || closing) return;
    upkeep = startUpkeepLoop(startDir, nonce, () => client).catch((error: unknown) => {
      process.stderr.write(`grimoire mcp: upkeep didn't start: ${error instanceof Error ? error.message : String(error)}\n`);
      return null;
    });
  };
  let opened = false;
  const onOpened = () => {
    if (opened) return;
    opened = true;
    setTimeout(startUpkeep, UPKEEP_AFTER_OPENING_MS).unref();
  };
  setTimeout(startUpkeep, UPKEEP_FALLBACK_MS).unref();
  const loadCore = () => (core ??= import('../../core').then(({ createCore }) => createCore()));
  // A failure never ends the process (spec §8): a stray rejection is logged, not fatal.
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`grimoire mcp: unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`);
  });

  serveStdio(
    grimoireServerFactory({
      core: loadCore,
      startDir,
      nonce,
      ...spawnEnvFacts(process.env),
      track: (call) => {
        inFlight.add(call);
        void call.finally(() => inFlight.delete(call));
      },
      // The record the launcher's entry started for this server (./process-record.ts) learns its client.
      onClient: (info) => {
        client = info;
        void import('./process-record').then(({ noteServerClient }) => noteServerClient(info.name)).catch(() => {});
      },
      onOpened,
    }),
    { onerror: (error) => process.stderr.write(`grimoire mcp: ${error.message}\n`) },
  );

  // When the client closes stdin the transport closes. Let calls already running
  // finish (a write is never cut short), then release the core's git processes
  // so nothing holds the event loop and the process exits on its own.
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    // No new upkeep parts; the one running finishes (its writes are whole), within a bound.
    const stopping = upkeep?.then((loop) => loop?.stop(2_000));
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    await stopping;
    if (core) await (await core.catch(() => null))?.close();
    // A last resort that never keeps the process alive by itself.
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.stdin.once('end', () => void shutdown());
  process.stdin.once('close', () => void shutdown());
}

/** Starts upkeep for the checkout the server runs from; null outside a checkout. */
async function startUpkeepLoop(startDir: string, nonce: string, client: () => ClientInfo | null): Promise<UpkeepLoop | null> {
  const [{ findHostRoot }, { startUpkeep }] = await Promise.all([import('../../core/host'), import('../../upkeep')]);
  const root = await findHostRoot(startDir).catch(() => null);
  if (root === null) return null;
  const say = (line: string) => process.stderr.write(`${line}\n`);
  return startUpkeep({
    root,
    surface: 'mcp',
    nonce,
    client,
    ...(process.env.GRIMOIRE_DEBUG ? { debug: (line: string) => say(`grimoire ${line}`) } : {}),
    onReport: (report) => report.notices.forEach(say),
  });
}
