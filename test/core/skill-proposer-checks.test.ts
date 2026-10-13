// Seam 1 (spec §18 Mechanical checks; §16 One fix-up): a Skill Proposer
// result the mechanical checks refuse gets reason codes and one fix-up, then
// the run ends `failed`. Split from skill-proposer.test.ts so the two files
// run side by side.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { DEBRIEF, terminal, workPair } from './chore-support';
import { createResult, longBody, manualRun, ok, PAGE, patchResult, proposer, removeSkill, SKILL, SKILL_V1, skillText, submit } from './proposer-support';
import { coreTest as test, expectRefUnmoved, trackerFile, trackerTip } from './support';

describe('chore_submit: the mechanical checks refuse with reason codes, one fix-up, then failed', () => {
  test('an unserved trace, then a patch changing over half the lines: invalid with one fix-up, then the run fails and consumes its compile', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    // A failing trace this run was never served: it is in no compile and on no page.
    const unserved = await workPair(p.core, grimoire.ctx, 'fail', 'Unrelated failure');
    const tip = await trackerTip(world.a);

    const first = await expectRefUnmoved(world.a, () => submit(p, patchResult(p, { citations: [...(patchResult(p).citations as string[]), `trace:${unserved}`] })));
    expect(first).toMatchObject({ ok: true, result: { result: 'invalid', reasons: ['unserved'], fix_ups_left: 1, problems: { 'citations[6]': expect.any(String) } } });

    // Replacing seven of the skill's 13 lines.
    const steps = SKILL_V1.slice(SKILL_V1.indexOf('1. Rerun'));
    const rewrite = [{ op: 'replace', anchor: steps, text: '1. Use port 0.\n2. Read the port back.\n' }];
    const second = ok(await submit(p, patchResult(p, { ops: rewrite })));
    expect(second).toMatchObject({ result: 'failed', reasons: ['patch_too_big'], fix_ups_left: 0 });

    // The failed run's record: reason codes, the compile consumed, no text.
    const after = (await trackerTip(world.a))!;
    expect(await world.a.git(['rev-parse', `${after}^`])).toBe(tip);
    const record = await trackerFile(world.a, after, `knowledge/chore-runs/${p.brief.run[3]}/${p.brief.run[4]}/${p.brief.run}.md`);
    expect(record).toContain('result: "failed"');
    expect(record).toContain('reasons: ["patch_too_big"]');
    expect(record).toContain('consumed: ["cr-0000000001"]');
    expect(record).not.toContain('port 0');
    expect(await world.a.gitResult(['ls-tree', '-r', '--name-only', after, 'knowledge/proposals'])).toMatchObject({ stdout: '' });
  });

  test('a create over 150 lines, a 56-character name, and a grimoire-<name> collision in a client skill folder', async ({ world, grimoire }) => {
    const first = await proposer(grimoire, world);
    const long = ok(await submit(first, createResult(first, 'free-ports', longBody(151))));
    expect(long).toMatchObject({ result: 'invalid', reasons: ['too_long'] });
    const name56 = `${'port-'.repeat(11)}x`;
    expect(name56).toHaveLength(56);
    const named = ok(await submit(first, createResult(first, name56, longBody(5))));
    expect(named).toMatchObject({ result: 'failed', reasons: ['bad_name'] });

    // A hand-written skill already sits where the stub grimoire-free-ports would go.
    await mkdir(path.join(world.a.dir, '.claude', 'skills', 'grimoire-free-ports'), { recursive: true });
    await writeFile(path.join(world.a.dir, '.claude', 'skills', 'grimoire-free-ports', 'SKILL.md'), skillText('grimoire-free-ports', 'Mine.', '# Mine\n'));
    const second = await manualRun(first);
    const collided = ok(await submit(second, createResult(second, 'free-ports', longBody(5))));
    expect(collided).toMatchObject({ result: 'invalid', reasons: ['name_collision'] });
    // The fix-up: another name passes.
    const fixed = ok(await submit(second, createResult(second, 'free-test-ports', longBody(5))));
    expect(fixed).toMatchObject({ result: 'proposed' });
  });
});

describe('chore_submit: the evidence minimum counts only served traces with an outcome, unquarantined, from 2 issues, 2 failing, and a pattern page', () => {
  test('no pattern page; then a single fail; then quarantined fails; then a fail a human set to none: too_little_evidence each time, and the citations pass once the fails count again', async ({
    world,
    grimoire,
  }) => {
    const p = await proposer(grimoire, world);
    const all = patchResult(p).citations as string[];
    const noPage = all.filter((item) => !item.startsWith('page:'));
    expect(ok(await submit(p, patchResult(p, { citations: noPage })))).toMatchObject({ result: 'invalid', reasons: ['too_little_evidence'] });
    const claims = patchResult(p).claims as Record<string, unknown>;
    const oneFail = { citations: [`page:${PAGE}`, `trace:${p.fails[0]}`, `trace:${p.passes[0]}`, `skill:${SKILL}`], claims: { ...claims, failures: [{ trace: p.fails[0], line: 'a fixed port was already taken' }] } };
    expect(ok(await submit(p, patchResult(p, oneFail)))).toMatchObject({ result: 'failed', reasons: ['too_little_evidence'] });

    // Served, then quarantined: two of the three fails no longer count.
    const human = terminal(grimoire.ctx);
    const second = await manualRun(p);
    for (const trace of p.fails.slice(1)) ok(await p.core.call('quarantine', { trace, reason: 'leaked a token' }, human));
    expect(ok(await submit(second, patchResult(second)))).toMatchObject({ result: 'invalid', reasons: ['too_little_evidence'] });
    // Lifted, but a human says the third was no real failure: three cited traces, one with outcome none, count as two.
    for (const trace of p.fails.slice(1)) ok(await p.core.call('unquarantine', { trace }, human));
    ok(await p.core.call('outcome_set', { attempt: p.fails[2], verdict: 'none', reason: 'the CI runner was down' }, human));
    const failsOnly = { citations: [`page:${PAGE}`, ...p.fails.map((t) => `trace:${t}`), `skill:${SKILL}`] };
    expect(ok(await submit(second, patchResult(second, failsOnly)))).toMatchObject({ result: 'failed', reasons: ['too_little_evidence'] });

    ok(await p.core.call('outcome_set', { attempt: p.fails[2], verdict: 'fail', reason: 'it was real' }, human));
    const third = await manualRun(p);
    expect(ok(await submit(third, patchResult(third)))).toMatchObject({ result: 'proposed' });
  });

  test('three traces, two failing, all from one issue: too_little_evidence', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world, {
      work: async (core) => {
        const { id } = ok(await core.call('create', { title: 'Port clash everywhere', body: 'Body' }, grimoire.ctx));
        const attempts: string[] = [];
        for (const ending of ['release', 'release', 'close'] as const) {
          const { attempt } = ok(await core.call('claim', { id }, grimoire.ctx));
          if (ending === 'close') ok(await core.call('close', { id, attempt, reason: 'done', debrief: DEBRIEF }, grimoire.ctx));
          else ok(await core.call('release', { id, attempt, debrief: DEBRIEF }, grimoire.ctx));
          attempts.push(attempt);
        }
        return { fails: attempts.slice(0, 2), passes: attempts.slice(2) };
      },
    });
    expect(ok(await submit(p, patchResult(p)))).toMatchObject({ result: 'invalid', reasons: ['too_little_evidence'], problems: { citations: expect.stringContaining('3 traces from 1 issues, 2 failing') } });
  });
});

describe('chore_submit: names, the cap, copying, anchors and duplicates', () => {
  test('a reserved name, an ambiguous anchor, a patch that changes nothing, then a create at the cap that copies CLAUDE.md with an overlong description', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    expect(ok(await submit(p, createResult(p, 'chores', longBody(5))))).toMatchObject({ result: 'invalid', reasons: ['reserved_name'] });
    // "the " occurs on many lines of the skill.
    const ambiguous = [{ op: 'insert-after', anchor: 'the ', text: 'x' }];
    expect(ok(await submit(p, patchResult(p, { ops: ambiguous })))).toMatchObject({ result: 'failed', reasons: ['anchor_ambiguous'] });

    const second = await manualRun(p);
    const same = [{ op: 'replace', anchor: '3. Pin random seeds', text: '3. Pin random seeds' }];
    expect(ok(await submit(second, patchResult(second, { ops: same })))).toMatchObject({ result: 'invalid', reasons: ['no_change'] });

    const human = terminal(grimoire.ctx);
    ok(await p.core.call('settings_set', { key: 'skills.max_active', value: 1 }, human));
    ok(await p.core.call('settings_set', { key: 'skills.description_max', value: 20 }, human));
    const copiedLines = ['Always bind test servers to an ephemeral port.', 'Never hard-code a port number in any test file.', 'Read the bound port back from the listening server.'];
    await writeFile(path.join(world.a.dir, 'CLAUDE.md'), `# House rules\n\n${copiedLines.join('\n')}\n`);
    const copying = createResult(second, 'free-ports', `# Free ports\n\n${copiedLines.join('\n')}\n`);
    expect(ok(await submit(second, copying))).toMatchObject({ result: 'failed', reasons: ['at_cap', 'copied', 'description_too_long'] });
  });

  test('a create naming a skill a human deleted is blocked_name; the same text as a pending proposal is duplicate_pending', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const human = terminal(grimoire.ctx);
    // A human wrote and then deleted free-ports: the name stays blocked.
    ok(await p.core.call('skill_edit', { name: 'free-ports', text: skillText('free-ports', 'Old ports advice.', '# Old\n'), base: null }, human));
    await removeSkill(world.a, world.a, 'free-ports');
    expect(ok(await submit(p, createResult(p, 'free-ports', longBody(5))))).toMatchObject({ result: 'invalid', reasons: ['blocked_name'] });
    const { proposal } = ok(await submit(p, patchResult(p)));

    // A second slot, and the same text again.
    ok(await p.core.call('settings_set', { key: 'proposals.pending_limit', value: 2 }, human));
    const again = await manualRun(p);
    expect(ok(await submit(again, patchResult(again)))).toMatchObject({ result: 'invalid', reasons: ['duplicate_pending'], problems: { text: expect.stringContaining(proposal!) } });
  });
});
