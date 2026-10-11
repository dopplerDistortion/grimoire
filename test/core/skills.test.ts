// Evolved skills on the tracker (spec §18 Skill versions, The skill ledger,
// Names; §15 limits; §8 skill_list / skill_read): human edits commit skill
// versions named by their normalized text, the ledger alone says which version
// is current, and agents read the served text.
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import type { CallContext, Core } from '../../src/core';
import { MachineLocalStore } from '../../src/machine-local';
import { coreTest as test, expectRefUnmoved, T0, trackerFile, trackerTip } from './support';

/** A human at an interactive terminal: the CLI with no agent marker and a TTY. */
function terminal(ctx: CallContext): CallContext {
  return { ...ctx, surface: 'cli', client: null, evidence: {}, tty: true };
}

/** A skill version's id: the sha256 of its normalized text (spec §18, Skill versions). */
function versionOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function skill(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

const NOTES_V1 = skill(
  'release-notes',
  'Write a release note for a change. Use when the user asks to record a change in the notes.',
  '# Release notes\n\nCreate `changes/<slug>.md` with `kind:` and `summary:` lines.\n',
);
const NOTES_V2 = skill(
  'release-notes',
  'Write a release note for a change. Use when the user asks to record a change in the notes.',
  '# Release notes\n\nCreate `changes/<slug>.md` with `kind:` and `summary:` lines.\nNever edit `CHANGELOG.md`: it is generated.\n',
);

async function edit(core: Core, ctx: CallContext, input: Record<string, unknown>) {
  const result = await core.call('skill_edit', input, terminal(ctx));
  if (!result.ok) throw new Error(`skill_edit failed: ${JSON.stringify(result.error)}`);
  return result.result;
}

describe('skill versions and human edits', () => {
  test('skill_edit creates v1, a second edit makes v2 current, and identical text is always the same version', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;

    const v1 = await edit(core, ctx, { name: 'release-notes', text: NOTES_V1, base: null });
    const readV1 = await core.call('skill_read', { name: 'release-notes' }, ctx);
    const v2 = await edit(core, ctx, { name: 'release-notes', text: NOTES_V2, base: v1.version });
    const readV2 = await core.call('skill_read', { name: 'release-notes' }, ctx);
    // The same words with a BOM and CRLF line endings normalize to v1's text, so they are v1 again.
    const back = await edit(core, ctx, {
      name: 'release-notes',
      text: `﻿${NOTES_V1.replace(/\n/g, '\r\n')}`,
      base: v2.version,
    });

    expect(v1).toEqual({ name: 'release-notes', version: versionOf(NOTES_V1), from: null, created: true, changed: true });
    expect(readV1).toEqual({ ok: true, result: { name: 'release-notes', version: versionOf(NOTES_V1), text: NOTES_V1 } });
    expect(v2).toEqual({
      name: 'release-notes',
      version: versionOf(NOTES_V2),
      from: versionOf(NOTES_V1),
      created: false,
      changed: true,
    });
    expect(readV2).toEqual({ ok: true, result: { name: 'release-notes', version: versionOf(NOTES_V2), text: NOTES_V2 } });
    expect(back).toMatchObject({ version: versionOf(NOTES_V1), from: versionOf(NOTES_V2), changed: true });

    const tip = (await trackerTip(world.a))!;
    expect(await trackerFile(world.a, tip, `knowledge/skill-versions/${versionOf(NOTES_V1)}.md`)).toBe(NOTES_V1);
    expect(await trackerFile(world.a, tip, `knowledge/skill-versions/${versionOf(NOTES_V2)}.md`)).toBe(NOTES_V2);
    expect((await world.a.git(['ls-tree', '--name-only', `${tip}:knowledge/skill-versions`])).split('\n')).toHaveLength(2);
    // One ledger record per change, each named by the sha256 of its bytes.
    const records = (await world.a.git(['ls-tree', '--name-only', `${tip}:knowledge/ledger`])).split('\n');
    expect(records).toHaveLength(3);
    for (const name of records) {
      const bytes = await trackerFile(world.a, tip, `knowledge/ledger/${name}`);
      expect(name).toBe(`${versionOf(bytes)}.md`);
    }
    expect(await world.a.git(['log', '-1', '--format=%B', tip])).toMatch(/^Grimoire-Op: skill-edit$/m);
  });

  test('names of 56+ characters, reserved names, the grimoire- prefix and non-kebab names are refused; 55 characters is fine', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const body = '# Steps\n\nDo the thing.\n';
    const attempt = (name: string) =>
      core.call('skill_edit', { name, text: skill(name, 'Use when doing the thing.', body), base: null }, terminal(ctx));
    const longest = `a${'-b'.repeat(27)}`;
    expect(longest).toHaveLength(55);

    const refused = await expectRefUnmoved(world.a, async () => ({
      long: await attempt(`${longest}c`),
      reserved: await attempt('chores'),
      prefixed: await attempt('grimoire-notes'),
      upper: await attempt('Release-Notes'),
      spaced: await attempt('release notes'),
      dashes: await attempt('release--notes'),
    }));
    const fine = await attempt(longest);

    for (const [why, outcome] of Object.entries(refused)) {
      expect(outcome, why).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { name: expect.any(String) } } } });
    }
    expect(refused.long).toMatchObject({ error: { details: { fields: { name: expect.stringContaining('55') } } } });
    expect(refused.reserved).toMatchObject({ error: { details: { fields: { name: expect.stringContaining('reserved') } } } });
    expect(refused.prefixed).toMatchObject({ error: { details: { fields: { name: expect.stringContaining('grimoire-') } } } });
    expect(fine).toMatchObject({ ok: true, result: { name: longest, created: true } });
  });

  test('only name and description frontmatter survive: any other field, or a malformed SKILL.md, is refused', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const attempt = (text: string) => core.call('skill_edit', { name: 'release-notes', text, base: null }, terminal(ctx));

    const refused = await expectRefUnmoved(world.a, async () => ({
      allowedTools: await attempt(NOTES_V1.replace('---\n# Release', 'allowed-tools: Bash\n---\n# Release')),
      model: await attempt(NOTES_V1.replace('description:', 'model: opus\ndescription:')),
      noFrontmatter: await attempt('# Release notes\n\nJust a body.\n'),
      otherName: await attempt(NOTES_V1.replace('name: release-notes', 'name: changelog')),
      noDescription: await attempt('---\nname: release-notes\n---\n# Body\n'),
      emptyBody: await attempt('---\nname: release-notes\ndescription: Use it.\n---\n\n'),
      blockDescription: await attempt('---\nname: release-notes\ndescription: >\n  folded\n---\n# Body\n'),
    }));

    for (const [why, outcome] of Object.entries(refused)) {
      expect(outcome, why).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { text: expect.any(String) } } } });
    }
    expect(refused.allowedTools).toMatchObject({ error: { details: { fields: { text: expect.stringContaining('allowed-tools') } } } });
  });

  test('grimoire writes the frontmatter itself, so quoting styles that mean the same text are the same version', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const quoted = NOTES_V1.replace(
      'description: Write a release note for a change. Use when the user asks to record a change in the notes.',
      'description: "Write a release note for a change. Use when the user asks to record a change in the notes."   ',
    ).replace('name: release-notes', "name: 'release-notes'");
    const colon = skill('tricky', '"Notes: a guide"', '# Body\n');

    const edited = await edit(core, ctx, { name: 'release-notes', text: quoted, base: null });
    const read = await core.call('skill_read', { name: 'release-notes' }, ctx);
    const tricky = await edit(core, ctx, { name: 'tricky', text: colon, base: null });
    const trickyRead = await core.call('skill_read', { name: 'tricky' }, ctx);

    expect(edited.version).toBe(versionOf(NOTES_V1));
    expect(read).toMatchObject({ ok: true, result: { text: NOTES_V1 } });
    expect(tricky.created).toBe(true);
    // A description YAML would misread when plain stays quoted.
    expect(trickyRead).toMatchObject({ ok: true, result: { text: skill('tricky', '"Notes: a guide"', '# Body\n') } });
  });

  test('skill_edit is human-only: MCP, agent markers and a CLI without a terminal get HUMAN_ONLY', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const input = { name: 'release-notes', text: NOTES_V1, base: null };

    const refused = await expectRefUnmoved(world.a, async () => ({
      mcp: await core.call('skill_edit', input, ctx),
      marked: await core.call('skill_edit', input, { ...terminal(ctx), evidence: { agentMarkers: ['CLAUDE_CODE_CHILD_SESSION'] } }),
      noTty: await core.call('skill_edit', input, { ...terminal(ctx), tty: false }),
      hook: await core.call('skill_edit', input, { ...ctx, surface: 'hook' }),
    }));
    const dashboard = await core.call('skill_edit', input, { ...ctx, surface: 'dashboard', client: null, evidence: {} });

    for (const [surface, outcome] of Object.entries(refused)) {
      expect(outcome, surface).toMatchObject({ ok: false, error: { code: 'HUMAN_ONLY' } });
      expect(outcome.ok ? '' : outcome.error.message, surface).not.toMatch(/CLAUDE_CODE_CHILD_SESSION|AI_AGENT|CODEX/);
    }
    expect(dashboard).toMatchObject({ ok: true, result: { created: true } });
  });

  test('a secret in the edited text blocks the commit, naming the rule and line but never the secret', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const token = `ghp_${'A1b2C3d4E5f6G7h8I9j0'.repeat(2).slice(0, 36)}`;
    const leaky = skill('deploy', 'Use when deploying the site.', `# Deploy\n\nRun the deploy.\nexport GITHUB_TOKEN=${token}\n`);

    const refused = await expectRefUnmoved(world.a, () =>
      core.call('skill_edit', { name: 'deploy', text: leaky, base: null }, terminal(ctx)),
    );

    expect(refused).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { text: expect.stringMatching(/secret \(github-pat\) on line 8/) } } } });
    expect(JSON.stringify(refused)).not.toContain(token);
    expect(await core.call('skill_read', { name: 'deploy' }, ctx)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  test('an edit from a base that moved gives BASE_MOVED; replacing it on purpose commits the draft', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const v1 = await edit(core, ctx, { name: 'release-notes', text: NOTES_V1, base: null });
    const v2 = await edit(core, ctx, { name: 'release-notes', text: NOTES_V2, base: v1.version });
    const draft = NOTES_V1.replace('# Release notes', '# Release notes, mine');

    const moved = await expectRefUnmoved(world.a, () =>
      core.call('skill_edit', { name: 'release-notes', text: draft, base: v1.version }, terminal(ctx)),
    );
    const created = await core.call('skill_edit', { name: 'brand-new', text: skill('brand-new', 'Use it.', '# B\n'), base: v1.version }, terminal(ctx));
    const replaced = await edit(core, ctx, { name: 'release-notes', text: draft, base: v1.version, replace: true });

    expect(moved).toMatchObject({
      ok: false,
      error: { code: 'BASE_MOVED', details: { name: 'release-notes', base: v1.version, current: v2.version } },
    });
    expect(created).toMatchObject({ ok: false, error: { code: 'BASE_MOVED', details: { current: null } } });
    expect(replaced).toMatchObject({ version: versionOf(draft), from: v2.version, changed: true });
  });

  test('the active cap (skills.max_active, 8) refuses a create past it, but never an edit; descriptions stop at skills.description_max (300)', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const make = (name: string, description = `Use for ${name}.`) =>
      core.call('skill_edit', { name, text: skill(name, description, '# Steps\n'), base: null }, terminal(ctx));
    const defaults = await core.call('settings_get', {}, ctx);
    for (let i = 1; i <= 8; i++) expect(await make(`skill-${i}`), `skill-${i}`).toMatchObject({ ok: true });

    const ninth = await expectRefUnmoved(world.a, () => make('skill-9'));
    const v1 = await core.call('skill_read', { name: 'skill-1' }, ctx);
    const editAtCap = await core.call(
      'skill_edit',
      { name: 'skill-1', text: skill('skill-1', 'Use for skill-1.', '# Steps, better\n'), base: v1.ok ? v1.result.version : null },
      terminal(ctx),
    );
    await core.call('settings_set', { key: 'skills.max_active', value: 9 }, terminal(ctx));
    const longDescription = await make('skill-9', 'x'.repeat(301));
    const fits = await make('skill-9', 'é'.repeat(300));

    expect(defaults).toMatchObject({
      ok: true,
      result: {
        store: {
          'skills.delivery': { value: true, default: true },
          'skills.max_active': { value: 8, default: true },
          'skills.description_max': { value: 300, default: true },
        },
      },
    });
    expect(ninth).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { name: expect.stringContaining('cap') } } } });
    expect(editAtCap).toMatchObject({ ok: true, result: { changed: true } });
    expect(longDescription).toMatchObject({ ok: false, error: { code: 'INVALID', details: { fields: { text: expect.stringContaining('300') } } } });
    expect(fits).toMatchObject({ ok: true, result: { created: true } });
  });

  test('an edit that changes nothing commits nothing', async ({ world, grimoire }) => {
    const { core, ctx } = grimoire;
    const v1 = await edit(core, ctx, { name: 'release-notes', text: NOTES_V1, base: null });

    const again = await expectRefUnmoved(world.a, () => edit(core, ctx, { name: 'release-notes', text: NOTES_V1, base: v1.version }));

    expect(again).toEqual({ name: 'release-notes', version: v1.version, from: v1.version, created: false, changed: false });
  });
});

describe('what agents get: skill_list and skill_read', () => {
  test('skill_list gives the name and description of every active evolved skill, by name; none at first', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const empty = await core.call('skill_list', {}, ctx);
    await edit(core, ctx, { name: 'release-notes', text: NOTES_V1, base: null });
    await edit(core, ctx, { name: 'flaky-tests', text: skill('flaky-tests', 'Use when a test fails only sometimes.', '# Flaky\n'), base: null });

    const listed = await core.call('skill_list', {}, ctx);

    expect(empty).toEqual({ ok: true, result: { skills: [] } });
    expect(listed).toEqual({
      ok: true,
      result: {
        skills: [
          { name: 'flaky-tests', description: 'Use when a test fails only sometimes.' },
          { name: 'release-notes', description: 'Write a release note for a change. Use when the user asks to record a change in the notes.' },
        ],
      },
    });
  });

  test('skill_read names an unknown skill NOT_FOUND, and takes a stub’s grimoire- name too', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    await edit(core, ctx, { name: 'release-notes', text: NOTES_V1, base: null });

    const unknown = await core.call('skill_read', { name: 'nope' }, ctx);
    const stub = await core.call('skill_read', { name: 'grimoire-release-notes' }, ctx);

    expect(unknown).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', details: { skill: 'nope' } } });
    expect(stub).toMatchObject({ ok: true, result: { name: 'release-notes', text: NOTES_V1 } });
  });

  test('with delivery off, skill_list is empty and skill_read gives NOT_FOUND with delivery "off"; on again, both serve', async ({
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    await edit(core, ctx, { name: 'release-notes', text: NOTES_V1, base: null });

    const off = await core.call('settings_set', { key: 'skills.delivery', value: false }, terminal(ctx));
    const listed = await core.call('skill_list', {}, ctx);
    const read = await core.call('skill_read', { name: 'release-notes' }, ctx);
    await core.call('settings_set', { key: 'skills.delivery', value: true }, terminal(ctx));
    const listedAgain = await core.call('skill_list', {}, ctx);

    expect(off).toMatchObject({ ok: true, result: { scope: 'store', value: false, changed: true } });
    expect(listed).toEqual({ ok: true, result: { skills: [] } });
    expect(read).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', details: { delivery: 'off' } } });
    expect(listedAgain).toMatchObject({ ok: true, result: { skills: [{ name: 'release-notes' }] } });
  });

  test('skill_read appends a machine-local read event {skill, version, at, actor, nonce}; a failed append never fails the read', async ({
    world,
    grimoire,
  }) => {
    const { core, ctx } = grimoire;
    const v1 = await edit(core, ctx, { name: 'release-notes', text: NOTES_V1, base: null });
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));

    await core.call('skill_read', { name: 'release-notes' }, ctx);
    const events = await store.records.list('skill-reads');
    // A newer release's machine-local data: this release can't write records any more.
    await writeFile(path.join(world.a.dir, '.git', 'grimoire', 'format'), 'format: 2\ncompat: 2\nrequires: "2.0.0"\n');
    const readAnyway = await core.call('skill_read', { name: 'release-notes' }, ctx);

    expect(events.map((event) => event.value)).toEqual([
      {
        skill: 'release-notes',
        version: v1.version,
        at: T0.toISOString(),
        actor: { kind: 'agent', client: 'claude-code', session: 'sess-1', context: 'main', call: 'call-1', nonce: 'nonce-1' },
        nonce: 'nonce-1',
      },
    ]);
    expect(readAnyway).toMatchObject({ ok: true, result: { version: v1.version, text: NOTES_V1 } });
  });

  test('a skill too long for one result is cut, with a cursor that reads the rest', async ({ grimoire }) => {
    const { core, ctx } = grimoire;
    const body = Array.from({ length: 900 }, (_, i) => `${i}. Check the step and write down what happened, in full.`).join('\n');
    const long = skill('long-procedure', 'Use for the long procedure.', `${body}\n`);
    await edit(core, ctx, { name: 'long-procedure', text: long, base: null });

    const parts: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const read = await core.call('skill_read', { name: 'long-procedure', ...(cursor ? { cursor } : {}) }, ctx);
      if (!read.ok) throw new Error(JSON.stringify(read.error));
      expect(Buffer.byteLength(JSON.stringify(read.result))).toBeLessThan(24_000);
      parts.push(read.result.text);
      cursor = read.result.cursor;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBeGreaterThan(1);
    expect(parts.join('')).toBe(long);
  });
});
