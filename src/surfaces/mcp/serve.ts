// `grimoire mcp`: the stdio MCP server process (spec §8). One per Claude Code
// session, one per Codex thread. The CLI loads this module with a dynamic
// import, so no other verb pays for the SDK; this module in turn loads the core
// only on the first tools/list or tools/call, after the opening is answered.
//
// stdout carries the protocol and nothing else; diagnostics go to stderr.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Core } from '../../core';
import { grimoireServerFactory, spawnEnvFacts } from './server';

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
  const loadCore = () => (core ??= import('../../core').then(({ createCore }) => createCore()));
  // A failure never ends the process (spec §8): a stray rejection is logged, not fatal.
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`grimoire mcp: unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`);
  });

  serveStdio(
    grimoireServerFactory({
      core: loadCore,
      startDir: startDirOf(argv, process.cwd()),
      nonce: randomBytes(8).toString('hex'),
      ...spawnEnvFacts(process.env),
      track: (call) => {
        inFlight.add(call);
        void call.finally(() => inFlight.delete(call));
      },
    }),
    { onerror: (error) => process.stderr.write(`grimoire mcp: ${error.message}\n`) },
  );

  // When the client closes stdin the transport closes. Let calls already running
  // finish (a write is never cut short), then release the core's git processes
  // so nothing holds the event loop and the process exits on its own.
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    if (core) await (await core.catch(() => null))?.close();
    // A last resort that never keeps the process alive by itself.
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.stdin.once('end', () => void shutdown());
  process.stdin.once('close', () => void shutdown());
}
