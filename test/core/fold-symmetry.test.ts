// The order-independence of folds (spec Testing Decisions, seam 1): two clones
// and a bare remote make generated concurrent edits, each fetches the other's
// tracker, and fold(A, B) and fold(B, A) must build identical trees. Later
// rounds fold folds, so their merge bases criss-cross (a recursive virtual base).
//
// GRIMOIRE_FOLD_SEEDS=<n> runs more generated histories. Ids come from the seed
// too, so a failing seed replays the same history; its message lists the ops.
import { describe, expect } from 'vitest';
import type { CallContext, Core } from '../../src/core';
import { openTracker } from '../../src/tracker';
import type { Checkout, GitWorld } from '#harness';
import {
  agentContext,
  commitToTracker,
  coreTest as test,
  fetchTracker,
  fetchTrackerFrom,
  issuePath,
  pushTracker,
  T0,
  trackerTip,
  type Grimoire,
} from './support';

const SEEDS = Number(process.env.GRIMOIRE_FOLD_SEEDS ?? 2);
const ROUNDS = 3;
const OPS_PER_ROUND = 8;

/** A small seeded PRNG (mulberry32): the same seed generates the same history. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

interface Clone {
  readonly name: string;
  readonly checkout: Checkout;
  readonly core: Core;
  readonly ctx: CallContext;
  /** The instant the clone's next write records (a few seconds apart, sometimes equal across clones). */
  tick: number;
  /** Open attempts this clone's person holds: issue id → handle. */
  readonly held: Map<string, string>;
  /** The next id suffix to mint, when a round wants both clones to mint the same id. */
  forcedSuffix: string | null;
}

const DEBRIEF = { asked: 'a', tried: 'b', failed: 'none', worked: 'c', next: 'none' };
const LABELS = ['bug', 'ui', 'area:core', 'p1'];

async function ids(clone: Clone): Promise<string[]> {
  const listed = await clone.core.call('list', { limit: 200 }, clone.ctx);
  return listed.ok ? listed.result.rows.map((row) => row.id) : [];
}

/** One generated edit on `clone`; refusals (anchors, conflicts, claims) are part of the game. */
interface Counter {
  n: number;
  /** Where each comment a clone made lives: `/<id>/comments/<comment>.md`. */
  readonly comments: string[];
  /** Every generated op, in order: a failing seed's message lists them. */
  readonly ops: string[];
}

/** The tracker file at `file` on the clone's local tip, or null. */
async function localFile(clone: Clone, file: string): Promise<string | null> {
  const tip = await trackerTip(clone.checkout);
  const read = tip ? await clone.checkout.gitResult(['cat-file', 'blob', `${tip}:${file}`]) : null;
  return read && read.code === 0 ? read.stdout : null;
}

/** The files under `dir` on the clone's local tip. */
async function localFiles(clone: Clone, dir: string): Promise<string[]> {
  const tip = await trackerTip(clone.checkout);
  const listed = tip ? await clone.checkout.git(['ls-tree', '-r', '--name-only', tip, '--', dir]) : '';
  return listed.split('\n').filter((line) => line !== '');
}

/** `key: <JSON>` lines with one key set (the settings and marker line format). */
function withLine(text: string | null, key: string, raw: string): string {
  const lines = (text ?? '').split('\n').filter((line) => line !== '' && !line.startsWith(`${key}: `));
  return `${[...lines, `${key}: ${raw}`].join('\n')}\n`;
}

async function edit(clone: Clone, rand: () => number, counter: Counter): Promise<void> {
  const pick = <T>(items: readonly T[]): T | undefined => items[Math.floor(rand() * items.length)];
  // Two instants only, so both clones often stamp the same `updated_at` and the byte tie-breaks decide.
  clone.tick = rand() < 0.5 ? 0 : 1;
  const at = new Date(T0.getTime() + clone.tick * 1000).toISOString();
  const all = await ids(clone);
  const id = pick(all);
  const n = counter.n++;
  const call = (op: string, input: Record<string, unknown>) => clone.core.call(op, input, clone.ctx);
  // Few issues, many edits each: concurrent edits of one record are the point.
  // Retitles (1, 12, 13) are weighted up: a scalar collision needs both sides on one field of one issue.
  const choice = id === undefined || (all.length < 3 && rand() < 0.3) ? 0 : 1 + Math.floor(rand() * 24);
  const attempts = id ? `attempts/${id[3]}/${id[4]}/${id}` : '';
  counter.ops.push(`${clone.name} #${n}: ${choice} on ${id ?? '-'} at +${clone.tick}s`);
  switch (choice) {
    case 0:
      await call('create', {
        title: `${clone.name} ${n}`,
        body: `# ${clone.name} ${n}\n\n- [ ] one\n- [ ] two\n\n## Done\n`,
        labels: LABELS.filter(() => rand() < 0.3),
      });
      return;
    case 1:
    case 12:
    case 13:
      await call('update', { id, title: `${clone.name} retitled ${n}` });
      return;
    case 2:
      await call('update', { id, labels_add: [pick(LABELS)!] });
      return;
    case 3: {
      const shown = await call('show', { ref: id!, comments: 'none' });
      const labels = shown.ok ? (shown.result as { labels: string[] }).labels : [];
      if (labels.length > 0) await call('update', { id, labels_remove: [pick(labels)!] });
      return;
    }
    case 4:
    case 5: {
      const shown = await call('show', { ref: id!, comments: 'none' });
      const body = shown.ok ? ((shown.result as { body?: string }).body ?? '') : '';
      const lines = body.split('\n').filter((line) => line !== '');
      const anchor = pick(lines);
      if (!anchor) return;
      const op =
        choice === 4
          ? { op: 'insert_before', anchor: `${anchor}\n`, text: `- [ ] ${clone.name} ${n}\n` }
          : { op: 'replace', anchor, text: `${anchor} (${clone.name} ${n})` };
      await call('update', { id, body_patch: [op] });
      return;
    }
    case 6:
      await call('update', { id, body_patch: [{ op: 'append', text: `- ${clone.name} ${n}\n` }] });
      return;
    case 7:
    case 8: {
      const added = await call('comment', { id, body: `${clone.name} says ${n}` });
      if (added.ok) counter.comments.push(`/${id}/comments/${(added.result as { id: string }).id}.md`);
      return;
    }
    case 9: {
      const claimed = await call('claim', { id });
      if (claimed.ok) clone.held.set(id!, (claimed.result as { attempt: string }).attempt);
      return;
    }
    case 10: {
      // Ending your own handle, by the id it was claimed by (even after a collision moved it).
      const [issue, attempt] = pick([...clone.held]) ?? [];
      if (!issue) return;
      clone.held.delete(issue);
      if (rand() < 0.5) await call('close', { id: issue, attempt, reason: rand() < 0.7 ? 'done' : 'canceled', debrief: DEBRIEF });
      else await call('release', { id: issue, attempt, debrief: DEBRIEF });
      return;
    }
    case 11:
      await call('update', { id, blocked_by_add: [pick(all)!] });
      return;
    case 14:
      // An unclaimed close: closes on both clones leave a status conflict.
      await call('close', { id, reason: rand() < 0.5 ? 'canceled' : 'done', debrief: DEBRIEF });
      return;
    case 15:
      await call('update', { id, parent: rand() < 0.2 ? null : pick(all) });
      return;
    case 16:
      await call('update', { id, links_add: [{ target: `https://forge.example/${pick(['a', 'b', 'c'])}`, title: clone.name }] });
      return;
    case 17: {
      // A store setting, written raw: settings fold per key.
      const key = pick(['link_base', 'future_setting'])!;
      const value = key === 'link_base' ? `https://${clone.name}.example/${n}/` : n;
      const raw = JSON.stringify({ value, at, by: `${clone.name}@example.com` });
      await commitToTracker(clone.checkout, { 'settings.yml': withLine(await localFile(clone, 'settings.yml'), key, raw) });
      return;
    }
    case 18: {
      // A newer release's key in the format marker: markers fold to the field-wise maximum.
      const key = pick(['wiki', 'skills'])!;
      await commitToTracker(clone.checkout, { format: withLine(await localFile(clone, 'format'), key, String(n)) });
      return;
    }
    case 19: {
      // A newer release's frontmatter key, written into the issue raw.
      const record = await localFile(clone, issuePath(id!));
      if (!record) return;
      const close = record.indexOf('\n---\n', 3);
      if (close < 0) return;
      const key = pick(['priority', 'estimate'])!;
      const front = record.slice(0, close).split('\n').filter((line) => !line.startsWith(`${key}: `));
      const next = `${[...front, `${key}: ${JSON.stringify(`${clone.name} ${n}`)}`].join('\n')}${record.slice(close)}`;
      await commitToTracker(clone.checkout, { [issuePath(id!)]: next });
      return;
    }
    case 20: {
      // A delete (a human op): the issue directory goes and a tombstone stays.
      if (all.length < 4) return;
      const files = await localFiles(clone, issuePath(id!).replace(/\/issue\.md$/, ''));
      if (files.length === 0) return;
      await commitToTracker(clone.checkout, {
        ...Object.fromEntries(files.map((file) => [file, null])),
        [`deleted/${id}.md`]: `---\nby: "${clone.name}@example.com"\nat: "${at}"\n---\n`,
      });
      return;
    }
    case 21:
    case 22:
    case 23: {
      // Attempt traces, written raw: purge an ended attempt (21), override its outcome as a human (22), or cut a session record of an open one (23).
      const files = await localFiles(clone, attempts);
      const ended = [...new Set(files.filter((f) => f.endsWith('/end.md')).map((f) => f.split('/')[4]!))];
      const open = [...new Set(files.filter((f) => f.endsWith('/start.md')).map((f) => f.split('/')[4]!))].filter(
        (handle) => !ended.includes(handle),
      );
      const outcome = (handle: string) => `outcomes/${id![3]}/${id![4]}/${id}/${handle}.md`;
      if (choice === 23) {
        const handle = pick(open);
        if (!handle) return;
        const reach = JSON.stringify({ at, ref: String(Math.floor(rand() * 20)) });
        const record = `---\nreach: ${reach}\n---\n${clone.name} ${n}\n`;
        await commitToTracker(clone.checkout, { [`${attempts}/${handle}/sessions/s${Math.floor(rand() * 2)}.md`]: record });
        return;
      }
      const handle = pick(ended);
      if (!handle) return;
      if (choice === 21) {
        await commitToTracker(clone.checkout, {
          ...Object.fromEntries(files.filter((f) => f.split('/')[4] === handle).map((f) => [f, null])),
          [outcome(handle)]: null,
          [`purges/${handle}.md`]: `---\nby: "${clone.name}@example.com"\nat: "${at}"\nreason: "test"\n---\n`,
        });
      } else {
        const verdict = pick(['pass', 'fail', 'none'])!;
        await commitToTracker(clone.checkout, {
          [outcome(handle)]: `---\nverdict: "${verdict}"\nreason: "${clone.name} ${n}"\nset_by: "human:${clone.name}@example.com"\nat: "${at}"\n---\n`,
        });
      }
      return;
    }
    default:
      // A newer release's file, written raw.
      await commitToTracker(clone.checkout, { [`future/${pick(['x', 'y', 'z'])}.json`]: `{"by":"${clone.name}","n":${n}}\n` });
  }
}

/** Both clones mint this id for records of their own: the fold must keep them apart. */
const COLLIDED = 'c1m0x';

async function mintTogether(clones: readonly Clone[], counter: Counter): Promise<void> {
  for (const clone of clones) {
    clone.forcedSuffix = COLLIDED;
    await clone.core.call('create', { title: `${clone.name} collides`, body: `# ${clone.name} collides\n\n## Done\n` }, clone.ctx);
    clone.forcedSuffix = null;
  }
  counter.ops.push(`both mint gr-${COLLIDED}`);
}

/**
 * Edits both clones make to shared issues in the same round: on one issue a
 * retitle and an insert at the same anchor, on the next a rewrite of the same
 * line. So every round folds a scalar collision (often at one `updated_at`),
 * concurrent inserts that must merge, and overlapping hunks that must conflict.
 */
async function collide(clones: readonly Clone[], rand: () => number, round: number, counter: Counter): Promise<void> {
  const shared = (await ids(clones[0]!)).sort();
  if (shared.length === 0) return;
  const [inserted, rewritten] = [shared[round % shared.length]!, shared[(round + 1) % shared.length]!];
  counter.ops.push(`collide on ${inserted} and ${rewritten}`);
  for (const clone of clones) {
    clone.tick = rand() < 0.5 ? 0 : 1;
    const call = (op: string, input: Record<string, unknown>) => clone.core.call(op, input, clone.ctx);
    await call('update', { id: inserted, title: `${clone.name} wins round ${round}?` });
    await call('update', {
      id: inserted,
      body_patch: [{ op: 'insert_before', anchor: '\n## Done\n', text: `\n- [ ] ${clone.name} r${round}` }],
    });
    if (rewritten === inserted) continue;
    const shown = await call('show', { ref: rewritten, comments: 'none' });
    const body = shown.ok ? ((shown.result as { body?: string }).body ?? '') : '';
    const line = body.split('\n').find((text) => text.startsWith('# '));
    if (line) await call('update', { id: rewritten, body_patch: [{ op: 'replace', anchor: line, text: `${line} ${clone.name}` }] });
  }
}

async function treeOf(checkout: Checkout): Promise<string> {
  return checkout.git(['rev-parse', `${(await trackerTip(checkout))!}^{tree}`]);
}

/** Commits the fold in `checkout` when there is one to commit. */
async function commitFold(checkout: Checkout, clone: GitWorld['a']): Promise<void> {
  const store = await openTracker(checkout.dir);
  try {
    await store.fold({ author: { ...clone.identity }, actor: { kind: 'human', client: 'cli', nonce: 'fold' } });
  } finally {
    await store.close();
  }
}

function clonesOf(world: GitWorld, grimoire: Grimoire, seed: number): [Clone, Clone] {
  const make = (name: string, checkout: GitWorld['a'], ctx: CallContext, k: number): Clone => {
    // Ids from the seed, each clone's own first character so they clash only when a round forces it.
    const draw = random(seed * 104_729 + k);
    const clone: Clone = {
      name,
      checkout,
      ctx,
      tick: 0,
      held: new Map(),
      forcedSuffix: null,
      core: grimoire.makeCore({
        clock: () => new Date(T0.getTime() + clone.tick * 1000),
        randomIdSuffix: (length) =>
          clone.forcedSuffix ?? name[0] + Array.from({ length: length - 1 }, () => CROCKFORD[Math.floor(draw() * 32)]).join(''),
      }),
    };
    return clone;
  };
  return [make('alice', world.a, grimoire.ctx, 1), make('bob', world.b, agentContext(world.b), 2)];
}

describe('fold order-independence', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    test(`fold(A, B) and fold(B, A) build identical trees over generated concurrent edits (seed ${seed})`, async ({
      world,
      grimoire,
    }) => {
      const rand = random(seed * 7919);
      await pushTracker(world.a);
      await fetchTracker(world.b);
      await world.b.git(['update-ref', 'refs/grimoire/tracker', 'refs/remotes/origin/grimoire/tracker']);
      const [alice, bob] = clonesOf(world, grimoire, seed);
      const counter: Counter = { n: 0, comments: [], ops: [] };
      const history = () => `seed ${seed}, ops:\n${counter.ops.join('\n')}`;

      for (let round = 0; round < ROUNDS; round++) {
        await collide([alice, bob], rand, round, counter);
        for (let i = 0; i < OPS_PER_ROUND; i++) {
          await edit(alice, rand, counter);
          await edit(bob, rand, counter);
        }
        if (round === 1) await mintTogether([alice, bob], counter);
        await fetchTrackerFrom(world.a, world.b);
        await fetchTrackerFrom(world.b, world.a);
        const [aliceSees, bobSees] = await Promise.all([ids(alice), ids(bob)]);
        await commitFold(world.a, world.a);
        await commitFold(world.b, world.b);

        expect(aliceSees.sort(), `round ${round}: the merged views list the same issues (${history()})`).toEqual(bobSees.sort());
        expect(await treeOf(world.a), `round ${round}: fold(A, B) and fold(B, A) differ (${history()})`).toBe(await treeOf(world.b));
        if (round === 1) expect(aliceSees.filter((id) => id.startsWith(`gr-${COLLIDED}~`)), history()).toHaveLength(2);
        counter.ops.push(`-- round ${round} folded`);
      }
      // Every comment either clone made survived every fold, unless its issue was deleted.
      const tip = (await trackerTip(world.a))!;
      const tree = (await world.a.git(['ls-tree', '-r', '--name-only', tip])).split('\n');
      const deleted = new Set(tree.filter((file) => file.startsWith('deleted/')).map((file) => file.slice(8, -3)));
      expect(counter.comments.length).toBeGreaterThan(0);
      for (const comment of counter.comments) {
        if (!deleted.has(comment.split('/')[1]!)) expect(tree.some((file) => file.endsWith(comment)), comment).toBe(true);
      }
    }, 300_000);
  }
});
