// The wiki's operations (spec §17, §7): `wiki_list` and `wiki_show` are
// human-read (never on MCP; their CLI forms refuse agent markers), and
// `wiki_edit`, the human wiki edit, is human-only. Working agents never see the
// wiki (spec §15): no agent op reads it.
import { GrimoireError, invalid } from '../errors';
import { checkHygiene, type SecretScanner } from '../scanner';
import {
  sortedUnique,
  wikiPageFile,
  type QuarantineRecord,
  type QuarantineView,
  type TrackerView,
  type WikiConflict,
  type WikiPage,
  type WikiPageEntry,
} from '../tracker';
import { activeQuarantine, flaggedPages } from '../knowledge/chores/quarantine';
import { recordedActor } from './attempts';
import { define, oneLine, writer } from './op';
import { s } from './schema';

/** A wiki page's hard cap, in characters (spec §16 chore-write limits, which human edits share). */
export const PAGE_CHARACTER_CAP = 12_000;
/** The most a page may shrink in one write: a quarter of the larger side. */
export const PAGE_SHRINK_LIMIT = 0.25;
/** A page summary's limit, in characters. */
export const SUMMARY_LIMIT = 200;
const SLUG_LIMIT = 64;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PAGE_KINDS = ['failure', 'strategy'] as const;

const characters = (text: string) => [...text].length;

/** A page's slug, as a write names it: kebab-case, lowercase letters and digits, at most 64 characters. */
export function parseSlug(input: string, field = 'slug'): string {
  const slug = input.trim();
  if (!SLUG.test(slug) || slug.length > SLUG_LIMIT) {
    throw invalid({ [field]: `"${input}" is not a page slug (kebab-case: lowercase letters, digits and single hyphens, at most ${SLUG_LIMIT} characters)` });
  }
  return slug;
}

/**
 * The guards a human wiki edit passes (spec §17, sharing the §16 chore-write
 * limits): the summary limit, the 12,000-character cap, at most a 25% shrink
 * against the larger side (the current body, or a set-aside side being
 * reconciled), the secret scan over every text field, and the hygiene checks a
 * person's own text could trip by accident (hidden characters, and conflict
 * markers left from reconciling). Both checks fail closed. INVALID names each
 * failing field and never quotes what it found. A chore write, being agent
 * text, must also refuse every other hygiene finding.
 */
export function checkPageWrite(
  page: { title: string; summary: string; body: string },
  previous: readonly string[],
  scanner: SecretScanner,
): void {
  const problems: Record<string, string> = {};
  if (characters(page.summary) > SUMMARY_LIMIT) problems.summary = `holds ${characters(page.summary)} characters; at most ${SUMMARY_LIMIT}`;
  const length = characters(page.body);
  if (length > PAGE_CHARACTER_CAP) {
    problems.body = `holds ${length.toLocaleString('en-US')} characters; a page holds at most ${PAGE_CHARACTER_CAP.toLocaleString('en-US')}`;
  } else if (previous.length > 0) {
    const larger = Math.max(...previous.map(characters));
    if (length < larger * (1 - PAGE_SHRINK_LIMIT)) {
      problems.body = `holds ${length.toLocaleString('en-US')} characters, down from ${larger.toLocaleString('en-US')}: a write may shrink a page by at most ${PAGE_SHRINK_LIMIT * 100}% of the larger side`;
    }
  }
  for (const field of ['title', 'summary', 'body'] as const) {
    if (problems[field]) continue;
    const scan = scanner.scan(page[field]);
    if (scan.status !== 'scanned') problems[field] = 'could not be scanned for secrets, so it is not written';
    else if (scan.hits.length > 0) {
      problems[field] = `holds what looks like a secret (${sortedUnique(scan.hits.map((hit) => hit.rule)).join(', ')}); remove it`;
    } else {
      const hygiene = checkHygiene(page[field]);
      if (hygiene.status !== 'checked') problems[field] = 'could not be checked, so it is not written';
      else {
        const found = sortedUnique(hygiene.findings.map((f) => f.check).filter((check) => check === 'control-character' || check === 'conflict-marker'));
        if (found.includes('control-character')) problems[field] = 'holds hidden control characters; remove them';
        else if (found.includes('conflict-marker')) problems[field] = 'holds conflict markers; reconcile the sides and remove the markers';
      }
    }
  }
  if (Object.keys(problems).length > 0) throw invalid(problems);
}

/** The quarantined pages, each with the marks that keep it so, oldest first. */
export async function quarantinedPages(view: { quarantine: QuarantineView }): Promise<ReadonlyMap<string, readonly QuarantineRecord[]>> {
  return (await activeQuarantine(view)).pages;
}

function baseMoved(slug: string, current: WikiPageEntry | undefined, why: string): GrimoireError {
  return new GrimoireError('BASE_MOVED', `${why}; read the page again, then redo or replace your edit`, {
    slug,
    current: current?.version ?? null,
  });
}

/** The link to a page's record: `link_base` + its path, or null when no `link_base` is set. */
function pageLink(view: TrackerView, slug: string): string | null {
  const base = view.settings().get('link_base')?.value;
  return typeof base === 'string' && base !== '' ? base + wikiPageFile(slug) : null;
}

export interface WikiEditResult {
  slug: string;
  /** True when the edit created the page. */
  created: boolean;
  /** False when the edit changed nothing: no commit was made. */
  changed: boolean;
  /** The page's version now: the base of a next edit. */
  base: string;
  /** The set-aside sides this edit reconciled. */
  resolved: string[];
}

export const wikiEdit = define({
  name: 'wiki_edit',
  description:
    'Create or edit a wiki page as a human wiki edit: it checks the base, secret-scans the text, applies the 12,000-character cap and the 25% shrink guard, and commits the page with the index and log regenerated. Naming set-aside sides in `resolves` reconciles a conflicted page. Human-only; `grimoire wiki edit <slug>` drives it from your editor.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({
    slug: s.string({ ...oneLine, description: 'the page’s slug (kebab-case)' }),
    base: s.nullable(s.string(oneLine), 'the page version the edit was made on (from wiki_show), or null to create the page'),
    title: s.optional(s.string(oneLine)),
    kind: s.optional(s.literal(PAGE_KINDS)),
    summary: s.optional(s.string({ singleLine: true, description: `at most ${SUMMARY_LIMIT} characters` })),
    body: s.string(),
    resolves: s.optional(s.array(s.string(oneLine), 'the set-aside sides (conflict ids from wiki_show) this edit reconciles')),
  }),
  async run(input, { ctx, tracker, actor, scanner, requestSync }): Promise<WikiEditResult> {
    const author = writer(ctx);
    const slug = parseSlug(input.slug);
    const resolves = sortedUnique((input.resolves ?? []).map((id) => id.trim().toLowerCase()));
    const write = await tracker.transact<WikiEditResult>({ op: 'wiki-edit', author, actor }, async (draft) => {
      const current = await draft.wiki.page(slug);
      const sides = await draft.wiki.conflicts(slug);
      if (input.base === null && current) throw baseMoved(slug, current, `the page ${slug} exists now`);
      if (input.base !== null && !current) throw new GrimoireError('NOT_FOUND', `there is no wiki page ${slug}`, { slug });
      if (input.base !== null && current && current.version !== input.base.trim().toLowerCase()) {
        throw baseMoved(slug, current, `the page ${slug} changed since that version`);
      }
      const resolving = resolves.map((id) => sides.find((side) => side.id === id));
      if (resolving.some((side) => side === undefined)) throw baseMoved(slug, current, `a side of ${slug} you reconciled was already resolved`);
      if (!current) {
        const missing = (['title', 'kind', 'summary'] as const).filter((field) => input[field] === undefined);
        if (missing.length > 0) throw invalid(Object.fromEntries(missing.map((field) => [field, 'is required to create a page'])));
      }
      const title = input.title ?? current!.title;
      const kind = input.kind ?? current!.kind;
      const summary = input.summary ?? current!.summary;
      const reconciled = resolving as WikiConflict[];
      if (current && resolves.length === 0 && title === current.title && kind === current.kind && summary === current.summary && input.body === current.body) {
        return { result: { slug, created: false, changed: false, base: current.version, resolved: [] } };
      }
      checkPageWrite({ title, summary, body: input.body }, current ? [current.body, ...reconciled.map((side) => side.body ?? '')] : [], scanner);
      const at = draft.now.toISOString();
      const page: WikiPage = {
        slug,
        title,
        kind,
        summary,
        // A reconciled side's sources join the page it was folded into.
        sources: sortedUnique([...(current?.sources ?? []), ...reconciled.flatMap((side) => side.sources)]),
        generated: current?.generated ?? null,
        verified: at,
        updated_at: at,
        body: input.body,
        extra: current?.extra ?? {},
      };
      const version = await draft.wiki.putPage(page);
      if (resolves.length > 0) await draft.wiki.dropConflicts(slug, resolves);
      await draft.wiki.addEdit({
        slug,
        action: current ? 'update' : 'create',
        from: current?.version ?? null,
        to: version,
        resolved: resolves,
        actor: recordedActor(author.email, actor),
        surface: ctx.surface,
      });
      return { result: { slug, created: !current, changed: true, base: version, resolved: resolves } };
    });
    // A human knowledge edit triggers the automatic sync (spec §4).
    if (write.commit) requestSync(write.commit);
    return write.result;
  },
});

/** One page as `wiki_list` shows it. */
export interface WikiListRow {
  slug: string;
  title: string;
  kind: string;
  summary: string;
  sources: string[];
  generated: string | null;
  verified: string | null;
  updated_at: string;
  /** A fold set aside another side of it, not yet reconciled. */
  conflicted: boolean;
  /** Kept out of chores and evidence by a human. */
  quarantined: boolean;
  /** Its sources whose trace a human purged: the page keeps its text, and a person may edit it (spec §17). */
  purged_sources: string[];
  /** Quarantined traces a compile that wrote this page consumed: shown, never filtered (spec §17). */
  flagged_by: string[];
}

export interface WikiListResult {
  pages: WikiListRow[];
}

export const wikiList = define({
  name: 'wiki_list',
  description: 'List the wiki’s pages: slug, title, kind, summary, sources, and whether each is conflicted or quarantined. Human-read.',
  kind: 'read',
  policy: 'human-read',
  replay: 'none',
  input: s.object({}),
  async run(_input, { tracker }): Promise<WikiListResult> {
    const view = await tracker.read();
    const quarantined = await quarantinedPages(view);
    const flagged = await flaggedPages(view);
    const pages = await view.wiki.pages();
    const rows = await Promise.all(
      pages.map(async (page) => ({
        slug: page.slug,
        title: page.title,
        kind: page.kind,
        summary: page.summary,
        sources: [...page.sources],
        purged_sources: page.sources.filter((source) => view.tracePurge(source) !== undefined),
        generated: page.generated,
        verified: page.verified,
        updated_at: page.updated_at,
        conflicted: (await view.wiki.conflicts(page.slug)).length > 0,
        quarantined: quarantined.has(page.slug),
        flagged_by: flagged.get(page.slug) ?? [],
      })),
    );
    return { pages: rows };
  },
});

/** A side a fold set aside on a page, as `wiki_show` shows it. */
export interface ShownSide {
  /** Name it in a reconciling edit's `resolves`. */
  id: string;
  /** The fields this side lost: `body`, `title`, `kind`, `summary`. */
  fields: string[];
  title?: string;
  kind?: string;
  summary?: string;
  body?: string;
  /** The set-aside body's own sources. */
  sources: string[];
  at: string;
}

export interface WikiShowResult extends WikiListRow {
  body: string;
  /** The page's version: an edit names it as its base. */
  base: string;
  /** The set-aside sides, oldest first: a conflicted page is served with both sides. */
  sides: ShownSide[];
  /** The page's record on the forge (`link_base` + its path), or null with no `link_base`. */
  link: string | null;
}

export const wikiShow = define({
  name: 'wiki_show',
  description: 'Show one wiki page in full, with its version and, when it is conflicted, every side a fold set aside. Human-read.',
  kind: 'read',
  policy: 'human-read',
  replay: 'none',
  input: s.object({ slug: s.string({ ...oneLine, description: 'the page’s slug' }) }),
  async run(input, { tracker }): Promise<WikiShowResult> {
    const slug = parseSlug(input.slug);
    const view = await tracker.read();
    const page = await view.wiki.page(slug);
    if (!page) throw new GrimoireError('NOT_FOUND', `there is no wiki page ${slug}`, { slug });
    const sides = await view.wiki.conflicts(slug);
    return {
      slug,
      title: page.title,
      kind: page.kind,
      summary: page.summary,
      sources: [...page.sources],
      purged_sources: page.sources.filter((source) => view.tracePurge(source) !== undefined),
      generated: page.generated,
      verified: page.verified,
      updated_at: page.updated_at,
      conflicted: sides.length > 0,
      quarantined: (await quarantinedPages(view)).has(slug),
      flagged_by: (await flaggedPages(view)).get(slug) ?? [],
      body: page.body,
      base: page.version,
      sides: sides.map((side) => ({
        id: side.id,
        fields: [...side.fields],
        ...(side.title !== undefined ? { title: side.title } : {}),
        ...(side.kind !== undefined ? { kind: side.kind } : {}),
        ...(side.summary !== undefined ? { summary: side.summary } : {}),
        ...(side.body !== undefined ? { body: side.body } : {}),
        sources: [...side.sources],
        at: side.at,
      })),
      link: pageLink(view, slug),
    };
  },
});
