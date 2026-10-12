// Shared setup for generated output's seam-1 tests (spec Testing Decisions:
// generated output across several worktrees): a clone whose tracker holds
// evolved skills, worktrees pinned to the version under test or to another,
// and what each one holds afterwards.
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from 'vitest';
import type { Checkout } from '#harness';
import type { CallContext, Core } from '../../src/core';
import { pin } from '../upkeep/support';

/** A human at an interactive terminal: the CLI with no agent marker and a TTY. */
export function terminal(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'cli', client: null, evidence: {}, tty: true };
}

export function skillText(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

export const NOTES_DESCRIPTION = 'Write a release note for a change. Use when the user asks to record a change in the notes.';
export const NOTES = skillText('release-notes', NOTES_DESCRIPTION, '# Release notes\n\nCreate `changes/<slug>.md` with `kind:` and `summary:` lines.\n');
export const NOTES_V2 = skillText(
  'release-notes',
  NOTES_DESCRIPTION,
  '# Release notes\n\nCreate `changes/<slug>.md` with `kind:` and `summary:` lines.\nNever edit `CHANGELOG.md`: it is generated.\n',
);

/** `skill_edit` at a terminal; throws unless it committed. */
export async function editSkill(core: Core, ctx: CallContext, input: Record<string, unknown>) {
  const result = await core.call('skill_edit', input, terminal(ctx));
  if (!result.ok) throw new Error(`skill_edit failed: ${JSON.stringify(result.error)}`);
  return result.result;
}

/** Commits `.grimoire/config.yml` pinning `version` in `checkout`, as `init` leaves it. */
export async function pinAndCommit(checkout: Checkout, version?: string): Promise<void> {
  await pin(checkout.dir, version);
  await checkout.git(['add', '.grimoire/config.yml']);
  await checkout.git(['commit', '--quiet', '-m', `pin grimoire ${version ?? 'here'}`]);
}

/** A file of the checkout, or null when it doesn't exist. */
export async function fileIn(checkout: Checkout | string, relative: string): Promise<string | null> {
  const dir = typeof checkout === 'string' ? checkout : checkout.dir;
  return readFile(path.join(dir, relative), 'utf8').catch(() => null);
}

export async function existsIn(checkout: Checkout | string, relative: string): Promise<boolean> {
  const dir = typeof checkout === 'string' ? checkout : checkout.dir;
  return (await stat(path.join(dir, relative)).catch(() => null)) !== null;
}

/** The generated folders of skill `name`: its copy and its two stubs. */
export function generatedFolders(name: string): string[] {
  return [`.grimoire/skills/${name}`, `.claude/skills/grimoire-${name}`, `.agents/skills/grimoire-${name}`];
}

/** Asserts `checkout` holds no copy or stub of `name`. */
export async function expectNoOutput(checkout: Checkout | string, name: string): Promise<void> {
  for (const folder of generatedFolders(name)) expect(await existsIn(checkout, folder), folder).toBe(false);
}

/** `git status --porcelain` of the checkout: empty when clean. */
export async function gitStatus(checkout: Checkout): Promise<string> {
  return checkout.git(['status', '--porcelain', '--untracked-files=all']);
}

/** Writes a file of the checkout (folders made), without git. */
export async function writeInto(dir: string, relative: string, text: string): Promise<void> {
  const file = path.join(dir, ...relative.split('/'));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}
