// Quarantine (spec §17, §18, §7): a human's mark that keeps a pattern page out
// of knowledge chores and out of a skill proposal's evidence, without editing
// it; lifting it records a clear. Both are human-only, and both are ledger
// record kinds. Whether a page is quarantined is derived: a mark that no clear
// lifts. (Trace quarantine comes with the chore engine, on the same records.)
import { GrimoireError } from '../errors';
import type { TrackerView } from '../tracker';
import { recordedActor } from './attempts';
import { define, oneLine, writer } from './op';
import { s } from './schema';
import { parseSlug, quarantinedPages } from './wiki';

/** Every decision in v1 is a person's: the basis every record carries (spec §18). */
const BASIS = 'human review';

export interface QuarantineResult {
  page: string;
  quarantined: boolean;
  /** False when the page already stood that way: nothing was written. */
  changed: boolean;
  /** The record this call wrote, if any. */
  record?: string;
}

async function pageVersionOf(view: TrackerView, slug: string): Promise<string> {
  const page = await view.wiki.page(slug);
  if (!page) throw new GrimoireError('NOT_FOUND', `there is no wiki page ${slug}`, { slug });
  return page.version;
}

export const quarantine = define({
  name: 'quarantine',
  description: 'Quarantine a wiki page, with a reason: it stays out of knowledge chores and skill-proposal evidence, unedited, until someone lifts it. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({
    page: s.string({ ...oneLine, description: 'the page’s slug' }),
    reason: s.string({ nonBlank: true, description: 'why it is quarantined (required)' }),
  }),
  async run(input, { ctx, tracker, actor, requestSync }): Promise<QuarantineResult> {
    const author = writer(ctx);
    const slug = parseSlug(input.page, 'page');
    const write = await tracker.transact<QuarantineResult>({ op: 'quarantine', author, actor }, async (draft) => {
      const saw = await pageVersionOf(draft, slug);
      if ((await quarantinedPages(draft)).has(slug)) return { result: { page: slug, quarantined: true, changed: false } };
      const mark = draft.quarantine.add({
        record: 'quarantine-mark',
        target: { page: slug },
        clears: [],
        reason: input.reason.trim(),
        actor: recordedActor(author.email, actor),
        basis: BASIS,
        surface: ctx.surface,
        saw,
      });
      return { result: { page: slug, quarantined: true, changed: true, record: mark.id } };
    });
    // A human knowledge decision triggers the automatic sync (spec §4).
    if (write.commit) requestSync(write.commit);
    return write.result;
  },
});

export const unquarantine = define({
  name: 'unquarantine',
  description: 'Lift a wiki page’s quarantine: it is served to knowledge chores and counts as evidence again. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({
    page: s.string({ ...oneLine, description: 'the page’s slug' }),
    reason: s.optional(s.string({ description: 'why it is lifted' })),
  }),
  async run(input, { ctx, tracker, actor, requestSync }): Promise<QuarantineResult> {
    const author = writer(ctx);
    const slug = parseSlug(input.page, 'page');
    const write = await tracker.transact<QuarantineResult>({ op: 'unquarantine', author, actor }, async (draft) => {
      const saw = await pageVersionOf(draft, slug);
      const marks = (await quarantinedPages(draft)).get(slug) ?? [];
      if (marks.length === 0) return { result: { page: slug, quarantined: false, changed: false } };
      const clear = draft.quarantine.add({
        record: 'quarantine-clear',
        target: { page: slug },
        clears: marks.map((mark) => mark.id),
        reason: (input.reason ?? '').trim(),
        actor: recordedActor(author.email, actor),
        basis: BASIS,
        surface: ctx.surface,
        saw,
      });
      return { result: { page: slug, quarantined: false, changed: true, record: clear.id } };
    });
    if (write.commit) requestSync(write.commit);
    return write.result;
  },
});
