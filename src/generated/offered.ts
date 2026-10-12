// What a checkout offered (spec §14 Facts, Offered): read at an attempt's
// opening from the generated output in the opening checkout. Per stub, the
// ledger version whose normalized text equals that checkout's copy; else
// `unknown` plus the copy's hash; or `missing`, the stub present but the copy
// absent. The ledger's current pointer plays no part: a checkout still holding
// an older version was offered that one.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeSkillText, skillVersionOf, STUB_PREFIX } from '../knowledge';
import type { OfferedSkill } from '../tracker';
import { CHORE_CARRIER, copyFolder, SKILL_FILE, STUB_ROOTS } from './texts';

/**
 * The evolved skills the checkout at `worktree` offers, sorted by name.
 * `known` holds every version the ledger records for each skill, by name.
 * What can't be read counts as absent: a stub folder without its `SKILL.md`
 * is no stub, and an unreadable copy is `missing`.
 */
export async function offeredSkills(worktree: string, known: ReadonlyMap<string, ReadonlySet<string>>): Promise<OfferedSkill[]> {
  const names = new Set<string>();
  for (const root of Object.values(STUB_ROOTS)) {
    const entries = await readdir(path.join(worktree, root), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(STUB_PREFIX) || entry.name === CHORE_CARRIER) continue;
      if (await isFile(path.join(worktree, root, entry.name, SKILL_FILE))) names.add(entry.name.slice(STUB_PREFIX.length));
    }
  }
  const offered: OfferedSkill[] = [];
  for (const name of [...names].sort()) {
    const copy = await readFile(path.join(worktree, copyFolder(name), SKILL_FILE), 'utf8').catch(() => null);
    if (copy === null) {
      offered.push({ name, version: 'missing' });
      continue;
    }
    const hash = skillVersionOf(normalizeSkillText(copy));
    offered.push(known.get(name)?.has(hash) ? { name, version: hash } : { name, version: 'unknown', hash });
  }
  return offered;
}

async function isFile(file: string): Promise<boolean> {
  return stat(file).then(
    (found) => found.isFile(),
    () => false,
  );
}
