// Quarantine (spec §17, §18, §7): a human's mark that keeps a pattern page or
// a trace out of knowledge chores and out of a skill proposal's evidence,
// without editing or purging it; lifting it records a clear. Both are
// human-only, and both are ledger record kinds, targeting `{page: <slug>}` or
// `{trace: <attempt handle>}`. Whether a target is quarantined is derived: a
// mark that no clear lifts. Quarantining a trace also flags (shown, never
// filtered) the other pages the compiles that consumed it wrote.
import { GrimoireError, invalid } from '../errors';
import { activeQuarantine } from '../knowledge/chores/quarantine';
import type { TrackerView } from '../tracker';
import { parseHandle, recordedActor } from './attempts';
import { define, oneLine, writer } from './op';
import { s } from './schema';
import { parseSlug } from './wiki';

/** Every decision in v1 is a person's: the basis every record carries (spec §18). */
const BASIS = 'human review';

export interface QuarantineResult {
  /** The page, for a page's quarantine. */
  page?: string;
  /** The trace (its attempt handle), for a trace's quarantine. */
  trace?: string;
  quarantined: boolean;
  /** False when the target already stood that way: nothing was written. */
  changed: boolean;
  /** The record this call wrote, if any. */
  record?: string;
}

/** A ledger record's versions for a target it leaves as it is: from and to are both the version the actor saw. */
const unchanged = (version: string | null) => ({ from: version, to: version, saw: version === null ? [] : [version] });

type Target = { page: string } | { trace: string };

/** The target a call names: exactly one of `page` and `trace`. */
function targetOf(input: { page?: string | undefined; trace?: string | undefined }): Target {
  if ((input.page === undefined) === (input.trace === undefined)) {
    throw invalid({ page: 'name exactly one of page (a slug) and trace (an attempt handle)' });
  }
  return input.page !== undefined ? { page: parseSlug(input.page, 'page') } : { trace: parseHandle(input.trace!, 'trace') };
}

/**
 * The version of the target the actor saw: a page's version; a trace has
 * none (it never changes once sealed), so its records carry none. NOT_FOUND
 * for a page or an ended attempt that doesn't exist.
 */
async function versionOf(view: TrackerView, target: Target): Promise<string | null> {
  if ('page' in target) {
    const page = await view.wiki.page(target.page);
    if (!page) throw new GrimoireError('NOT_FOUND', `there is no wiki page ${target.page}`, { slug: target.page });
    return page.version;
  }
  const attempt = view.attempt(target.trace);
  if (!attempt) throw new GrimoireError('NOT_FOUND', `there is no trace ${target.trace}`, { trace: target.trace });
  if (!attempt.end) throw invalid({ trace: `${target.trace} is still open; a trace exists once its attempt ends` });
  return null;
}

async function marksOn(view: TrackerView, target: Target) {
  const active = await activeQuarantine(view);
  return ('page' in target ? active.pages.get(target.page) : active.traces.get(target.trace)) ?? [];
}

const targetInput = {
  page: s.optional(s.string({ ...oneLine, description: 'the page’s slug' })),
  trace: s.optional(s.string({ ...oneLine, description: 'or the trace: its attempt handle (at-…)' })),
};

export const quarantine = define({
  name: 'quarantine',
  description:
    'Quarantine a wiki page or a trace, with a reason: it stays out of knowledge chores and skill-proposal evidence, unedited, until someone lifts it. A quarantined trace flags the other pages its compiles wrote. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({
    ...targetInput,
    reason: s.string({ nonBlank: true, description: 'why it is quarantined (required)' }),
  }),
  async run(input, { ctx, tracker, actor, requestSync }): Promise<QuarantineResult> {
    const author = writer(ctx);
    const target = targetOf(input);
    const write = await tracker.transact<QuarantineResult>({ op: 'quarantine', author, actor }, async (draft) => {
      const saw = await versionOf(draft, target);
      if ((await marksOn(draft, target)).length > 0) return { result: { ...target, quarantined: true, changed: false } };
      const mark = draft.quarantine.add({
        kind: 'quarantine-mark',
        target,
        clears: [],
        reason: input.reason.trim(),
        ...unchanged(saw),
        basis: BASIS,
        surface: ctx.surface,
        actor: recordedActor(author.email, actor),
        by: author.email,
      });
      return { result: { ...target, quarantined: true, changed: true, record: mark.id } };
    });
    // A human knowledge decision triggers the automatic sync (spec §4).
    if (write.commit) requestSync(write.commit);
    return write.result;
  },
});

export const unquarantine = define({
  name: 'unquarantine',
  description: 'Lift a wiki page’s or a trace’s quarantine: it is served to knowledge chores and counts as evidence again. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({
    ...targetInput,
    reason: s.optional(s.string({ description: 'why it is lifted' })),
  }),
  async run(input, { ctx, tracker, actor, requestSync }): Promise<QuarantineResult> {
    const author = writer(ctx);
    const target = targetOf(input);
    const write = await tracker.transact<QuarantineResult>({ op: 'unquarantine', author, actor }, async (draft) => {
      const saw = await versionOf(draft, target);
      const marks = await marksOn(draft, target);
      if (marks.length === 0) return { result: { ...target, quarantined: false, changed: false } };
      const clear = draft.quarantine.add({
        kind: 'quarantine-clear',
        target,
        clears: marks.map((mark) => mark.id),
        reason: (input.reason ?? '').trim(),
        ...unchanged(saw),
        basis: BASIS,
        surface: ctx.surface,
        actor: recordedActor(author.email, actor),
        by: author.email,
      });
      return { result: { ...target, quarantined: false, changed: true, record: clear.id } };
    });
    if (write.commit) requestSync(write.commit);
    return write.result;
  },
});
