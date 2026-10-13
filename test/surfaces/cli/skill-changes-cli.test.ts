// Seam 3: the built `grimoire` CLI against temporary repos (spec §10, §7, §18):
// `skill restore`, `skill delete`, `skill eject`, `skill acknowledge` and
// `skill unblock` are human-only verbs; a restore lists and diffs what it
// undoes and drops before the person types the skill's name.
import { afterAll, beforeAll, describe, expect } from 'vitest';
import type { CallContext } from '../../../src/core';
import { expectRefUnmoved } from '../../core/support';
import { NOTES, NOTES_V2, skillText, NOTES_DESCRIPTION } from '../../generated/support';
import { buildGrimoire, cli, cliAtTerminal, lastJsonOnScreen } from './support';
import { cliTest, coreResult, personAtShell } from './cli-support';

let bin: string;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  ({ bin, cleanup } = await buildGrimoire());
});
afterAll(() => cleanup());

const NOTES_V3 = skillText('release-notes', NOTES_DESCRIPTION, '# Release notes\n\nCreate `changes/<slug>.md`.\nNever edit `CHANGELOG.md`: it is generated.\nRun `npm run notes` to preview.\n');

const atTerminal = (ctx: CallContext): CallContext => ({ ...ctx, tty: true });

describe('skill changes at the CLI', () => {
  cliTest('without an interactive terminal, every skill change verb is refused with HUMAN_ONLY', async ({ a }) => {
    const version = 'a'.repeat(64);
    for (const args of [
      ['skill', 'restore', 'release-notes', version],
      ['skill', 'delete', 'release-notes'],
      ['skill', 'eject', 'release-notes'],
      ['skill', 'acknowledge', 'release-notes', version],
      ['skill', 'unblock', 'release-notes'],
    ]) {
      const run = await expectRefUnmoved(a, () => cli(bin, args, { cwd: a.dir }));
      expect(run.code, args.join(' ')).toBe(1);
      expect(run.json, args.join(' ')).toMatchObject({ error: { code: 'HUMAN_ONLY' } });
    }
    const help = await cli(bin, ['skill', 'restore', '--help'], { cwd: a.dir });
    expect(help.code).toBe(0);
    expect(JSON.stringify(help.json)).toContain('undoes and drops');
  });

  cliTest('at a terminal, skill restore shows what it undoes and drops, each diffed, then restores once the person types the name', async ({ grimoire, a }) => {
    const human = atTerminal(personAtShell(a));
    const v1 = (await coreResult(grimoire.core, 'skill_edit', { name: 'release-notes', text: NOTES, base: null }, human)) as { version: string };
    const v2 = (await coreResult(grimoire.core, 'skill_edit', { name: 'release-notes', text: NOTES_V2, base: v1.version }, human)) as { version: string };
    const v3 = (await coreResult(grimoire.core, 'skill_edit', { name: 'release-notes', text: NOTES_V3, base: v2.version }, human)) as { version: string };

    const run = await cliAtTerminal(bin, ['skill', 'restore', 'release-notes', v1.version], {
      cwd: a.dir,
      answers: [{ when: /Type release-notes to confirm/, type: 'release-notes' }],
    });

    expect(run.code, run.screen).toBe(0);
    expect(run.screen).toContain(`Undone, which counts as negative evidence: the edit to ${v3.version.slice(0, 12)}`);
    expect(run.screen).toContain(`the edit to ${v2.version.slice(0, 12)}`);
    expect(run.screen).toContain('+ Never edit `CHANGELOG.md`: it is generated.');
    expect(run.screen.indexOf('Dropped along the way')).toBeLessThan(run.screen.indexOf('Type release-notes to confirm'));
    expect(lastJsonOnScreen(run.screen)).toMatchObject({ name: 'release-notes', version: v1.version, from: v3.version, undone: { version: v3.version }, dropped: [{ version: v2.version }] });
    expect(await grimoire.core.call('skill_read', { name: 'release-notes' }, personAtShell(a))).toMatchObject({ ok: true, result: { version: v1.version } });
  });

  cliTest('at a terminal, skill delete and skill eject show the version they act on (eject its text) before the person types the name, and commit only against it', async ({
    grimoire,
    a,
  }) => {
    const human = atTerminal(personAtShell(a));
    const notes = (await coreResult(grimoire.core, 'skill_edit', { name: 'release-notes', text: NOTES, base: null }, human)) as { version: string };
    const ports = skillText('free-ports', 'Pick free ports in tests. Use when a test binds a port.', '# Free ports\n\nBind to port 0.\n');
    const free = (await coreResult(grimoire.core, 'skill_edit', { name: 'free-ports', text: ports, base: null }, human)) as { version: string };

    const deleted = await cliAtTerminal(bin, ['skill', 'delete', 'release-notes'], {
      cwd: a.dir,
      answers: [{ when: /Type release-notes to confirm/, type: 'release-notes' }],
    });
    expect(deleted.code, deleted.screen).toBe(0);
    expect(deleted.screen.indexOf(`release-notes at ${notes.version.slice(0, 12)}`)).toBeGreaterThan(-1);
    expect(deleted.screen.indexOf(`release-notes at ${notes.version.slice(0, 12)}`)).toBeLessThan(deleted.screen.indexOf('Type release-notes to confirm'));
    expect(lastJsonOnScreen(deleted.screen)).toMatchObject({ name: 'release-notes', from: notes.version });

    const ejected = await cliAtTerminal(bin, ['skill', 'eject', 'free-ports'], {
      cwd: a.dir,
      answers: [{ when: /Type free-ports to confirm/, type: 'free-ports' }],
    });
    expect(ejected.code, ejected.screen).toBe(0);
    expect(ejected.screen).toContain(`free-ports at ${free.version.slice(0, 12)}`);
    expect(ejected.screen.indexOf('Bind to port 0.')).toBeLessThan(ejected.screen.indexOf('Type free-ports to confirm'));
    expect(lastJsonOnScreen(ejected.screen)).toMatchObject({ name: 'free-ports', version: free.version });
  });

  cliTest('at a terminal, restoring a deleted skill says it lifts the name block; a restore that would pass the cap is refused before anything is asked', async ({ grimoire, a }) => {
    const human = atTerminal(personAtShell(a));
    const v1 = (await coreResult(grimoire.core, 'skill_edit', { name: 'release-notes', text: NOTES, base: null }, human)) as { version: string };
    await coreResult(grimoire.core, 'skill_delete', { name: 'release-notes', base: v1.version }, human);
    const ports = skillText('free-ports', 'Pick free ports in tests. Use when a test binds a port.', '# Free ports\n\nBind to port 0.\n');
    await coreResult(grimoire.core, 'skill_edit', { name: 'free-ports', text: ports, base: null }, human);
    await coreResult(grimoire.core, 'settings_set', { key: 'skills.max_active', value: 1 }, human);

    const refused = await expectRefUnmoved(a, () => cliAtTerminal(bin, ['skill', 'restore', 'release-notes', v1.version], { cwd: a.dir }));
    expect(refused.code, refused.screen).toBe(1);
    expect(refused.screen).not.toContain('to confirm');
    expect(lastJsonOnScreen(refused.screen)).toMatchObject({ error: { code: 'INVALID', details: { fields: { name: expect.stringContaining('cap') } } } });

    await coreResult(grimoire.core, 'settings_set', { key: 'skills.max_active', value: 8 }, human);
    const run = await cliAtTerminal(bin, ['skill', 'restore', 'release-notes', v1.version], {
      cwd: a.dir,
      answers: [{ when: /Type release-notes to confirm/, type: 'release-notes' }],
    });
    expect(run.code, run.screen).toBe(0);
    expect(run.screen).toContain('This lifts the block on the name release-notes');
    expect(lastJsonOnScreen(run.screen)).toMatchObject({ version: v1.version, from: null, lifted_block: true });
  });
});
