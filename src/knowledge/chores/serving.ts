// Serving a chore run (spec §16 Serving; ADR 0006): grimoire serves every input
// a chore reads, through paged `chore_read`, and records every item it serves
// on the run. A chore may cite only served items; quarantined and purged items
// are filtered out here, in code, index lines included.
//
// Items, each a JSON object with its `item` id and `kind`:
// - `outcomes`: the outcome summary, with each trace's flip context;
// - `trace:<handle>`: one trace's facts and flags (wiki-exposed, flip, strikes),
//   naming its parts: `issue:<handle>` (the issue as it stood when the attempt
//   opened), `debrief:<handle>` and `excerpt:<handle>/<session-key>`;
// - `wiki-index`, `page:<slug>`, and `side:<slug>/<id>` for each side a fold
//   set aside on a conflicted page;
// - `decisions`: one line per skill decision since the last compile (Wiki Maintainer);
// - `skill:<name>`: an evolved skill's served text;
// - `ledger`: the ledger digest (Skill Proposer): rejected and undone changes
//   in full (the text of a `suspicious` rejection withheld), one line for
//   every other ledger record and proposal, and each skill's scorecard;
// - `handwritten`: the hand-written skills and instruction files by name, and
//   `handwritten:<path>` for one's text, on request.
//
// Paging: without `item`, a run pages through its manifest in order; with one,
// it pages that item. Each page stays under PAGE_LIMIT bytes of JSON: whole
// items while they fit, and an item too big for one page is cut across pages
// at its `text` (`offset`, `continues`).
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseSessionRecord } from '../../capture/session-record';
import { decodeCursor, encodeCursor, jsonBytes, longestPrefix } from '../../core/budget';
import { GrimoireError } from '../../errors';
import type { SecretScanner } from '../../scanner';
import { renderWikiIndex, type TrackerView } from '../../tracker';
import { parseComment } from '../../tracker/comment';
import { parseIssue } from '../../tracker/record';
import { readSkills } from '../book';
import { parseLedgerRecord } from '../ledger';
import { diffLines } from '../line-diff';
import { undoneChanges } from '../restore';
import { proposalStates, targetedPatterns } from '../proposals';
import { deriveScorecards, type TraceFacts } from '../scorecards';
import type { ChorePair } from './due';
import { activeQuarantine, flaggedPages, type ActiveQuarantine } from './quarantine';
import { itemHash, type OpenRun } from './runs';

/** A page's JSON stays under this many bytes: under the ~24 KB result cut, with room for the surface's notices. */
export const PAGE_LIMIT = 22_000;
/** The most traces a Skill Proposer run's manifest names; every other servable trace is served on request. */
export const PROPOSER_TRACES = 24;

/** One served item. */
export interface ServedItem {
  readonly item: string;
  readonly kind: string;
  /** The item's long text, when it has one: the part a page may cut. */
  readonly text?: string;
  readonly [field: string]: unknown;
}

/** What serving a run needs to know. */
export interface ServingContext {
  readonly view: TrackerView;
  readonly run: OpenRun;
  /** The checkout the call came from: hand-written skills and instructions are read there. */
  readonly root: string;
  readonly scanner: SecretScanner;
  /** Every settled pair of the tracker now, by trace (its outcome and flip context). */
  readonly pairs: ReadonlyMap<string, ChorePair>;
  /** What scorecards need of every sealed trace (the ledger digest); none when absent. */
  readonly traceFacts?: () => Promise<readonly TraceFacts[]>;
}

/** The instruction files read as hand-written instructions. */
const INSTRUCTION_FILES = ['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', '.claude/CLAUDE.md'];
/** The client skill folders whose skills are hand-written (grimoire's own `grimoire-*` folders aside). */
const SKILL_FOLDERS = ['.agents/skills', '.claude/skills', '.codex/skills'];

/** The hand-written skills and instruction files in `root`, as `handwritten:<path>` ids. */
export async function handwritten(root: string): Promise<{ skills: string[]; instructions: string[] }> {
  const instructions: string[] = [];
  for (const file of INSTRUCTION_FILES) {
    if (await readFile(path.join(root, file)).then(() => true, () => false)) instructions.push(`handwritten:${file}`);
  }
  const skills: string[] = [];
  for (const folder of SKILL_FOLDERS) {
    const names = await readdir(path.join(root, folder)).catch(() => [] as string[]);
    for (const name of names.sort()) {
      if (name.startsWith('grimoire-') || name.startsWith('.')) continue;
      const file = `${folder}/${name}/SKILL.md`;
      if (await readFile(path.join(root, file)).then(() => true, () => false)) skills.push(`handwritten:${file}`);
    }
  }
  return { skills, instructions };
}

/** Everything a run may be served, filtered by quarantine and purge. */
export class Serving {
  private readonly cache = new Map<string, Promise<ServedItem | null>>();
  private quarantine: Promise<ActiveQuarantine> | null = null;
  private flags: Promise<Map<string, string[]>> | null = null;
  private listed: Promise<{ skills: string[]; instructions: string[] }> | null = null;
  private traceSet: Promise<Set<string>> | null = null;

  constructor(private readonly sc: ServingContext) {}

  private active(): Promise<ActiveQuarantine> {
    return (this.quarantine ??= activeQuarantine(this.sc.view));
  }

  private flagged(): Promise<Map<string, string[]>> {
    return (this.flags ??= flaggedPages(this.sc.view));
  }

  private handwrittenList(): Promise<{ skills: string[]; instructions: string[] }> {
    return (this.listed ??= handwritten(this.sc.root));
  }

  /** Whether a trace may be served: it exists (a purged one is gone), and no quarantine keeps it out. */
  private async servableTrace(handle: string): Promise<boolean> {
    return this.sc.view.attempt(handle)?.end != null && !(await this.active()).traces.has(handle);
  }

  /** The traces this run may be served: its batch, or for the Skill Proposer, those its compiles consumed and those pages cite. */
  private traces(): Promise<Set<string>> {
    return (this.traceSet ??= (async () => {
      const { run, view } = this.sc;
      const candidates = new Set<string>(run.batch.map((pair) => pair.trace));
      if (run.kind === 'skill-proposer') {
        const compiles = new Set(run.compiles);
        for (const record of await view.choreRuns.records()) {
          if (compiles.has(record.id)) for (const pair of record.consumption) candidates.add(pair.trace);
        }
        for (const slug of await this.servablePages()) {
          for (const source of (await view.wiki.page(slug))?.sources ?? []) candidates.add(source);
          for (const side of await view.wiki.conflicts(slug)) for (const source of side.sources) candidates.add(source);
        }
      }
      const servable = new Set<string>();
      for (const trace of candidates) if (await this.servableTrace(trace)) servable.add(trace);
      return servable;
    })());
  }

  private async servablePages(): Promise<string[]> {
    const quarantined = (await this.active()).pages;
    return (await this.sc.view.wiki.pages()).map((page) => page.slug).filter((slug) => !quarantined.has(slug));
  }

  /**
   * The traces the outcome summary and the manifest cover: the batch, or for
   * the Skill Proposer the traces its compiles consumed, newest compile first
   * and fails first, at most PROPOSER_TRACES (the rest are served on request).
   */
  private async summaryTraces(): Promise<string[]> {
    const { run, view } = this.sc;
    const servable = await this.traces();
    // A trace quarantined (or purged) since the run started is left out too.
    if (run.kind === 'wiki-maintainer') return run.batch.map((pair) => pair.trace).filter((trace) => servable.has(trace));
    const compiles = new Set(run.compiles);
    const consumed = (await view.choreRuns.records()).filter((record) => compiles.has(record.id)).reverse();
    const ordered = [...consumed.flatMap((r) => r.consumption.filter((p) => p.outcome === 'fail')), ...consumed.flatMap((r) => r.consumption.filter((p) => p.outcome !== 'fail'))];
    return [...new Set(ordered.map((pair) => pair.trace))].filter((trace) => servable.has(trace)).slice(0, PROPOSER_TRACES);
  }

  /** What an `item` read pages: the item, and for a conflicted page every side with it (spec §17). */
  async itemIds(id: string): Promise<string[]> {
    if (!id.startsWith('page:')) return [id];
    const slug = id.slice('page:'.length);
    return [id, ...(await this.sc.view.wiki.conflicts(slug)).map((side) => `side:${slug}/${side.id}`)];
  }

  /** The item ids a run pages through in order, without `item`. */
  async manifest(): Promise<string[]> {
    const { run } = this.sc;
    const ids = ['outcomes'];
    for (const trace of await this.summaryTraces()) {
      if (!(await this.traces()).has(trace)) continue;
      // The Skill Proposer gets each trace's facts up front, and its parts on request.
      ids.push(...(run.kind === 'wiki-maintainer' ? await this.traceParts(trace) : [`trace:${trace}`]));
    }
    ids.push('wiki-index');
    for (const slug of run.conflicted) {
      if (!(await this.servablePages()).includes(slug)) continue;
      ids.push(`page:${slug}`, ...(await this.sc.view.wiki.conflicts(slug)).map((side) => `side:${slug}/${side.id}`));
    }
    if (run.kind === 'wiki-maintainer') ids.push('decisions');
    else ids.push(...(await readSkills(this.sc.view, this.sc.scanner)).served.map((skill) => `skill:${skill.name}`), 'ledger');
    ids.push('handwritten');
    return ids;
  }

  /** A trace's item ids: its facts, then its parts. */
  private async traceParts(trace: string): Promise<string[]> {
    const record = this.sc.view.attempt(trace)!;
    const parts = [`trace:${trace}`, `issue:${trace}`];
    if (record.end?.debrief) parts.push(`debrief:${trace}`);
    for (const key of [...record.sessions.keys()].sort()) parts.push(`excerpt:${trace}/${key}`);
    return parts;
  }

  /** The item `id` as served now, or null when this run may not be served it. */
  item(id: string): Promise<ServedItem | null> {
    let cached = this.cache.get(id);
    if (!cached) this.cache.set(id, (cached = this.render(id)));
    return cached;
  }

  private async render(id: string): Promise<ServedItem | null> {
    const { view } = this.sc;
    const colon = id.indexOf(':');
    const prefix = colon < 0 ? id : id.slice(0, colon);
    const rest = colon < 0 ? '' : id.slice(colon + 1);
    switch (prefix) {
      case 'outcomes':
        return colon < 0 ? this.outcomes() : null;
      case 'wiki-index': {
        if (colon >= 0) return null;
        const quarantined = (await this.active()).pages;
        const pages = (await view.wiki.pages()).filter((page) => !quarantined.has(page.slug));
        const conflicted = new Set<string>();
        for (const page of pages) if ((await view.wiki.conflicts(page.slug)).length > 0) conflicted.add(page.slug);
        const text = renderWikiIndex(pages, (slug) => conflicted.has(slug)).toString('utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
        return { item: id, kind: 'wiki-index', pages: pages.length, text };
      }
      case 'page':
        return this.page(id, rest);
      case 'side':
        return this.side(id, rest);
      case 'decisions':
        return colon < 0 && this.sc.run.kind === 'wiki-maintainer' ? this.decisions() : null;
      case 'ledger':
        return colon < 0 && this.sc.run.kind === 'skill-proposer' ? this.ledgerDigest() : null;
      case 'skill': {
        const skill = (await readSkills(view, this.sc.scanner)).served.find((s) => s.name === rest);
        return skill ? { item: id, kind: 'evolved-skill', name: skill.name, version: skill.version, description: skill.description, text: skill.text } : null;
      }
      case 'handwritten': {
        const listed = await this.handwrittenList();
        if (colon < 0) {
          // One id per line: the list is cut across pages like any text.
          const text = [...listed.instructions, ...listed.skills].join('\n');
          return { item: id, kind: 'handwritten', instructions: listed.instructions.length, skills: listed.skills.length, text };
        }
        if (![...listed.skills, ...listed.instructions].includes(id)) return null;
        const text = await readFile(path.join(this.sc.root, rest), 'utf8').catch(() => null);
        return text === null ? null : { item: id, kind: 'handwritten-text', path: rest, text };
      }
      case 'trace':
      case 'issue':
      case 'debrief':
      case 'excerpt':
        return this.tracePart(id, prefix, rest);
      default:
        return null;
    }
  }

  private async outcomes(): Promise<ServedItem> {
    const traces = await this.summaryTraces();
    const rows = traces.map((trace) => {
      const pair = this.sc.pairs.get(trace);
      const outcome = this.sc.view.attempt(trace)?.outcome;
      return {
        trace,
        issue: this.sc.view.attempt(trace)?.issue ?? null,
        outcome: outcome?.verdict ?? null,
        reason: outcome?.reason ?? null,
        set_by: outcome?.set_by ?? null,
        flip: pair?.flip ?? null,
      };
    });
    const count = (verdict: string) => rows.filter((row) => row.outcome === verdict).length;
    // One line per trace (its flip context in its trace item too): the list is cut across pages like any text.
    const text = rows
      .map((row) => `${row.trace} on ${row.issue}: ${row.outcome} (${row.reason}; set by ${row.set_by})${row.flip ? `, flipped from ${row.flip.from}` : ''}`)
      .join('\n');
    return {
      item: 'outcomes',
      kind: 'outcomes',
      traces: rows.length,
      pass: count('pass'),
      fail: count('fail'),
      flipped: rows.filter((row) => row.flip !== null).length,
      text,
    };
  }

  private async page(id: string, slug: string): Promise<ServedItem | null> {
    const { view } = this.sc;
    if (!(await this.servablePages()).includes(slug)) return null;
    const page = (await view.wiki.page(slug))!;
    const sides = await view.wiki.conflicts(slug);
    return {
      item: id,
      kind: 'page',
      slug,
      title: page.title,
      page_kind: page.kind,
      summary: page.summary,
      version: page.version,
      sources: await this.servableSources(page.sources),
      conflicted: sides.length > 0,
      sides: sides.map((side) => `side:${slug}/${side.id}`),
      flagged_by: (await this.flagged()).get(slug) ?? [],
      text: page.body,
    };
  }

  private async side(id: string, rest: string): Promise<ServedItem | null> {
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    const slug = rest.slice(0, slash);
    if (!(await this.servablePages()).includes(slug)) return null;
    const side = (await this.sc.view.wiki.conflicts(slug)).find((s) => s.id === rest.slice(slash + 1));
    if (!side) return null;
    return {
      item: id,
      kind: 'page-side',
      slug,
      side: side.id,
      fields: [...side.fields],
      ...(side.title !== undefined ? { title: side.title } : {}),
      ...(side.kind !== undefined ? { page_kind: side.kind } : {}),
      ...(side.summary !== undefined ? { summary: side.summary } : {}),
      sources: await this.servableSources(side.sources),
      at: side.at,
      text: side.body ?? '',
    };
  }

  /** A page's sources as served: quarantined and purged traces left out. */
  private async servableSources(sources: readonly string[]): Promise<string[]> {
    const kept: string[] = [];
    for (const source of sources) if (await this.servableTrace(source)) kept.push(source);
    return kept;
  }

  private async decisions(): Promise<ServedItem> {
    const { view } = this.sc;
    const compiles = (await view.choreRuns.records()).filter((run) => run.kind === 'wiki-maintainer' && run.result === 'compiled');
    const since = compiles.at(-1)?.at ?? null;
    const entries = [...(await view.ledgerFiles())]
      .map(([id, bytes]) => parseLedgerRecord(id, bytes))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null && (since === null || entry.at > since))
      .sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.id < y.id ? -1 : 1));
    const lines = entries.map((entry) => `- ${entry.at}: ${entry.kind} ${entry.skill}${entry.reason ? ` (${entry.reason})` : ''}`);
    return { item: 'decisions', kind: 'decisions', since, count: lines.length, text: lines.join('\n') };
  }

  /**
   * The ledger digest (spec §16 Serving): for every skill the ledger names,
   * its scorecard and attention flags; each rejected proposal's change in
   * full, except a `suspicious` rejection's, whose text is withheld; each
   * change a restore undid in full; and one line for every other ledger
   * record and proposal.
   */
  private async ledgerDigest(): Promise<ServedItem> {
    const { view, scanner } = this.sc;
    const book = await readSkills(view, scanner);
    const states = proposalStates(await view.proposals.records(), book.skills);
    const facts = (await this.sc.traceFacts?.()) ?? [];
    const textOf = async (version: string | null) => (version === null ? '' : ((await book.text(version)) ?? ''));
    const change = async (before: string, after: string) => {
      const diff = diffLines(before, after);
      return [...diff.removed.map((line) => `- ${line}`), ...diff.added.map((line) => `+ ${line}`)].join('\n');
    };
    const sections: string[] = [];
    let rejected = 0;
    let undone = 0;
    for (const state of book.skills.values()) {
      const lines = [`## ${state.name}: ${state.status}${state.version ? `, current ${state.version.slice(0, 12)}` : ''}`];
      const patterns = await targetedPatterns(view, state.records);
      const card = deriveScorecards(state.name, state.records, facts, { patternOf: (v) => patterns.get(v) ?? null }).find((c) => c.version === state.version);
      if (card) {
        lines.push(
          `scorecard of ${card.version.slice(0, 12)}: read ${card.read}, offered ${card.offered}, pass ${card.pass}, fail ${card.fail}, none ${card.none}, n ${card.n}${card.small_sample ? ' (small sample)' : ''}${card.attention.length > 0 ? `; attention: ${card.attention.join(', ')}` : ''}`,
        );
      }
      for (const proposal of states.filter((s) => s.record.skill === state.name && s.status === 'rejected')) {
        rejected++;
        const reason = proposal.decision?.reason ?? '';
        if (reason === 'suspicious') {
          lines.push(`### rejected proposal ${proposal.record.id} (suspicious): text withheld`);
          continue;
        }
        lines.push(`### rejected proposal ${proposal.record.id} (${reason}): ${proposal.record.action} of ${proposal.record.skill}`);
        lines.push(await change(await textOf(proposal.record.base), proposal.record.text));
      }
      for (const { restore, undone: made } of undoneChanges(state.records)) {
        if (made.to === null) continue;
        undone++;
        lines.push(`### undone change ${(made.from ?? 'none').slice(0, 12)} -> ${made.to.slice(0, 12)} (restored ${restore.at})`);
        lines.push(await change(await textOf(made.from), await textOf(made.to)));
      }
      for (const record of state.records) {
        if (record.kind === 'reject' && record.proposal !== undefined) continue;
        lines.push(`- ${record.at}: ${record.kind} ${record.skill}${record.reason ? ` (${record.reason})` : ''}`);
      }
      sections.push(lines.join('\n'));
    }
    const others = states.filter((s) => s.status !== 'rejected').map((s) => `- ${s.record.at}: proposal ${s.record.id}, ${s.record.action} of ${s.record.skill}: ${s.status}`);
    if (others.length > 0) sections.push(['## proposals', ...others].join('\n'));
    return { item: 'ledger', kind: 'ledger-digest', skills: book.skills.size, rejected, undone, text: sections.join('\n\n') };
  }

  private async tracePart(id: string, prefix: string, rest: string): Promise<ServedItem | null> {
    const { view } = this.sc;
    const slash = rest.indexOf('/');
    const trace = prefix === 'excerpt' ? rest.slice(0, slash < 0 ? rest.length : slash) : rest;
    if (!(await this.traces()).has(trace)) return null;
    const record = view.attempt(trace)!;
    switch (prefix) {
      case 'trace': {
        const pair = this.sc.pairs.get(trace);
        const issue = await this.issueAtStart(trace);
        return {
          item: id,
          kind: 'trace',
          trace,
          issue: record.issue,
          title: issue?.title ?? null,
          outcome: record.outcome?.verdict ?? null,
          reason: record.outcome?.reason ?? null,
          ended: record.end?.ended ?? null,
          ended_at: record.end?.at ?? null,
          worker_kind: record.end?.worker_kind ?? null,
          wiki_exposed: record.start.wiki_exposed || (record.end?.wiki_exposed ?? false),
          flip: pair?.flip ?? null,
          strikes: pair?.strikes ?? 0,
          parts: (await this.traceParts(trace)).slice(1),
        };
      }
      case 'issue': {
        const issue = await this.issueAtStart(trace);
        if (!issue) return null;
        return { item: id, kind: 'issue', trace, issue: record.issue, title: issue.title, status: issue.status, labels: [...issue.labels], text: issue.body };
      }
      case 'debrief': {
        const debrief = record.end?.debrief;
        if (!debrief) return null;
        const bytes = await view.traceFile(trace, `activity/${debrief}.md`);
        if (!bytes) return null;
        return { item: id, kind: 'debrief', trace, text: parseComment(debrief, bytes).body };
      }
      case 'excerpt': {
        const key = rest.slice(slash + 1);
        if (slash < 0 || !record.sessions.has(key)) return null;
        const bytes = await view.sessionRecord(trace, key);
        if (!bytes) return null;
        const session = parseSessionRecord(bytes);
        return {
          item: id,
          kind: 'excerpt',
          trace,
          client: session.client,
          context: session.context,
          excerpt: session.excerpt,
          facts: session.facts,
          steps: session.steps,
          text: session.text ?? '',
        };
      }
      default:
        return null;
    }
  }

  private async issueAtStart(trace: string) {
    const bytes = await this.sc.view.traceFile(trace, 'issue-at-start.md');
    if (!bytes) return null;
    try {
      return parseIssue(bytes);
    } catch {
      return null;
    }
  }
}

/** Where a page starts: an index into the ids it pages, and a character offset into that item's text. */
interface PageState {
  /** The one item paged, or null for the manifest. */
  readonly item: string | null;
  readonly i: number;
  readonly offset: number;
}

const CURSOR = 'chore_read';
/** Stands in for the cursor while a page is measured: longer than any real one. */
const CURSOR_ROOM = 'x'.repeat(320);

export interface Page {
  readonly items: ServedItem[];
  /** Each item the page served (wholly or in part), with the hash of the whole item. */
  readonly served: { item: string; hash: string }[];
  /** Where the next page starts, or null when this was the last. */
  readonly next: string | null;
}

/** Reads a `chore_read` cursor for the item (or the manifest) it must page. */
export function pageStart(cursor: string | undefined, item: string | null): PageState {
  if (cursor === undefined) return { item, i: 0, offset: 0 };
  const state = decodeCursor(cursor, CURSOR) as Partial<PageState> | null;
  if (!state || (state.item ?? null) !== item || typeof state.i !== 'number' || typeof state.offset !== 'number') {
    throw new GrimoireError('INVALID', 'cursor: is not a cursor from this chore_read; pass the cursor its previous page returned', {
      fields: { cursor: item === null ? 'belongs to an item read; pass the same item' : 'belongs to another read' },
    });
  }
  return { item, i: state.i, offset: state.offset };
}

/**
 * One page of `ids` from `start`, its JSON (as `envelope` wraps it) under
 * PAGE_LIMIT bytes. Items that are gone since the manifest was made are
 * skipped.
 */
export async function pageOf(
  serving: Serving,
  ids: readonly string[],
  start: PageState,
  envelope: (items: ServedItem[], cursor: string | null) => unknown,
): Promise<Page> {
  const items: ServedItem[] = [];
  const served: { item: string; hash: string }[] = [];
  const fits = (candidate: ServedItem[]) => jsonBytes(envelope(candidate, CURSOR_ROOM)) <= PAGE_LIMIT;
  let { i, offset } = start;
  while (i < ids.length) {
    const full = await serving.item(ids[i]!);
    if (!full) {
      i++;
      offset = 0;
      continue;
    }
    const text = full.text ?? '';
    const part: ServedItem = offset > 0 ? { ...full, offset, text: text.slice(offset) } : full;
    if (fits([...items, part])) {
      items.push(part);
      served.push({ item: full.item, hash: itemHash(full) });
      i++;
      offset = 0;
      continue;
    }
    // A whole item that fits on a page of its own starts the next page.
    if (items.length > 0 && fits([part])) break;
    const remaining = part.text ?? '';
    const cut = longestPrefix(remaining, (prefix) => fits([...items, { ...part, offset, text: prefix, continues: true }]));
    if (cut === '' && items.length > 0) break;
    items.push({ ...part, offset, text: cut, continues: true });
    served.push({ item: full.item, hash: itemHash(full) });
    offset += cut.length;
    if (cut === '') {
      // Not even its fields fit: served as far as they go, and the page moves on.
      i++;
      offset = 0;
    }
    break;
  }
  const next = i < ids.length ? encodeCursor(CURSOR, { item: start.item, i, offset }) : null;
  return { items, served, next };
}

/** How many pages `ids` takes from the start. */
export async function pageCount(serving: Serving, ids: readonly string[], envelope: (items: ServedItem[], cursor: string | null) => unknown): Promise<number> {
  let count = 0;
  let state: PageState = { item: null, i: 0, offset: 0 };
  for (;;) {
    const page = await pageOf(serving, ids, state, envelope);
    count++;
    if (page.next === null) return count;
    state = pageStart(page.next, null);
  }
}
