// Stray edits (spec §15 Stray edits; §7 the human-only gate). Seam 1: a hand
// edit to a generated copy, found by upkeep, is set aside and the served text
// put back; only a human's `skill record` makes it a skill version (checking
// its base, with a three-way diff when the current version moved), and
// `skill discard` drops it, singly or in bulk.
import { describe, expect } from 'vitest';
import type { CallContext, Core } from '../../src/core';
import { readStatus } from '../../src/installer/status';
import { skillVersionOf } from '../../src/knowledge';
import { runUpkeep } from '../../src/upkeep';
import { coreTest as test } from '../core/support';
import { editSkill, fileIn, NOTES, NOTES_V2, pinAndCommit, terminal, writeInto } from './support';

const COPY = '.grimoire/skills/release-notes/SKILL.md';
const EDITED = `${NOTES}\nAlso bump the version in \`package.json\`.\n`;

async function createIssue(core: Core, ctx: CallContext, title: string): Promise<string> {
  const created = await core.call('create', { title }, ctx);
  if (!created.ok) throw new Error(`create failed: ${JSON.stringify(created.error)}`);
  return created.result.id;
}

async function claim(core: Core, ctx: CallContext, id: string): Promise<string> {
  const claimed = await core.call('claim', { id }, ctx);
  if (!claimed.ok) throw new Error(`claim failed: ${JSON.stringify(claimed.error)}`);
  return claimed.result.attempt;
}

interface Listed {
  id: string;
  skill: string;
  text: string;
  base: string | null;
  current: string | null;
  open_attempts: string[];
  notice: string;
}

async function strays(core: Core, ctx: CallContext): Promise<Listed[]> {
  const listed = await core.call('skill_strays', {}, terminal(ctx));
  if (!listed.ok) throw new Error(`skill_strays failed: ${JSON.stringify(listed.error)}`);
  return listed.result.stray_edits as Listed[];
}

describe('finding a stray edit', () => {
  test('editing a generated copy, then running upkeep, restores the served text and records the stray edit with the agent attempts open on the machine listed', async ({
    world,
    grimoire,
  }) => {
    await pinAndCommit(world.a);
    const core = grimoire.makeCore();
    const v1 = await editSkill(core, grimoire.ctx, { name: 'release-notes', text: NOTES, base: null });
    const open = await claim(core, grimoire.ctx, await createIssue(core, grimoire.ctx, 'Still being worked'));
    const doneId = await createIssue(core, grimoire.ctx, 'Given up before the edit');
    const done = await claim(core, grimoire.ctx, doneId);
    expect(await core.call('release', { id: doneId, attempt: done, abandoned: true }, grimoire.ctx)).toMatchObject({ ok: true });
    await core.close();

    await writeInto(world.a.dir, COPY, EDITED);
    await runUpkeep({ root: world.a.dir, force: true });

    expect(await fileIn(world.a, COPY)).toBe(NOTES);
    expect(await strays(core, grimoire.ctx)).toEqual([
      expect.objectContaining({
        skill: 'release-notes',
        text: EDITED,
        base: v1.version,
        current: v1.version,
        path: COPY,
        open_attempts: [open],
        notice: 'stray edit to release-notes: Record or Discard',
      }),
    ]);
    const { report, lines } = await readStatus({ root: world.a.dir });
    expect(report.stray_edits).toEqual([expect.objectContaining({ skill: 'release-notes', open_attempts: [open] })]);
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^stray edit to release-notes: Record or Discard \\(.*agent attempts open then: ${open}\\)$`)));
    // Nothing records it on its own.
    expect(await core.call('skill_show', { name: 'release-notes' }, terminal(grimoire.ctx))).toMatchObject({ ok: true, result: { skills: [{ current: v1.version }] } });
  });
});

describe('skill record', () => {
  test('makes the stray edit a new version, served everywhere, and drops it from the store', async ({ world, grimoire }) => {
    await pinAndCommit(world.a);
    const core = grimoire.makeCore();
    const v1 = await editSkill(core, grimoire.ctx, { name: 'release-notes', text: NOTES, base: null });
    await core.close();
    await writeInto(world.a.dir, COPY, EDITED);
    await runUpkeep({ root: world.a.dir, force: true });
    const [stray] = await strays(core, grimoire.ctx);

    const recorded = await core.call('skill_record', { stray: stray!.id }, terminal(grimoire.ctx));
    await core.close();

    expect(recorded).toEqual({ ok: true, result: { stray: stray!.id, name: 'release-notes', version: skillVersionOf(EDITED), from: v1.version, changed: true } });
    expect(await fileIn(world.a, COPY)).toBe(EDITED);
    expect(await strays(core, grimoire.ctx)).toEqual([]);
    const shown = await core.call('skill_show', { name: 'release-notes' }, terminal(grimoire.ctx));
    expect(shown).toMatchObject({ ok: true, result: { skills: [{ current: skillVersionOf(EDITED), history: [{ kind: 'edit' }, { kind: 'record', from: v1.version }] }] } });
  });

  test('when the current version moved meanwhile, it shows a three-way diff and records only over the version the human saw', async ({ world, grimoire }) => {
    await pinAndCommit(world.a);
    const core = grimoire.makeCore();
    const v1 = await editSkill(core, grimoire.ctx, { name: 'release-notes', text: NOTES, base: null });
    await core.close();
    await writeInto(world.a.dir, COPY, EDITED);
    await runUpkeep({ root: world.a.dir, force: true });
    const [stray] = await strays(core, grimoire.ctx);
    const v2 = await editSkill(core, grimoire.ctx, { name: 'release-notes', text: NOTES_V2, base: v1.version });
    await core.close();

    const moved = await core.call('skill_record', { stray: stray!.id }, terminal(grimoire.ctx));

    expect(moved).toMatchObject({ ok: false, error: { code: 'BASE_MOVED', details: { stray: stray!.id, base: v1.version, current: v2.version } } });
    const diff = (moved as unknown as { error: { details: { diff: string } } }).error.details.diff;
    expect(diff).toContain(`<<<<<<< current ${v2.version}`);
    expect(diff).toContain(`||||||| base ${v1.version}`);
    expect(diff).toContain('>>>>>>> stray edit');
    expect(diff).toContain('Never edit `CHANGELOG.md`: it is generated.');
    expect(diff).toContain('Also bump the version in `package.json`.');
    // The newer version is never dropped silently: replacing names the one shown, and only while it is current.
    expect(await core.call('skill_record', { stray: stray!.id, replace: v1.version }, terminal(grimoire.ctx))).toMatchObject({ ok: false, error: { code: 'BASE_MOVED' } });
    expect(await strays(core, grimoire.ctx)).toHaveLength(1);

    const replaced = await core.call('skill_record', { stray: stray!.id, replace: v2.version }, terminal(grimoire.ctx));
    await core.close();

    expect(replaced).toMatchObject({ ok: true, result: { version: skillVersionOf(EDITED), from: v2.version, changed: true } });
    expect(await fileIn(world.a, COPY)).toBe(EDITED);
  });
});

describe('skill discard', () => {
  test('drops one stray edit by its id, or every one of a skill, or all of them; the served text stays', async ({ world, grimoire }) => {
    await pinAndCommit(world.a);
    const b = await world.a.addWorktree('b');
    const core = grimoire.makeCore();
    await editSkill(core, grimoire.ctx, { name: 'release-notes', text: NOTES, base: null });
    await core.close();
    for (const [dir, text] of [
      [world.a.dir, EDITED],
      [b.dir, `${NOTES}\nOne more.\n`],
    ] as const) {
      await writeInto(dir, COPY, text);
    }
    await runUpkeep({ root: world.a.dir, force: true });
    const found = await strays(core, grimoire.ctx);
    expect(found).toHaveLength(2);

    expect(await core.call('skill_discard', { stray: found[0]!.id }, terminal(grimoire.ctx))).toEqual({ ok: true, result: { discarded: [found[0]!.id] } });
    expect((await strays(core, grimoire.ctx)).map((edit) => edit.id)).toEqual([found[1]!.id]);
    expect(await core.call('skill_discard', { stray: found[0]!.id }, terminal(grimoire.ctx))).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

    expect(await core.call('skill_discard', { skill: 'release-notes' }, terminal(grimoire.ctx))).toEqual({ ok: true, result: { discarded: [found[1]!.id] } });
    expect(await strays(core, grimoire.ctx)).toEqual([]);

    await writeInto(world.a.dir, COPY, EDITED);
    await runUpkeep({ root: world.a.dir, force: true });
    expect(await core.call('skill_discard', { all: true }, terminal(grimoire.ctx))).toMatchObject({ ok: true, result: { discarded: [expect.any(String)] } });
    expect(await strays(core, grimoire.ctx)).toEqual([]);
    expect(await core.call('skill_discard', {}, terminal(grimoire.ctx))).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    expect(await fileIn(world.a, COPY)).toBe(NOTES);
    expect(await fileIn(b, COPY)).toBe(NOTES);
  });
});

describe('the human-only gate', () => {
  test('record and discard refuse agent surfaces (MCP, a CLI under agent markers or without a terminal), and listing them is for people only', async ({
    world,
    grimoire,
  }) => {
    await pinAndCommit(world.a);
    const core = grimoire.makeCore();
    await editSkill(core, grimoire.ctx, { name: 'release-notes', text: NOTES, base: null });
    await core.close();
    await writeInto(world.a.dir, COPY, EDITED);
    await runUpkeep({ root: world.a.dir, force: true });
    const [stray] = await strays(core, grimoire.ctx);
    const marked: CallContext = { ...terminal(grimoire.ctx), evidence: { agentMarkers: ['CLAUDE_CODE_CHILD_SESSION'] } };
    const noTty: CallContext = { ...terminal(grimoire.ctx), tty: false };

    for (const ctx of [grimoire.ctx, marked, noTty]) {
      expect(await core.call('skill_record', { stray: stray!.id }, ctx), ctx.surface).toMatchObject({ ok: false, error: { code: 'HUMAN_ONLY' } });
      expect(await core.call('skill_discard', { all: true }, ctx), ctx.surface).toMatchObject({ ok: false, error: { code: 'HUMAN_ONLY' } });
    }
    for (const ctx of [grimoire.ctx, marked]) {
      expect(await core.call('skill_strays', {}, ctx)).toMatchObject({ ok: false, error: { code: 'HUMAN_ONLY' } });
    }
    expect(await strays(core, grimoire.ctx)).toHaveLength(1);
    expect(await fileIn(world.a, COPY)).toBe(NOTES);
  });
});
