// NOT_WRITABLE before any effect (spec §9, §10): a CLI write from a shell that
// can't write the live store (a sandboxed agent shell) fails before it
// touches anything. Spike F: Codex's Windows sandboxes keep `.git/` read-only
// for the agent's shell (EPERM), while the `grimoire mcp` process Codex
// spawns runs outside the sandbox, so the error points the agent there.
import { randomBytes } from 'node:crypto';
import { open, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { OpDescriptor } from '../../core';
import { GrimoireError, type ErrorBody } from '../../errors';
import { findGitDirs } from '../../machine-local';

const REFUSED = new Set(['EACCES', 'EPERM', 'EROFS']);

/** The places a write creates files in, below the git common dir: the machine-local store, objects, the tracker ref and its reflog. */
const WRITTEN = [['grimoire'], ['objects'], ['refs', 'grimoire'], ['logs', 'refs', 'grimoire']];

/** `dir`, or its nearest existing ancestor that is still inside `commonDir`. */
async function existing(dir: string, commonDir: string): Promise<string> {
  let current = dir;
  while (current !== commonDir && !(await stat(current).catch(() => null))?.isDirectory()) {
    current = path.dirname(current);
  }
  return current;
}

/** Creates and removes a probe file in `dir`; the errno code when that is refused. */
async function refusal(dir: string): Promise<string | null> {
  const probe = path.join(dir, `.grimoire-probe-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    const handle = await open(probe, 'wx');
    await handle.close();
    await unlink(probe).catch(() => {});
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    return REFUSED.has(code) ? code : null;
  }
}

/** Throws NOT_WRITABLE when this process can't create files where a write of the host repo `root` would. */
export async function checkWritable(root: string): Promise<void> {
  const dirs = await findGitDirs(root);
  if (!dirs) return;
  const probed = new Set<string>();
  for (const parts of WRITTEN) {
    const dir = await existing(path.join(dirs.commonDir, ...parts), dirs.commonDir);
    if (probed.has(dir)) continue;
    probed.add(dir);
    const code = await refusal(dir);
    if (code) {
      throw new GrimoireError('NOT_WRITABLE', `this process can't write grimoire's live store: creating a file in ${dir} failed (${code}); nothing changed`, {});
    }
  }
}

/** Whether a thrown error is a refused filesystem write. */
export function refusedWrite(error: unknown): boolean {
  return REFUSED.has((error as NodeJS.ErrnoException | null)?.code ?? '');
}

const CODEX_SANDBOX = 'Codex’s sandbox keeps .git/ read-only for the agent’s shell, so CLI writes fail there';

/** Where a refused write can be made instead, for an op with no MCP tool. */
const ELSEWHERE: Readonly<Record<string, string>> = {
  sync: 'sync has no grimoire MCP tool: writes made through the grimoire MCP tools sync on their own, or a person runs `grimoire sync` outside the sandbox',
};

/** The hint a refused write of `op` gets in a Codex agent's shell (spike F): its MCP tool, when it has one. */
function codexHint(op: Pick<OpDescriptor, 'name' | 'mcp'>, verb: string): string {
  if (op.mcp) return `${CODEX_SANDBOX}; make this write with the grimoire MCP tools instead (Codex runs the grimoire MCP server outside the sandbox)`;
  return `${CODEX_SANDBOX}; ${ELSEWHERE[op.name] ?? `${verb} has no grimoire MCP tool, so a person runs it outside the sandbox`}`;
}

/** Adds the Codex sandbox hint to a refused write's error. */
export function withCodexHint(body: ErrorBody, op: Pick<OpDescriptor, 'name' | 'mcp'>, verb: string): ErrorBody {
  return { ...body, message: `${body.message}. ${codexHint(op, verb)}` };
}
