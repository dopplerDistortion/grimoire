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

/** Whether `slug` is a page slug: kebab-case, lowercase letters and digits, at most 64 characters. */
export function isSlug(slug: string): boolean {
  return SLUG.test(slug) && slug.length <= SLUG_LIMIT;
}

/** A page's slug, as a write names it: kebab-case, lowercase letters and digits, at most 64 characters. */
export function parseSlug(input: string, field = 'slug'): string {
  const slug = input.trim();
  if (!isSlug(slug)) {
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
  const problems = pageWriteProblems(page, previous, scanner, 'human');
  if (problems.length > 0) throw invalid(Object.fromEntries(problems.map((problem) => [problem.field, problem.message])));
}

/** Why a page write is refused: a reason code (spec §16), the field and a message that never quotes the text. */
export interface PageProblem {
  readonly field: 'title' | 'summary' | 'body';
  readonly code: 'summary_too_long' | 'page_too_long' | 'page_shrinks' | 'secret' | 'unscanned' | 'hygiene';
  readonly message: string;
  /** `secret`: the rule ids that matched. */
  readonly rules?: readonly string[];
}

const HYGIENE_WORDS: Readonly<Record<string, string>> = {
  'control-character': 'hidden control characters',
  'conflict-marker': 'conflict markers',
  html: 'raw HTML',
  'grimoire-path': 'a path into the .grimoire folder',
  'remote-content': 'a reference to remote content',
};

/**
 * The page-write guards (see checkPageWrite) as reason codes. `human` hygiene
 * refuses only what a person's own text trips by accident (hidden characters,
 * conflict markers); `agent` hygiene, for a chore write, refuses every finding.
 */
export function pageWriteProblems(
  page: { title: string; summary: string; body: string },
  previous: readonly string[],
  scanner: SecretScanner,
  hygiene: 'human' | 'agent',
): PageProblem[] {
  const problems = new Map<PageProblem['field'], PageProblem>();
  if (characters(page.summary) > SUMMARY_LIMIT) {
    problems.set('summary', { field: 'summary', code: 'summary_too_long', message: `holds ${characters(page.summary)} characters; at most ${SUMMARY_LIMIT}` });
  }
  const length = characters(page.body);
  if (length > PAGE_CHARACTER_CAP) {
    problems.set('body', {
      field: 'body',
      code: 'page_too_long',
      message: `holds ${length.toLocaleString('en-US')} characters; a page holds at most ${PAGE_CHARACTER_CAP.toLocaleString('en-US')}`,
    });
  } else if (previous.length > 0) {
    const larger = Math.max(...previous.map(characters));
    if (length < larger * (1 - PAGE_SHRINK_LIMIT)) {
      problems.set('body', {
        field: 'body',
        code: 'page_shrinks',
        message: `holds ${length.toLocaleString('en-US')} characters, down from ${larger.toLocaleString('en-US')}: a write may shrink a page by at most ${PAGE_SHRINK_LIMIT * 100}% of the larger side`,
      });
    }
  }
  for (const field of ['title', 'summary', 'body'] as const) {
    if (problems.has(field)) continue;
    const scan = scanner.scan(page[field]);
    if (scan.status !== 'scanned') {
      problems.set(field, { field, code: 'unscanned', message: 'could not be scanned for secrets, so it is not written' });
      continue;
    }
    if (scan.hits.length > 0) {
      const rules = sortedUnique(scan.hits.map((hit) => hit.rule));
      problems.set(field, { field, code: 'secret', message: `holds what looks like a secret (${rules.join(', ')}); remove it`, rules });
      continue;
    }
    const report = checkHygiene(page[field]);
    if (report.status !== 'checked') {
      problems.set(field, { field, code: 'hygiene', message: 'could not be checked, so it is not written' });
      continue;
    }
    const found = sortedUnique(report.findings.map((f) => f.check)).filter(
      (check) => hygiene === 'agent' || check === 'control-character' || check === 'conflict-marker',
    );
    if (hygiene === 'human') {
      if (found.includes('control-character')) problems.set(field, { field, code: 'hygiene', message: 'holds hidden control characters; remove them' });
      else if (found.includes('conflict-marker')) {
        problems.set(field, { field, code: 'hygiene', message: 'holds conflict markers; reconcile the sides and remove the markers' });
      }
    } else if (found.length > 0) {
      problems.set(field, { field, code: 'hygiene', message: `holds ${found.map((check) => HYGIENE_WORDS[check] ?? check).join(', ')}; remove it` });
    }
  }
  return [...problems.values()];
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

/** One line of the wiki's log (spec §17: derived from human wiki edits and compile runs). */
export interface WikiLogEntry {
  at: string;
  kind: 'edit' | 'compile';
  /** An edit's `create` or `update`; `compile` for a run. */
  action: string;
  /** The person: an edit's author, a compile run's. */
  by: string | null;
  /** A compile's run id. */
  run: string | null;
  /** The pages it wrote. */
  pages: string[];
  /** A compile: the traces it consumed. */
  traces: number;
  /** The set-aside sides it reconciled. */
  resolved: number;
}

export interface WikiListResult {
  pages: WikiListRow[];
  /** The log, oldest first (at one instant, edits before compiles). */
  log: WikiLogEntry[];
}

export const wikiList = define({
  name: 'wiki_list',
  description: 'List the wiki’s pages (slug, title, kind, summary, sources, and whether each is conflicted or quarantined) and its log of human edits and compiles. Human-read.',
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
    const person = (actor: Readonly<Record<string, unknown>>) => (typeof actor.person === 'string' ? actor.person : null);
    const entries = [
      ...(await view.wiki.edits()).map((edit, i) => ({
        rank: 0,
        i,
        entry: { at: edit.at, kind: 'edit' as const, action: edit.action, by: person(edit.actor), run: null, pages: [edit.slug], traces: 0, resolved: edit.resolved.length },
      })),
      ...(await view.choreRuns.records())
        .filter((run) => run.kind === 'wiki-maintainer' && run.result === 'compiled')
        .map((run, i) => ({
          rank: 1,
          i,
          entry: { at: run.at, kind: 'compile' as const, action: 'compile', by: person(run.actor), run: run.id, pages: Object.keys(run.pages).sort(), traces: run.consumption.length, resolved: run.resolved.length },
        })),
    ];
    entries.sort((x, y) => (x.entry.at < y.entry.at ? -1 : x.entry.at > y.entry.at ? 1 : x.rank - y.rank || x.i - y.i));
    return { pages: rows, log: entries.map((item) => item.entry) };
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
