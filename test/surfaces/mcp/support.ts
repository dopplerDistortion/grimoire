// Seam 3 (spec Testing Decisions): the real `grimoire mcp`, built exactly as
// `npm run build` builds it, driven over stdio by the MCP SDK client in both eras.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect } from 'vitest';
import { makeTempDir, removeDir, runCommand } from '#harness';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** The environment a developer's shell would give `npm run build`, minus Vitest's markers. */
function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== 'NODE_ENV' && !key.startsWith('VITEST')) env[key] = value;
  }
  return env;
}

/** Builds the CLI bundle into a temp `dist/`; returns the bin's path and a cleanup. */
export async function buildGrimoire(): Promise<{ bin: string; cleanup: () => Promise<void> }> {
  const dir = await makeTempDir('grimoire-mcp-build-');
  const dist = path.join(dir, 'dist');
  const result = await runCommand(
    process.execPath,
    [path.join(repoRoot, 'scripts', 'build.mjs'), 'cli', '--out-dir', dist],
    { cwd: repoRoot, env: buildEnv() },
  );
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return { bin: path.join(dist, 'grimoire.mjs'), cleanup: () => removeDir(dir) };
}

export type Era = 'legacy' | 'modern';

export interface ConnectOptions {
  /** The spawn cwd (the client's working directory). */
  cwd: string;
  /** Extra arguments after `mcp`. */
  args?: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawns `node <bin> mcp` and connects an SDK client: `legacy` initializes at
 * 2025-06-18 the way Codex does, `modern` negotiates 2026-07-28 the way Claude
 * Code does.
 */
export async function connect(bin: string, era: Era, options: ConnectOptions): Promise<Client> {
  const client =
    era === 'legacy'
      ? new Client(
          { name: 'codex-mcp-client', version: '0.162.1' },
          { capabilities: { elicitation: {} }, supportedProtocolVersions: ['2025-06-18'] },
        )
      : new Client(
          { name: 'claude-code', version: '2.1.296' },
          { versionNegotiation: { mode: { pin: '2026-07-28' } } },
        );
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [bin, 'mcp', ...(options.args ?? [])],
      cwd: options.cwd,
      env: { ...(process.env as Record<string, string>), ...(options.env as Record<string, string>) },
      stderr: 'pipe',
    }),
  );
  return client;
}

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> };
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * Writes raw JSON-RPC lines to a fresh `grimoire mcp`, exactly as given, and
 * collects the response to every request among them, by id.
 */
export function rawSession(bin: string, cwd: string, lines: string[]): Promise<Map<string | number, JsonRpcMessage>> {
  const pending = new Set(
    lines
      .map((line) => JSON.parse(line) as JsonRpcMessage)
      .filter((message) => message.method !== undefined && message.id !== undefined)
      .map((message) => message.id!),
  );
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, 'mcp'], { cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const responses = new Map<string | number, JsonRpcMessage>();
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no response to ${[...pending].join(', ')}`));
    }, 30_000);
    let buffered = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffered.slice(0, newline)) as JsonRpcMessage;
        buffered = buffered.slice(newline + 1);
        if (message.id === undefined || message.method !== undefined) continue;
        responses.set(message.id, message);
        pending.delete(message.id);
      }
      if (pending.size === 0) {
        clearTimeout(timer);
        child.stdin.end();
        resolve(responses);
      }
    });
    child.on('error', reject);
    for (const line of lines) child.stdin.write(`${line}\n`);
  });
}

/** Runs `body` against a fresh connection in each era, closing each after. */
export async function inBothEras<T>(
  bin: string,
  options: ConnectOptions,
  body: (client: Client, era: Era) => Promise<T>,
): Promise<Record<Era, T>> {
  const results: Partial<Record<Era, T>> = {};
  for (const era of ['legacy', 'modern'] as const) {
    const client = await connect(bin, era, options);
    try {
      results[era] = await body(client, era);
    } finally {
      await client.close();
    }
  }
  return results as Record<Era, T>;
}
