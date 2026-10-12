// Seam 1 (spec §16 Results: Skill Proposer; §18 Proposals, Mechanical checks,
// Risk flags, Pending lifecycle; ADR 0005, 0006): a Skill Proposer run submits
// at most one proposal; grimoire checks it mechanically, fail-closed, and
// writes an immutable proposal record with the run's chore-run record in one
// tracker commit. The agent gets back only the proposal id and "pending human
// review". An invalid result gets reason codes and one fix-up, then `failed`.
import path from 'node:path';
import { describe, expect } from 'vitest';
import { parseSessionRecord, serializeSessionRecord } from '../../src/capture/session-record';
import { INVALID_RESULTS, readRun, writeRun } from '../../src/knowledge/chores';
import { MachineLocalStore } from '../../src/machine-local';
import { inspectTrees, openTracker, parseProposal, serializeProposal } from '../../src/tracker';
import type { Checkout } from '#harness';
import { choreAgent, putPage, terminal, workPair } from './chore-support';
import { decide, manualRun, ok, PAGE, patchResult, PORTS, proposer, readAll, SKILL, SKILL_V1, submit, type ProposerRun } from './proposer-support';
import { agentContext, commitToTracker, coreTest as test, expectRefUnmoved, fetchTracker, fetchTrackerFrom, pushTracker, T0, trackerFile, trackerTip, TRACKER_REF } from './support';

describe('chore_submit: a Skill Proposer proposal', () => {
  test('a valid patch citing 3 served traces from 2+ issues, 2+ failing, becomes the pending proposal; the agent sees only its id and "pending human review"', async ({
    world,
    grimoire,
  }) => {
    const p = await proposer(grimoire, world);
    const before = (await trackerTip(world.a))!;

    const submitted = ok(await submit(p, patchResult(p)));

    expect(submitted).toEqual({
      run: p.brief.run,
      kind: 'skill-proposer',
      result: 'proposed',
      proposal: expect.stringMatching(/^pp-[0-9a-hjkmnp-tv-z]{10}$/),
      status: 'pending human review',
      summary: `grimoire chores: 1 skill proposal pending human review (${submitted.proposal}); run ${p.brief.run}`,
    });
    // Never an echo of the text.
    expect(JSON.stringify(submitted)).not.toContain('port 0');

    // One commit: the proposal record and the run's record.
    const tip = (await trackerTip(world.a))!;
    expect(await world.a.git(['rev-parse', `${tip}^`])).toBe(before);
    expect(await world.a.git(['log', '-1', '--format=%(trailers:key=Grimoire-Op,valueonly,unfold)', TRACKER_REF])).toBe('propose');
    const changed = (await world.a.git(['diff', '--name-only', before, tip])).split('\n').sort();
    const runFile = `knowledge/chore-runs/${p.brief.run[3]}/${p.brief.run[4]}/${p.brief.run}.md`;
    const proposalPath = `knowledge/proposals/${submitted.proposal}.md`;
    expect(changed).toEqual([runFile, proposalPath].sort());

    // The proposal is self-contained: the whole proposed text, its base and its evidence as served.
    const proposal = await trackerFile(world.a, tip, proposalPath);
    expect(proposal).toContain(`\n---\n${SKILL_V1}${PORTS}`);
    expect(proposal).toContain(`action: "patch"\nskill: "${SKILL}"\nbase: "${p.base}"\n`);
    expect(proposal).toContain(`pages: ["${PAGE}"]`);
    for (const trace of p.fails) expect(proposal).toContain(`{"trace":"${trace}","issue":`);
    expect(proposal).toMatch(/served: \[\{"item":"page:fixed-port-collisions","hash":"[0-9a-f]{64}"\}/);

    // The run's record: proposed, consuming its compile, naming the proposal and no text.
    const record = await trackerFile(world.a, tip, runFile);
    expect(record).toContain('result: "proposed"');
    expect(record).toContain('consumed: ["cr-0000000001"]');
    expect(record).toContain(`proposal: "${submitted.proposal}"`);
    expect(record).not.toContain('port 0');

    // The slot is full: the Skill Proposer isn't due, even on a manual ask.
    const again = await p.core.call('chore_start', { kind: 'skill-proposer', manual: true }, p.chores);
    expect(again).toMatchObject({ ok: false, error: { code: 'NOT_DUE', details: { why: expect.stringContaining('pending human review') } } });
  });
});

describe('chore_submit: repeats, the pending slot and moved bases', () => {
  test('a change near-identical to a rejected one is refused; a dismissed proposal frees the slot', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const { proposal } = ok(await submit(p, patchResult(p)));
    await decide(world.a, world.a, 'reject', SKILL, proposal!, { reason: 'too-vague' });

    const again = await manualRun(p);
    // The same advice in other case and spacing: normalized, the change is the same.
    const reworded = '\n## Ports\n\nbind test servers to   port 0 and read the port back from the server. \n';
    const repeated = ok(await submit(again, patchResult(again, { ops: [{ op: 'append', text: reworded }] })));
    expect(repeated).toMatchObject({ result: 'invalid', reasons: ['repeats_rejected'] });
    // Different advice passes.
    const other = ok(await submit(again, patchResult(again, { ops: [{ op: 'append', text: '\n## Ports\n\nLet the OS pick: listen on port 0, then pass the bound port to the client.\n' }] })));
    expect(other).toMatchObject({ result: 'proposed' });
  });

  test('with proposals.pending_limit 2 the Skill Proposer stays due with one pending proposal, and a second may wait; then the slot is full', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    ok(await submit(p, patchResult(p)));
    ok(await p.core.call('settings_set', { key: 'proposals.pending_limit', value: 2 }, terminal(grimoire.ctx)));

    const second = await manualRun(p);
    const seeds = { ops: [{ op: 'append', text: '\n## Seeds\n\nPrint the seed on failure so the run can be repeated exactly.\n' }] };
    expect(ok(await submit(second, patchResult(second, seeds)))).toMatchObject({ result: 'proposed' });

    const full = await p.core.call('chore_start', { kind: 'skill-proposer', manual: true }, p.chores);
    expect(full).toMatchObject({ ok: false, error: { code: 'NOT_DUE', details: { why: expect.stringContaining('pending human review') } } });
  });

  test('a proposal whose commit landed but whose run end was lost replays proposed on a retry, without PENDING_LIMIT or a second commit', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const submitted = ok(await submit(p, patchResult(p)));
    const tip = await trackerTip(world.a);
    // The process died after the commit: this machine still holds the run open.
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'), world.a.dir);
    await writeRun(store, { ...(await readRun(store, p.brief.run))!, state: 'open', ended_at: null, outcome: undefined });

    expect(ok(await submit(p, patchResult(p)))).toEqual({ ...submitted, replayed: true });
    expect(await trackerTip(world.a)).toBe(tip);
    expect((await readRun(store, p.brief.run))?.state).toBe('ended');
  });

  test('a second submit while one is pending gives PENDING_LIMIT, judged on the merged view; a base moved since serving gives BASE_MOVED; nothing changes', async ({
    world,
    grimoire,
  }) => {
    const p = await proposer(grimoire, world);
    // Clone b takes the tracker and starts its own Skill Proposer run before a's proposal lands.
    await pushTracker(world.a);
    await fetchTracker(world.b);
    await world.b.git(['update-ref', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);
    const chores = await choreAgent(agentContext(world.b));
    const onB: ProposerRun = { ...p, chores, brief: ok(await p.core.call('chore_start', { kind: 'skill-proposer' }, chores)) };
    await readAll(onB.core, onB.chores, onB.brief.run);
    await readAll(onB.core, onB.chores, onB.brief.run, `page:${PAGE}`);

    const { proposal } = ok(await submit(p, patchResult(p)));
    await fetchTrackerFrom(world.b, world.a);
    const seeds = { ops: [{ op: 'append', text: '\n## Seeds\n\nPrint the seed on failure so the run can be repeated exactly.\n' }] };
    const limited = await expectRefUnmoved(world.b, () => submit(onB, patchResult(onB, seeds)));
    expect(limited).toMatchObject({ ok: false, error: { code: 'PENDING_LIMIT', details: { pending: [proposal] } } });

    // Dismissing frees the slot; a human edit then moves the skill off the base a new run was served.
    await decide(world.a, world.a, 'dismiss', SKILL, proposal!);
    const again = await manualRun(p);
    ok(await p.core.call('skill_edit', { name: SKILL, text: `${SKILL_V1}8. Ask a human when nothing else works.
`, base: p.base }, terminal(grimoire.ctx)));
    const moved = await expectRefUnmoved(world.a, () => submit(again, patchResult(again, seeds)));
    expect(moved).toMatchObject({ ok: false, error: { code: 'BASE_MOVED', details: { skill: SKILL, base: p.base } } });
  });
});

/** Commits a session record with excerpt `text` onto a sealed trace, as capture would. */
async function attachExcerpt(checkout: Checkout, trace: string, text: string): Promise<void> {
  const tracker = await openTracker(checkout.dir);
  let issue: string;
  try {
    issue = (await tracker.read()).attempt(trace)!.issue;
  } finally {
    await tracker.close();
  }
  const record = serializeSessionRecord({ ...parseSessionRecord(Buffer.from('---\n---\n')), client: 'claude-code', session: 's1', steps: 3, cut_at: T0.toISOString(), text });
  await commitToTracker(checkout, { [`attempts/${issue[3]}/${issue[4]}/${issue}/${trace}/sessions/0123456789abcdef.md`]: record.toString('utf8') });
}

describe('chore_submit: risk flags and the secret scan', () => {
  test('token origin: a command at the merge-base is green, one only in local commits amber, one only in an excerpt or nowhere red', async ({ world, grimoire }) => {
    // The default branch holds the first command; a local commit past it holds the second.
    await world.a.commitFile('package.json', '{ "scripts": { "test:ports": "npm run test:ports" } }\n');
    await world.a.git(['push', '--quiet', 'origin', 'main']);
    await world.a.git(['remote', 'set-head', 'origin', 'main']);
    await world.a.commitFile('scripts/README.md', 'Run node scripts/port-probe.mjs to list bound ports.\n');
    const p = await proposer(grimoire, world, { read: false });
    await attachExcerpt(world.a, p.fails[0]!, 'I tried npx port-sweeper and it freed the port.');
    await readAll(p.core, p.chores, p.brief.run);
    await readAll(p.core, p.chores, p.brief.run, `page:${PAGE}`);

    const ports = '\n## Ports\n\nRun `npm run test:ports`, then `node scripts/port-probe.mjs`, `npx port-sweeper` and `make free-ports`.\n';
    const { proposal } = ok(await submit(p, patchResult(p, { ops: [{ op: 'append', text: ports }] })));

    const record = await trackerFile(world.a, (await trackerTip(world.a))!, `knowledge/proposals/${proposal}.md`);
    const tokens = JSON.parse(/^tokens: (.*)$/m.exec(record)![1]!) as { token: string; origin: string; found: string }[];
    expect(tokens).toEqual([
      { token: 'npm run test:ports', kind: 'command', origin: 'green', found: 'baseline' },
      { token: 'node scripts/port-probe.mjs', kind: 'command', origin: 'amber', found: 'commit' },
      { token: 'npx port-sweeper', kind: 'command', origin: 'red', found: 'excerpt' },
      { token: 'make free-ports', kind: 'command', origin: 'red', found: 'nowhere' },
    ]);
  });

  test('dangerous patterns are red flags that never reject the proposal', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const risky = '\n## Ports\n\nIf the port stays taken, `sudo lsof -i :8080` shows who holds it.\n';
    const submitted = ok(await submit(p, patchResult(p, { ops: [{ op: 'append', text: risky }] })));
    expect(submitted).toMatchObject({ result: 'proposed' });
    const record = await trackerFile(world.a, (await trackerTip(world.a))!, `knowledge/proposals/${submitted.proposal}.md`);
    expect(JSON.parse(/^flags: (.*)$/m.exec(record)![1]!)).toEqual([{ flag: 'sudo', severity: 'red', detail: 'the proposal runs a command with sudo' }]);
  });

  test('a secret in the rationale blocks the proposal, and no text is kept anywhere', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const token = 'ghp_R7xK2mQ9vL4tB8nW3pZ6cY1hJ5sD0fG2aE9u';
    const claims = { ...(patchResult(p).claims as Record<string, unknown>), rationale: `The CI token ${token} kept expiring.` };

    const first = await expectRefUnmoved(world.a, () => submit(p, patchResult(p, { claims })));
    expect(first).toMatchObject({ ok: true, result: { result: 'invalid', reasons: ['secret'], problems: { 'claims.rationale': expect.stringContaining('secret') } } });
    expect(JSON.stringify(first)).not.toContain(token);
    const second = ok(await submit(p, patchResult(p, { claims })));
    expect(second).toMatchObject({ result: 'failed', reasons: ['secret'] });

    // On this machine: reason codes and rule ids only. On the tracker: no proposal, and the run record holds no text.
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'), world.a.dir);
    const kept = (await store.records.list<Record<string, unknown>>(INVALID_RESULTS)).map((entry) => entry.value);
    expect(kept).toHaveLength(2);
    for (const result of kept) {
      expect(Object.keys(result).sort()).toEqual(['at', 'reasons', 'rules', 'run']);
      expect(JSON.stringify(result)).not.toContain(token);
    }
    const tip = (await trackerTip(world.a))!;
    expect(await world.a.git(['ls-tree', '-r', '--name-only', tip, 'knowledge/proposals'])).toBe('');
    expect(await world.a.git(['grep', '-c', 'ghp_', tip, '--']).catch(() => 'none')).toBe('none');
  });

  test('a secret beside an earlier refusal (a missing anchor, an unknown skill, a bad shape) is still found, and no text is kept', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const token = 'ghp_R7xK2mQ9vL4tB8nW3pZ6cY1hJ5sD0fG2aE9u';
    const claims = { ...(patchResult(p).claims as Record<string, unknown>), rationale: `The CI token ${token} kept expiring.` };

    const anchored = ok(await submit(p, patchResult(p, { claims, ops: [{ op: 'insert-after', anchor: 'no such line', text: '\nx\n' }] })));
    expect(anchored).toMatchObject({ result: 'invalid', reasons: ['anchor_not_found', 'secret'] });
    const unknown = ok(await submit(p, patchResult(p, { target: 'no-such-skill', ops: [{ op: 'append', text: `\n${token}\n` }] })));
    expect(unknown).toMatchObject({ result: 'failed', reasons: ['secret', 'unknown_skill'] });
    const again = await manualRun(p);
    const shaped = ok(await submit(again, { ...patchResult(again), stray: { note: token } }));
    expect(shaped).toMatchObject({ result: 'invalid', reasons: ['secret', 'shape'] });

    const store = new MachineLocalStore(path.join(world.a.dir, '.git'), world.a.dir);
    const kept = (await store.records.list<Record<string, unknown>>(INVALID_RESULTS)).map((entry) => entry.value);
    expect(kept).toHaveLength(3);
    for (const result of kept) {
      expect(Object.keys(result).sort()).toEqual(['at', 'reasons', 'rules', 'run']);
      expect(JSON.stringify(result)).not.toContain(token);
    }
  });

  test('no_action is recorded on the run and consumes its compiles', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const done = ok(await submit(p, { action: 'no_action', client: 'claude-code' }));
    expect(done).toEqual({
      run: p.brief.run,
      kind: 'skill-proposer',
      result: 'no_action',
      summary: `grimoire chores: Skill Proposer found nothing to propose; 1 compile consumed; run ${p.brief.run}`,
    });
    const record = await trackerFile(world.a, (await trackerTip(world.a))!, `knowledge/chore-runs/${p.brief.run[3]}/${p.brief.run[4]}/${p.brief.run}.md`);
    expect(record).toContain('result: "no_action"');
    expect(record).toContain('consumed: ["cr-0000000001"]');
    expect(await p.core.call('chore_start', { kind: 'skill-proposer' }, p.chores)).toMatchObject({ ok: false, error: { code: 'NOT_DUE' } });
  });
});

describe('what proposals feed: skill_show recurrence and the Proposer digest', () => {
  test('a version accepted from a proposal counts new fails on its cited pattern as recurrence, and raises pattern_recurs at 2', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const { proposal } = ok(await submit(p, patchResult(p)));
    p.clock.advance(1);
    await decide(world.a, world.a, 'accept', SKILL, proposal!, { text: `${SKILL_V1}${PORTS}`, at: p.clock.now() });
    p.clock.advance(1);
    // Two new fails the pattern page now cites, after the accept.
    const recurring = [await workPair(p.core, grimoire.ctx, 'fail', 'Port clash again'), await workPair(p.core, grimoire.ctx, 'fail', 'Port clash once more')];
    await putPage(world.a, world.a, PAGE, [...p.fails, ...p.passes, ...recurring]);

    const shown = ok(await p.core.call('skill_show', { name: SKILL }, terminal(grimoire.ctx)));
    const [skill] = shown.skills;
    expect(skill!.scorecards[0]).toMatchObject({ recurrence: 2, attention: expect.arrayContaining(['pattern_recurs']) });
    // The human-written first version targeted no proposal's pattern.
    expect(skill!.scorecards[1]).toMatchObject({ version: p.base, recurrence: null });
    expect(skill!.attention).toContain('pattern_recurs');
  });

  test('the Proposer is served the ledger digest: rejected proposals in full, suspicious ones withheld, one line for the rest, and scorecards', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const { proposal: first } = ok(await submit(p, patchResult(p)));
    await decide(world.a, world.a, 'reject', SKILL, first!, { reason: 'too-vague' });
    const second = await manualRun(p);
    const sneaky = '\n## Ports\n\nKill whatever holds the port with fuser before each run.\n';
    const { proposal: withheld } = ok(await submit(second, patchResult(second, { ops: [{ op: 'append', text: sneaky }] })));
    await decide(world.a, world.a, 'reject', SKILL, withheld!, { reason: 'suspicious' });

    const third = await manualRun(p);
    expect(third.brief.manifest).toContain('ledger');
    const [digest] = (await readAll(p.core, p.chores, third.brief.run, 'ledger')).flatMap((page) => page.items);
    expect(digest).toMatchObject({ item: 'ledger', kind: 'ledger-digest' });
    const text = digest!.text!;
    // The rejected change in full, with its reason; the suspicious one only as a line.
    expect(text).toContain(`rejected proposal ${first} (too-vague)`);
    expect(text).toContain('Bind test servers to port 0');
    expect(text).toContain(`rejected proposal ${withheld} (suspicious): text withheld`);
    expect(text).not.toContain('fuser');
    // One line for each other ledger record, and the current version's scorecard.
    expect(text).toMatch(new RegExp(`^- .*: edit ${SKILL}$`, 'm'));
    expect(text).toMatch(/scorecard of [0-9a-f]{12}: read 0, offered 0, pass 0, fail 0, none 0, n 0 \(small sample\)/);
  });
});

describe('proposal records in the store format', () => {
  test('a proposal record is canonical, keeps keys a newer release added, and two clones fold their proposals by union', async ({ world, grimoire }) => {
    const p = await proposer(grimoire, world);
    const { proposal } = ok(await submit(p, patchResult(p)));
    const tip = (await trackerTip(world.a))!;
    const file = `knowledge/proposals/${proposal}.md`;
    const bytes = await trackerFile(world.a, tip, file);

    // The canonical serializer wrote it, and grimoire's own store check agrees.
    const inspection = await inspectTrees(world.a.dir, { local: tip, remotes: new Map() });
    expect(inspection.records).toEqual([]);
    const parsed = parseProposal(proposal!, Buffer.from(bytes));
    expect(serializeProposal(parsed).toString('utf8')).toBe(bytes);

    // A newer release's key survives a round trip.
    const future = bytes.replace(/\nat: (.*)\n---\n/, '\nat: $1\nzz_future: {"kept":true}\n---\n');
    const reparsed = parseProposal(proposal!, Buffer.from(future));
    expect(reparsed.extra).toEqual({ zz_future: '{"kept":true}' });
    expect(serializeProposal(reparsed).toString('utf8')).toBe(future);

    // Clone b writes a proposal of its own (its slot was free before a's arrived); the fold keeps both.
    await pushTracker(world.a);
    await fetchTracker(world.b);
    const other = 'pp-0123456789';
    await world.b.git(['update-ref', TRACKER_REF, 'refs/remotes/origin/grimoire/tracker']);
    await commitToTracker(world.b, { [`knowledge/proposals/${other}.md`]: serializeProposal({ ...parsed, id: other, run: 'cr-bbbbbbbbbb' }).toString('utf8') });
    await fetchTrackerFrom(world.a, world.b);
    const tracker = await openTracker(world.a.dir);
    try {
      const ids = (await (await tracker.read()).proposals.records()).map((record) => record.id).sort();
      expect(ids).toEqual([other, proposal].sort());
    } finally {
      await tracker.close();
    }
  });
});
