// Shared setup for uninstall's seam-1 tests (uninstall-removal.test.ts,
// uninstall.test.ts): a host repo with the person's own content in the files
// grimoire writes into, installed with `init --yes` in process and committed.
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Clone } from '#harness';
import { initIn } from './init-rules-support';

/** The person's `.claude/settings.json`, before grimoire. */
export const USER_SETTINGS = {
  model: 'opus',
  permissions: { allow: ['Bash(npm test)'] },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo checked' }] }] },
};
export const USER_AGENTS = '# Agents\n\nRun the tests before you commit.\n';
export const USER_TOML = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n';
export const USER_PACKAGE = { name: 'host', private: true, scripts: { test: 'vitest' } };

/** JSON as grimoire writes it back: two-space indent and a final newline. */
export function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function put(root: string, relative: string, text: string): Promise<void> {
  const file = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

/**
 * Commits the person's own files in `clone`, then installs grimoire there
 * (`init --yes`: both clients, the adapter doc, the npm script) and commits
 * and pushes what it wrote. Returns both commits.
 */
export async function installedRepo(clone: Clone): Promise<{ before: string; installed: string }> {
  await put(clone.dir, '.claude/settings.json', jsonText(USER_SETTINGS));
  await put(clone.dir, 'AGENTS.md', USER_AGENTS);
  await put(clone.dir, '.codex/config.toml', USER_TOML);
  await put(clone.dir, 'package.json', jsonText(USER_PACKAGE));
  await clone.git(['add', '-A']);
  await clone.git(['commit', '--quiet', '-m', 'host files']);
  const before = await clone.git(['rev-parse', 'HEAD']);
  await initIn(clone.dir);
  await clone.git(['add', '-A']);
  await clone.git(['commit', '--quiet', '-m', 'install grimoire']);
  await clone.git(['push', '--quiet', 'origin', 'HEAD']);
  return { before, installed: await clone.git(['rev-parse', 'HEAD']) };
}

/** Paths git reports as changed or untracked against `commit`, untracked files one by one. */
export async function differences(clone: { git(args: readonly string[]): Promise<string> }, commit: string): Promise<string[]> {
  const changed = await clone.git(['diff', '--name-only', commit]);
  const untracked = await clone.git(['ls-files', '--others', '--exclude-standard']);
  return [...changed.split('\n'), ...untracked.split('\n')].filter((line) => line !== '').sort();
}

export { put };
