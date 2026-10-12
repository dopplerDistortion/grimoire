// A Wiki Maintainer result (spec §16 Results: Wiki Maintainer; §17; ADR 0006):
// page ops and a consumption map, checked fail-closed against the tracker as a
// write round sees it, then written by grimoire's own code. The checks give
// reason codes, never the text they found:
//
//   shape             the result isn't the output schema's shape
//   bad_slug, bad_title, bad_kind
//   summary_too_long  a summary over 200 characters
//   page_too_long     a page over 12,000 characters
//   page_shrinks      an update shrinks a page by more than 25% (of the larger side, reconciling)
//   too_many_pages    more than 8 page writes
//   duplicate_page    two ops on one slug
//   base_moved        an update's base isn't the page now, a create's page exists now,
//                     or a conflicted page gained a side the run wasn't served
//   unknown_slug      the map names a page that neither exists nor is written
//   unserved          an update, or the map, cites an item the run wasn't served
//   missing_pair, unknown_pair, duplicate_pair, bad_consumption
//   hygiene, secret, unscanned
import { isSlug, PAGE_KINDS, pageWriteProblems } from '../../core/wiki';
import { checkHygiene, type SecretScanner } from '../../scanner';
import { sortedUnique, type ConsumedPair, type TrackerDraft, type WikiPage } from '../../tracker';
import type { OpenRun, ServedLog } from './runs';

/** The most pages one compile may write (spec §16). */
export const PAGE_WRITE_LIMIT = 8;
/** The self-reported client and model are capped at this many characters. */
const UNVERIFIED_LIMIT = 64;

/** Why a result was refused. */
export interface Rejection {
  /** Reason codes, sorted. */
  readonly reasons: string[];
  /** What failed where (`pages[0].body`, `consumption[2]`, …): grimoire's words, never the text found. */
  readonly problems: Record<string, string>;
  /** The secret-scan rule ids that matched, sorted. */
  readonly rules: string[];
  /** The secret scan failed or couldn't run: no result text may be kept. */
  readonly secret: boolean;
}

/** One page a compile writes. */
export interface PlannedPage {
  readonly slug: string;
  /** `sources`: an existing page the map names, whose `sources` alone change. */
  readonly action: 'create' | 'update' | 'sources';
  readonly page: WikiPage;
  /** The set-aside sides this write reconciles (a conflicted page's update). */
  readonly resolves: readonly string[];
}

/** An accepted result, ready to write. */
export interface CompilePlan {
  readonly pages: readonly PlannedPage[];
  readonly consumption: readonly ConsumedPair[];
  /** The `no_pattern` reasons, by pair: machine-local only. */
  readonly noPattern: Readonly<Record<string, string>>;
  readonly unverified: { readonly client: string | null; readonly model: string | null };
}

export type CompileCheck = { readonly ok: true; readonly plan: CompilePlan } | { readonly ok: false; readonly rejection: Rejection };

export interface CompileContext {
  readonly draft: TrackerDraft;
  readonly run: OpenRun;
  readonly served: ServedLog;
  readonly scanner: SecretScanner;
  /** Whether a trace may still be served (not purged, not quarantined). */
  readonly servableTrace: (trace: string) => Promise<boolean>;
  /** Whether a page may still be served (not quarantined). */
  readonly servablePage: (slug: string) => boolean;
}

interface CreateOp {
  readonly op: 'create';
  readonly slug: string;
  readonly title: string;
  readonly kind: string;
  readonly summary: string;
  readonly body: string;
}
interface UpdateOp {
  readonly op: 'update';
  readonly slug: string;
  readonly base_hash: string;
  readonly body: string;
}
interface MapEntry {
  readonly pair: string;
  readonly slugs?: readonly string[];
  readonly no_pattern?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';

/** Reason codes and problems as a check collects them. */
export class Problems {
  readonly reasons = new Set<string>();
  readonly problems: Record<string, string> = {};
  readonly rules = new Set<string>();

  add(code: string, field: string, message: string): void {
    this.reasons.add(code);
    this.problems[field] ??= message;
  }

  get empty(): boolean {
    return this.reasons.size === 0;
  }

  rejection(): Rejection {
    const reasons = [...this.reasons].sort();
    return { reasons, problems: this.problems, rules: [...this.rules].sort(), secret: reasons.includes('secret') || reasons.includes('unscanned') };
  }
}

/** The result's shape, as the output schema gives it; null (with `shape` problems) when it isn't. */
function shapeOf(result: unknown, p: Problems): { pages: (CreateOp | UpdateOp)[]; map: MapEntry[]; client: string | null; model: string | null } | null {
  if (!isObject(result)) {
    p.add('shape', 'result', 'must be an object with pages and consumption');
    return null;
  }
  for (const key of Object.keys(result)) if (!['pages', 'consumption', 'client', 'model'].includes(key)) p.add('shape', `result.${key}`, 'is not a known field');
  const fields = (value: Record<string, unknown>, allowed: readonly string[], required: readonly string[], at: string): boolean => {
    let good = true;
    for (const key of Object.keys(value)) if (!allowed.includes(key)) (p.add('shape', `${at}.${key}`, 'is not a known field'), (good = false));
    for (const key of required) if (!isString(value[key])) (p.add('shape', `${at}.${key}`, 'is required, as a string'), (good = false));
    return good;
  };
  const pages: (CreateOp | UpdateOp)[] = [];
  if (!Array.isArray(result.pages)) p.add('shape', 'pages', 'must be an array of page ops');
  else {
    result.pages.forEach((op: unknown, i) => {
      const at = `pages[${i}]`;
      if (!isObject(op) || (op.op !== 'create' && op.op !== 'update')) return p.add('shape', at, 'must be a create or an update op');
      if (op.op === 'create' && fields(op, ['op', 'slug', 'title', 'kind', 'summary', 'body'], ['slug', 'title', 'kind', 'summary', 'body'], at)) pages.push(op as unknown as CreateOp);
      if (op.op === 'update' && fields(op, ['op', 'slug', 'base_hash', 'body'], ['slug', 'base_hash', 'body'], at)) pages.push(op as unknown as UpdateOp);
    });
  }
  const map: MapEntry[] = [];
  if (!Array.isArray(result.consumption)) p.add('shape', 'consumption', 'must be an array: every batch pair, to slugs or to no_pattern');
  else {
    result.consumption.forEach((entry: unknown, i) => {
      const at = `consumption[${i}]`;
      if (!isObject(entry)) return p.add('shape', at, 'must be an object');
      if (!fields(entry, ['pair', 'slugs', 'no_pattern'], ['pair'], at)) return;
      if (entry.slugs !== undefined && !(Array.isArray(entry.slugs) && entry.slugs.every(isString))) return p.add('shape', `${at}.slugs`, 'must be an array of slugs');
      if (entry.no_pattern !== undefined && !isString(entry.no_pattern)) return p.add('shape', `${at}.no_pattern`, 'must be a string');
      map.push(entry as unknown as MapEntry);
    });
  }
  const reported = (key: 'client' | 'model'): string | null => {
    const value = result[key];
    if (value === undefined || value === null) return null;
    if (!isString(value)) {
      p.add('shape', key, 'must be a string');
      return null;
    }
    return [...value.replace(/[\r\n]+/g, ' ')].slice(0, UNVERIFIED_LIMIT).join('').trim() || null;
  };
  const client = reported('client');
  const model = reported('model');
  return p.empty ? { pages, map, client, model } : null;
}

/** The secret scan (and, for committed text, full hygiene) over short agent text. */
function scanText(text: string, field: string, p: Problems, scanner: SecretScanner, hygiene: boolean): void {
  const scan = scanner.scan(text);
  if (scan.status !== 'scanned') return p.add('unscanned', field, 'could not be scanned for secrets');
  if (scan.hits.length > 0) {
    for (const hit of scan.hits) p.rules.add(hit.rule);
    return p.add('secret', field, `holds what looks like a secret (${sortedUnique(scan.hits.map((hit) => hit.rule)).join(', ')})`);
  }
  if (!hygiene) return;
  const report = checkHygiene(text);
  if (report.status !== 'checked' || report.findings.length > 0) p.add('hygiene', field, 'fails the hygiene checks (hidden characters, markup, dotfolder paths or remote content)');
}

/**
 * Checks a Wiki Maintainer result against the tracker as `draft` holds it, the
 * run's batch and what it was served (spec §16 fail-closed guards; "only served
 * items may be cited"). Pairs whose trace was quarantined or purged since the
 * run started drop out of the batch.
 */
export async function checkCompile(result: unknown, cx: CompileContext): Promise<CompileCheck> {
  const p = new Problems();
  const shape = shapeOf(result, p);
  if (!shape) return { ok: false, rejection: p.rejection() };
  const { draft, run, scanner } = cx;
  const served = new Set(cx.served.items.map((entry) => entry.item));
  const at = draft.now.toISOString();

  // Page ops.
  const planned = new Map<string, PlannedPage>();
  if (shape.pages.length > PAGE_WRITE_LIMIT) p.add('too_many_pages', 'pages', `holds ${shape.pages.length} page writes; a compile writes at most ${PAGE_WRITE_LIMIT}`);
  for (const [i, op] of shape.pages.entries()) {
    const field = `pages[${i}]`;
    const slug = op.slug.trim();
    if (!isSlug(slug)) {
      p.add('bad_slug', `${field}.slug`, 'is not a page slug (kebab-case: lowercase letters, digits and single hyphens, at most 64 characters)');
      continue;
    }
    if (planned.has(slug)) {
      p.add('duplicate_page', `${field}.slug`, 'names a page another op writes');
      continue;
    }
    const current = await draft.wiki.page(slug);
    if (op.op === 'create') {
      if (current) p.add('base_moved', `${field}.slug`, 'names a page that exists now: update it from the version you are served');
      if (op.title.trim() === '' || /[\r\n]/.test(op.title)) p.add('bad_title', `${field}.title`, 'must be one non-empty line');
      if (!(PAGE_KINDS as readonly string[]).includes(op.kind)) p.add('bad_kind', `${field}.kind`, `must be ${PAGE_KINDS.join(' or ')}`);
      for (const problem of pageWriteProblems({ title: op.title, summary: op.summary, body: op.body }, [], scanner, 'agent')) {
        p.add(problem.code, `${field}.${problem.field}`, problem.message);
        for (const rule of problem.rules ?? []) p.rules.add(rule);
      }
      const page: WikiPage = { slug, title: op.title, kind: op.kind, summary: op.summary, sources: [], generated: at, verified: null, updated_at: at, body: op.body, extra: {} };
      planned.set(slug, { slug, action: 'create', page, resolves: [] });
      continue;
    }
    if (!current) {
      p.add('unknown_slug', `${field}.slug`, 'names no page: create it instead');
      continue;
    }
    if (!cx.servablePage(slug) || !served.has(`page:${slug}`)) {
      p.add('unserved', `${field}.slug`, 'names a page this run was not served: read it with chore_read first');
      continue;
    }
    if (current.version !== op.base_hash.trim().toLowerCase()) p.add('base_moved', `${field}.base_hash`, 'is not the page’s version now: read the page again');
    const sides = await draft.wiki.conflicts(slug);
    if (sides.some((side) => !served.has(`side:${slug}/${side.id}`))) {
      p.add('base_moved', `${field}.base_hash`, 'the page has a set-aside side this run was not served: read the page again');
    }
    for (const problem of pageWriteProblems({ title: current.title, summary: current.summary, body: op.body }, [current.body, ...sides.map((side) => side.body ?? '')], scanner, 'agent')) {
      if (problem.field !== 'body') continue;
      p.add(problem.code, `${field}.body`, problem.message);
      for (const rule of problem.rules ?? []) p.rules.add(rule);
    }
    const page: WikiPage = {
      ...current,
      sources: sortedUnique([...current.sources, ...sides.flatMap((side) => side.sources)]),
      generated: at,
      updated_at: at,
      body: op.body,
    };
    planned.set(slug, { slug, action: 'update', page, resolves: sides.map((side) => side.id) });
  }

  // The consumption map: every batch pair still servable, once.
  const batch = new Map(run.batch.map((pair) => [pair.pair, pair]));
  const required = new Set<string>();
  for (const pair of run.batch) if (await cx.servableTrace(pair.trace)) required.add(pair.pair);
  const seen = new Set<string>();
  const consumption: ConsumedPair[] = [];
  const noPattern: Record<string, string> = {};
  const sourcesOf = new Map<string, Set<string>>();
  for (const [i, entry] of shape.map.entries()) {
    const field = `consumption[${i}]`;
    const id = entry.pair.trim();
    const pair = batch.get(id);
    if (!pair) {
      p.add('unknown_pair', `${field}.pair`, 'is not a pair of this run’s batch');
      continue;
    }
    if (seen.has(id)) {
      p.add('duplicate_pair', `${field}.pair`, 'is mapped twice');
      continue;
    }
    seen.add(id);
    if (!required.has(id)) continue; // quarantined or purged since the run started
    const slugs = sortedUnique((entry.slugs ?? []).map((slug) => slug.trim()));
    const reason = entry.no_pattern?.trim() ?? '';
    if ((slugs.length > 0) === (reason !== '')) {
      p.add('bad_consumption', field, 'must go to one or more slugs, or to no_pattern with a reason (not both)');
      continue;
    }
    if (!served.has(`trace:${pair.trace}`)) p.add('unserved', `${field}.pair`, 'names a trace this run was not served: read it with chore_read first');
    if (reason !== '') {
      scanText(reason, `${field}.no_pattern`, p, scanner, false);
      noPattern[id] = reason;
    }
    for (const slug of slugs) {
      if (!planned.has(slug)) {
        const existing = isSlug(slug) ? await draft.wiki.page(slug) : undefined;
        if (!existing) {
          p.add('unknown_slug', `${field}.slugs`, 'names a page that neither exists nor is written by this result');
          continue;
        }
        if (!cx.servablePage(slug) || !served.has(`page:${slug}`)) {
          p.add('unserved', `${field}.slugs`, 'names a page this run was not served');
          continue;
        }
      }
      let set = sourcesOf.get(slug);
      if (!set) sourcesOf.set(slug, (set = new Set()));
      set.add(pair.trace);
    }
    consumption.push({ trace: pair.trace, outcome: pair.outcome, slugs, no_pattern: reason !== '' });
  }
  const missing = [...required].filter((id) => !seen.has(id));
  if (missing.length > 0) p.add('missing_pair', 'consumption', `leaves out ${missing.length} batch pair${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);

  // Each page keeps its sources from the map; an existing page the map names gains them.
  for (const [slug, traces] of sourcesOf) {
    const write = planned.get(slug);
    if (write) {
      planned.set(slug, { ...write, page: { ...write.page, sources: sortedUnique([...write.page.sources, ...traces]) } });
      continue;
    }
    const current = (await draft.wiki.page(slug))!;
    const sources = sortedUnique([...current.sources, ...traces]);
    if (sources.length === current.sources.length) continue;
    planned.set(slug, { slug, action: 'sources', page: { ...current, sources, updated_at: at }, resolves: [] });
  }
  if (planned.size > PAGE_WRITE_LIMIT && !p.reasons.has('too_many_pages')) {
    p.add('too_many_pages', 'pages', `writes ${planned.size} pages with the ones the map adds sources to; a compile writes at most ${PAGE_WRITE_LIMIT}`);
  }

  for (const key of ['client', 'model'] as const) if (shape[key] !== null) scanText(shape[key], key, p, scanner, true);

  if (!p.empty) return { ok: false, rejection: p.rejection() };
  return { ok: true, plan: { pages: [...planned.values()], consumption, noPattern, unverified: { client: shape.client, model: shape.model } } };
}

/** Writes an accepted compile's pages into the round; returns each page's new version, by slug, and the sides resolved. */
export async function writeCompile(draft: TrackerDraft, plan: CompilePlan): Promise<{ versions: Record<string, string>; resolved: string[] }> {
  const versions: Record<string, string> = {};
  const resolved: string[] = [];
  for (const write of plan.pages) {
    // `extra`, the keys this release doesn't know, rides along on WikiPage (ADR 0011).
    versions[write.slug] = await draft.wiki.putPage(write.page);
    if (write.resolves.length > 0) {
      await draft.wiki.dropConflicts(write.slug, write.resolves);
      resolved.push(...write.resolves.map((id) => `${write.slug}/${id}`));
    }
  }
  return { versions, resolved: sortedUnique(resolved) };
}
