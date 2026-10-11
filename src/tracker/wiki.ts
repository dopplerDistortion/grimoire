// The wiki's records on the tracker (spec §3 Layout, §17): pattern pages at
// `knowledge/wiki/pages/<slug>.md`, the sides a fold set aside at
// `knowledge/wiki/conflicts/<slug>/<hash>.md`, the record of every human wiki
// edit at `knowledge/wiki/edits/<hash>.md`, and the derived `index.md` and
// `log.md`, which every commit that changes pages and every fold regenerate,
// and which are never merged as text. Only the tracker store knows these paths.
import { createHash } from 'node:crypto';
import { TREE_MODE, type TreeEntry } from '../git/objects';
import { VERSION } from '../version';
import { formatLine, lineValue, parseLines } from './lines';
import { mergeText } from './merge-text';
import type { FileEdit, ObjectSource } from './objects';
import { sortedUnique } from './record';

export const WIKI_DIR = 'knowledge/wiki';
const PAGES = 'pages';
const CONFLICTS = 'conflicts';
const EDITS = 'edits';
const INDEX = 'index.md';
const LOG = 'log.md';

/** `knowledge/wiki/pages/<slug>.md` */
export function wikiPageFile(slug: string): string {
  return `${WIKI_DIR}/${PAGES}/${slug}.md`;
}

/** What a page is about: a recurring failure mode, or a strategy that worked. */
export type PageKind = 'failure' | 'strategy';

export interface WikiPage {
  /** Its file name, without `.md`. */
  readonly slug: string;
  readonly title: string;
  /** `failure` or `strategy` (whatever the record holds, when another release wrote something else). */
  readonly kind: string;
  /** At most 200 characters. */
  readonly summary: string;
  /** The trace ids (attempt handles) the page was compiled from; sorted, unique, never shrinking. */
  readonly sources: readonly string[];
  /** When a knowledge chore last wrote the page text, or null when none has. */
  readonly generated: string | null;
  /** When a human last wrote the page with a wiki edit, or null when none has. */
  readonly verified: string | null;
  /** When the page was last written, by anyone: the scalar rule's clock. */
  readonly updated_at: string;
  /** Everything after the closing `---` line, byte for byte. */
  readonly body: string;
  /** Frontmatter keys this release doesn't know, as their raw value text (ADR 0011). */
  readonly extra: Readonly<Record<string, string>>;
}

const PAGE_KEYS = ['slug', 'title', 'kind', 'summary', 'sources', 'generated', 'verified', 'updated_at'] as const;
const PAGE_KNOWN = new Set<string>(PAGE_KEYS);

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** Frontmatter lines and the body of a `---` record; the body is empty for a frontmatter-only record. */
function splitRecord(bytes: Buffer): { values: Map<string, unknown>; raw: Map<string, string>; body: string } {
  const text = bytes.toString('utf8');
  const values = new Map<string, unknown>();
  const raw = new Map<string, string>();
  if (!text.startsWith('---\n')) return { values, raw, body: text };
  const close = text.indexOf('\n---\n', 3);
  const end = close >= 0 ? close : text.endsWith('\n---') ? text.length - 4 : -1;
  if (end < 0) return { values, raw, body: text };
  for (const line of parseLines(text.slice(4, end))) {
    values.set(line.key, lineValue(line.raw));
    raw.set(line.key, line.raw);
  }
  return { values, raw, body: close >= 0 ? text.slice(close + 5) : '' };
}

const str = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);
const strOrNull = (value: unknown) => (typeof value === 'string' ? value : null);
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);

export function parsePage(slug: string, bytes: Buffer): WikiPage {
  const { values, raw, body } = splitRecord(bytes);
  const extra: Record<string, string> = {};
  for (const [key, text] of raw) if (!PAGE_KNOWN.has(key)) extra[key] = text;
  return {
    slug,
    title: str(values.get('title')),
    kind: str(values.get('kind')),
    summary: str(values.get('summary')),
    sources: sortedUnique(strings(values.get('sources'))),
    generated: strOrNull(values.get('generated')),
    verified: strOrNull(values.get('verified')),
    updated_at: str(values.get('updated_at')),
    body,
    extra,
  };
}

/** The canonical serializer: fixed key order, JSON values, unknown keys sorted last, verbatim body. */
export function serializePage(page: WikiPage): Buffer {
  const known: Record<(typeof PAGE_KEYS)[number], unknown> = {
    slug: page.slug,
    title: page.title,
    kind: page.kind,
    summary: page.summary,
    sources: sortedUnique(page.sources),
    generated: page.generated,
    verified: page.verified,
    updated_at: page.updated_at,
  };
  const lines = PAGE_KEYS.map((key) => formatLine(key, known[key]));
  for (const key of Object.keys(page.extra).sort(byCodePoint)) if (!PAGE_KNOWN.has(key)) lines.push(`${key}: ${page.extra[key]}`);
  return Buffer.from(`---\n${lines.join('\n')}\n---\n${page.body}`, 'utf8');
}

/** A page's version: the sha256 of its record's bytes. A wiki edit names it as its base. */
export function pageVersion(bytes: Uint8Array): string {
  return sha256(bytes);
}

/**
 * A side a fold set aside on a page (spec §17, Folds): the other write's
 * fields that lost, its body when bodies overlapped, and that body's own
 * `sources`. Write-once, named by the sha256 of its bytes. The page reads as
 * conflicted while any of its records is left; a reconciling write removes
 * the ones it resolved.
 */
export interface WikiConflict {
  /** The record's name: the sha256 of its bytes. */
  readonly id: string;
  readonly slug: string;
  /** The fields set aside (`body`, `title`, `kind`, `summary`), sorted. */
  readonly fields: readonly string[];
  /** The set-aside side's values of those fields. */
  readonly title?: string;
  readonly kind?: string;
  readonly summary?: string;
  /** The set-aside body, when `body` is among the fields. */
  readonly body?: string;
  /** The set-aside body's own sources (empty unless `body` is among the fields). */
  readonly sources: readonly string[];
  /** When the set-aside side was written (its `updated_at`). */
  readonly at: string;
}

const SCALARS = ['title', 'kind', 'summary'] as const;

function serializeConflict(conflict: Omit<WikiConflict, 'id'>): Buffer {
  const lines = [formatLine('slug', conflict.slug), formatLine('fields', [...conflict.fields].sort(byCodePoint))];
  for (const key of SCALARS) if (conflict[key] !== undefined) lines.push(formatLine(key, conflict[key]));
  lines.push(formatLine('sources', sortedUnique(conflict.sources)), formatLine('at', conflict.at));
  return Buffer.from(`---\n${lines.join('\n')}\n---\n${conflict.body ?? ''}`, 'utf8');
}

function parseConflict(id: string, slug: string, bytes: Buffer): WikiConflict {
  const { values, body } = splitRecord(bytes);
  const fields = sortedUnique(strings(values.get('fields')));
  const conflict: Record<string, unknown> = { id, slug, fields, sources: sortedUnique(strings(values.get('sources'))), at: str(values.get('at')) };
  for (const key of SCALARS) if (typeof values.get(key) === 'string') conflict[key] = values.get(key);
  if (fields.includes('body')) conflict.body = body;
  return conflict as unknown as WikiConflict;
}

/** A human wiki edit, as its record holds it: what the log is derived from, with the chore-run records. */
export interface WikiEdit {
  /** The record's name: the sha256 of its bytes. */
  readonly id: string;
  readonly slug: string;
  readonly action: 'create' | 'update';
  /** The page version it replaced (null for a create) and the one it wrote. */
  readonly from: string | null;
  readonly to: string;
  /** The conflict records it reconciled, sorted. */
  readonly resolved: readonly string[];
  /** The recorded actor: the person plus how they made it. */
  readonly actor: Readonly<Record<string, unknown>>;
  /** The surface it was made on: `cli` or `dashboard`. */
  readonly surface: string;
  readonly at: string;
}

export type NewWikiEdit = Omit<WikiEdit, 'id' | 'at'>;

function serializeEdit(edit: Omit<WikiEdit, 'id'>): Buffer {
  const lines = [
    formatLine('record', 'wiki-edit'),
    formatLine('slug', edit.slug),
    formatLine('action', edit.action),
    formatLine('from', edit.from),
    formatLine('to', edit.to),
    formatLine('resolved', sortedUnique(edit.resolved)),
    formatLine('actor', edit.actor),
    formatLine('surface', edit.surface),
    formatLine('at', edit.at),
  ];
  return Buffer.from(`---\n${lines.join('\n')}\n---\n`, 'utf8');
}

function parseEdit(id: string, bytes: Buffer): WikiEdit {
  const { values } = splitRecord(bytes);
  const actor = values.get('actor');
  return {
    id,
    slug: str(values.get('slug')),
    action: values.get('action') === 'create' ? 'create' : 'update',
    from: strOrNull(values.get('from')),
    to: str(values.get('to')),
    resolved: sortedUnique(strings(values.get('resolved'))),
    actor: actor !== null && typeof actor === 'object' && !Array.isArray(actor) ? (actor as Record<string, unknown>) : {},
    surface: str(values.get('surface')),
    at: str(values.get('at')),
  };
}

/** One page as a read shows it: the record, plus its version. */
export interface WikiPageEntry extends WikiPage {
  readonly version: string;
}

/** The wiki as one tracker tree holds it. */
interface WikiContents {
  readonly pages: ReadonlyMap<string, WikiPageEntry>;
  readonly conflicts: ReadonlyMap<string, readonly WikiConflict[]>;
  readonly edits: readonly WikiEdit[];
  readonly index: Buffer | null;
  readonly log: Buffer | null;
}

const EMPTY: WikiContents = { pages: new Map(), conflicts: new Map(), edits: [], index: null, log: null };

const isTree = (entry: TreeEntry | undefined): entry is TreeEntry => entry?.mode === TREE_MODE;
const mdFiles = (entries: readonly TreeEntry[]) => entries.filter((e) => e.mode !== TREE_MODE && e.name.endsWith('.md'));

const byAt = <T extends { at: string; id: string }>(x: T, y: T) => byCodePoint(x.at, y.at) || byCodePoint(x.id, y.id);

/**
 * Human wiki edits, oldest first. Edits made in one millisecond keep their
 * chain order (an edit after the one whose version it replaced), then go by id.
 */
function orderEdits(edits: readonly WikiEdit[]): WikiEdit[] {
  const byVersion = new Map(edits.map((edit) => [edit.to, edit]));
  const depths = new Map<WikiEdit, number>();
  const depth = (edit: WikiEdit, seen = new Set<WikiEdit>()): number => {
    const known = depths.get(edit);
    if (known !== undefined) return known;
    const previous = edit.from === null ? undefined : byVersion.get(edit.from);
    const value = previous && !seen.has(previous) ? depth(previous, seen.add(edit)) + 1 : 0;
    depths.set(edit, value);
    return value;
  };
  return [...edits].sort((x, y) => byCodePoint(x.at, y.at) || depth(x) - depth(y) || byCodePoint(x.id, y.id));
}

/** Reads the wiki directory tree `tree` (null: no wiki yet). */
async function readWiki(source: ObjectSource, tree: string | null): Promise<WikiContents> {
  if (!tree) return EMPTY;
  const entries = new Map((await source.tree(tree)).map((e) => [e.name, e]));
  const list = async (name: string) => {
    const entry = entries.get(name);
    return isTree(entry) ? source.tree(entry.oid) : [];
  };
  const blob = async (name: string) => {
    const entry = entries.get(name);
    return entry && entry.mode !== TREE_MODE ? source.blob(entry.oid) : null;
  };
  const [pageFiles, conflictDirs, editFiles, index, log] = await Promise.all([list(PAGES), list(CONFLICTS), list(EDITS), blob(INDEX), blob(LOG)]);
  const pages = await Promise.all(
    mdFiles(pageFiles).map(async (e) => {
      const slug = e.name.slice(0, -3);
      const bytes = await source.blob(e.oid);
      return [slug, { ...parsePage(slug, bytes), version: pageVersion(bytes) }] as const;
    }),
  );
  const conflicts = await Promise.all(
    conflictDirs.filter(isTree).map(async (dir) => {
      const records = await Promise.all(
        mdFiles(await source.tree(dir.oid)).map(async (e) => parseConflict(e.name.slice(0, -3), dir.name, await source.blob(e.oid))),
      );
      return [dir.name, records.sort(byAt)] as const;
    }),
  );
  const edits = await Promise.all(mdFiles(editFiles).map(async (e) => parseEdit(e.name.slice(0, -3), await source.blob(e.oid))));
  return {
    pages: new Map([...pages].sort(([x], [y]) => byCodePoint(x, y))),
    conflicts: new Map(conflicts.filter(([, records]) => records.length > 0)),
    edits: orderEdits(edits),
    index,
    log,
  };
}

/** What every read sees of the wiki. */
export interface WikiView {
  /** Every page, by slug. */
  pages(): Promise<readonly WikiPageEntry[]>;
  page(slug: string): Promise<WikiPageEntry | undefined>;
  /** The page's set-aside sides, oldest first: it is conflicted while there are any. */
  conflicts(slug: string): Promise<readonly WikiConflict[]>;
  /** Every human wiki edit, oldest first. */
  edits(): Promise<readonly WikiEdit[]>;
}

/** The wiki of one tracker tree, read once on first use. */
export class WikiReader implements WikiView {
  private loaded: Promise<WikiContents> | null = null;

  constructor(
    private readonly source: ObjectSource,
    private readonly rootTree: string,
  ) {}

  contents(): Promise<WikiContents> {
    return (this.loaded ??= this.source.entryAt(this.rootTree, WIKI_DIR).then((entry) => readWiki(this.source, isTree(entry ?? undefined) ? entry!.oid : null)));
  }

  async pages(): Promise<readonly WikiPageEntry[]> {
    return [...(await this.contents()).pages.values()];
  }

  async page(slug: string): Promise<WikiPageEntry | undefined> {
    return (await this.contents()).pages.get(slug);
  }

  async conflicts(slug: string): Promise<readonly WikiConflict[]> {
    return (await this.contents()).conflicts.get(slug) ?? [];
  }

  async edits(): Promise<readonly WikiEdit[]> {
    return (await this.contents()).edits;
  }
}

/** The wiki as a write round changes it. */
export interface WikiDraft extends WikiView {
  /** Writes a page (canonically serialized; its unknown keys kept). Returns its new version. */
  putPage(page: WikiPage): Promise<string>;
  /** Removes set-aside sides of a page: a write reconciled them. */
  dropConflicts(slug: string, ids: readonly string[]): Promise<void>;
  /** Records a human wiki edit at the round's instant. Returns the record. */
  addEdit(edit: NewWikiEdit): Promise<WikiEdit>;
}

/** The changes one write round makes to the wiki, and the derived files they regenerate. */
export class WikiDraftState implements WikiDraft {
  private readonly written = new Map<string, Buffer>();
  private readonly dropped = new Map<string, Set<string>>();
  private readonly added: { bytes: Buffer; edit: WikiEdit }[] = [];
  private derived: { index: Buffer | null; log: Buffer | null } | null = null;

  constructor(
    private readonly base: WikiReader,
    private readonly now: Date,
  ) {}

  private async contents(): Promise<WikiContents> {
    const base = await this.base.contents();
    const pages = new Map(base.pages);
    for (const [slug, bytes] of this.written) pages.set(slug, { ...parsePage(slug, bytes), version: pageVersion(bytes) });
    const conflicts = new Map<string, readonly WikiConflict[]>();
    for (const [slug, records] of base.conflicts) {
      const gone = this.dropped.get(slug);
      const left = gone ? records.filter((r) => !gone.has(r.id)) : records;
      if (left.length > 0) conflicts.set(slug, left);
    }
    const edits = orderEdits([...base.edits, ...this.added.map((a) => a.edit)]);
    return { pages: new Map([...pages].sort(([x], [y]) => byCodePoint(x, y))), conflicts, edits, index: base.index, log: base.log };
  }

  async pages(): Promise<readonly WikiPageEntry[]> {
    return [...(await this.contents()).pages.values()];
  }

  async page(slug: string): Promise<WikiPageEntry | undefined> {
    return (await this.contents()).pages.get(slug);
  }

  async conflicts(slug: string): Promise<readonly WikiConflict[]> {
    return (await this.contents()).conflicts.get(slug) ?? [];
  }

  async edits(): Promise<readonly WikiEdit[]> {
    return (await this.contents()).edits;
  }

  async putPage(page: WikiPage): Promise<string> {
    const bytes = serializePage(page);
    this.written.set(page.slug, bytes);
    await this.regenerate();
    return pageVersion(bytes);
  }

  async dropConflicts(slug: string, ids: readonly string[]): Promise<void> {
    let gone = this.dropped.get(slug);
    if (!gone) this.dropped.set(slug, (gone = new Set()));
    for (const id of ids) gone.add(id);
    await this.regenerate();
  }

  async addEdit(edit: NewWikiEdit): Promise<WikiEdit> {
    const at = this.now.toISOString();
    const bytes = serializeEdit({ ...edit, at });
    const record: WikiEdit = { ...edit, resolved: sortedUnique(edit.resolved), id: sha256(bytes), at };
    this.added.push({ bytes, edit: record });
    await this.regenerate();
    return record;
  }

  private async regenerate(): Promise<void> {
    this.derived = deriveWikiFiles(await this.contents());
  }

  /** The file edits this round makes to the wiki. */
  fileEdits(): Map<string, FileEdit> {
    const edits = new Map<string, FileEdit>();
    for (const [slug, bytes] of this.written) edits.set(wikiPageFile(slug), bytes);
    for (const [slug, ids] of this.dropped) for (const id of ids) edits.set(`${WIKI_DIR}/${CONFLICTS}/${slug}/${id}.md`, null);
    for (const { bytes, edit } of this.added) edits.set(`${WIKI_DIR}/${EDITS}/${edit.id}.md`, bytes);
    if (this.derived?.index) edits.set(`${WIKI_DIR}/${INDEX}`, this.derived.index);
    if (this.derived?.log) edits.set(`${WIKI_DIR}/${LOG}`, this.derived.log);
    return edits;
  }
}

// ---------------------------------------------------------------------------
// Derived files

/** Orders semver strings by their numeric parts (anything unparsable sorts first). */
function compareVersions(x: string, y: string): number {
  const parts = (v: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(Number);
  const [px, py] = [parts(x), parts(y)];
  for (let i = 0; i < 3; i++) {
    const d = (px[i] ?? -1) - (py[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/** The `generated-by` of a derived file, or null. */
function generatedBy(bytes: Buffer | null): string | null {
  return bytes ? strOrNull(splitRecord(bytes).values.get('generated-by')) : null;
}

/** Whether a newer release generated this file: no release rewrites one (spec §3). */
function newerRelease(bytes: Buffer | null): boolean {
  const by = generatedBy(bytes);
  return by !== null && compareVersions(by, VERSION) > 0;
}

/** Text inside a markdown link label or a one-line list item. */
const inline = (text: string) => text.replace(/[\r\n]+/g, ' ').replace(/([[\]\\])/g, '\\$1');

function derivedFile(title: string, lines: readonly string[], empty: string): Buffer {
  const body = lines.length > 0 ? lines.join('\n') : empty;
  return Buffer.from(`---\n${formatLine('generated-by', VERSION)}\n---\n# ${title}\n\n${body}\n`, 'utf8');
}

/** One line per page, by slug: a link, the kind, conflicted when it is, and the summary. */
export function renderWikiIndex(pages: readonly WikiPage[], conflicted: (slug: string) => boolean): Buffer {
  const lines = pages.map(
    (page) =>
      `- [${inline(page.title || page.slug)}](${PAGES}/${page.slug}.md) (${inline(page.kind)}${conflicted(page.slug) ? ', conflicted' : ''}): ${inline(page.summary)}`,
  );
  return derivedFile('Wiki index', lines, 'No pages yet.');
}

/** One line per human wiki edit, oldest first. */
export function renderWikiLog(edits: readonly WikiEdit[]): Buffer {
  const lines = edits.map((edit) => {
    const person = typeof edit.actor.person === 'string' ? edit.actor.person : 'someone';
    const resolved = edit.resolved.length === 0 ? '' : `, resolving ${edit.resolved.length} conflict${edit.resolved.length === 1 ? '' : 's'}`;
    return `- ${edit.at}: ${person} ${edit.action === 'create' ? 'created' : 'updated'} [${edit.slug}](${PAGES}/${edit.slug}.md) (human wiki edit${resolved})`;
  });
  return derivedFile('Wiki log', lines, 'Nothing yet.');
}

/** The index and log for these contents; null for a file a newer release generated, which stays. */
function deriveWikiFiles(contents: WikiContents): { index: Buffer | null; log: Buffer | null } {
  const index = renderWikiIndex([...contents.pages.values()], (slug) => contents.conflicts.has(slug));
  const log = renderWikiLog(contents.edits);
  return {
    index: newerRelease(contents.index) || contents.index?.equals(index) ? null : index,
    log: newerRelease(contents.log) || contents.log?.equals(log) ? null : log,
  };
}

// ---------------------------------------------------------------------------
// Folds (spec §17, Folds)

/** Where a path sits in the wiki, as far as the fold's rules care; null outside the wiki. */
export function wikiKind(path: readonly string[]): 'wiki-dir' | 'wiki-page' | null {
  if (path[0] !== 'knowledge' || path[1] !== 'wiki') return null;
  if (path.length === 2) return 'wiki-dir';
  if (path.length === 4 && path[2] === PAGES && path[3]!.endsWith('.md')) return 'wiki-page';
  return null;
}

/** Orders two ISO times; unparsable ones compare as text. */
function compareTimes(x: string, y: string): number {
  const tx = Date.parse(x);
  const ty = Date.parse(y);
  if (!Number.isNaN(tx) && !Number.isNaN(ty) && tx !== ty) return tx - ty;
  return byCodePoint(x, y);
}

const laterTime = (x: string | null, y: string | null) => (x === null ? y : y === null ? x : compareTimes(x, y) >= 0 ? x : y);

export interface PageFold {
  readonly bytes: Buffer;
  /** The side set aside, to be written at `conflicts/<slug>/<name>.md` under the wiki; null when nothing was. */
  readonly conflict: { readonly name: string; readonly bytes: Buffer } | null;
}

/**
 * Folds two versions of one page over its base (null: both clones created it).
 * Title, kind and summary follow the scalar rule: a one-sided change wins,
 * otherwise the later write (`updated_at`, then the lower bytes). Bodies get
 * the hunk merge; when they merge cleanly, `sources` are the set union. When
 * hunks overlap, the later write's body is kept whole with its own `sources`,
 * and the other body is set aside with its own. Every value that lost goes into
 * one conflict record, which marks the page conflicted. Symmetric: swapping the
 * sides gives the same bytes.
 */
export function foldPage(
  slug: string,
  baseBytes: Buffer | null,
  aBytes: Buffer,
  bBytes: Buffer,
  mergeExtra: (base: Readonly<Record<string, string>>, a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>) => Record<string, string>,
): PageFold {
  const a = parsePage(slug, aBytes);
  const b = parsePage(slug, bBytes);
  const base = baseBytes ? parsePage(slug, baseBytes) : null;
  const order = compareTimes(a.updated_at, b.updated_at) || -Buffer.compare(aBytes, bBytes);
  const later = order >= 0 ? 'a' : 'b';
  const [kept, other] = later === 'a' ? [a, b] : [b, a];
  const lost = new Set<string>();

  const scalar = (field: (typeof SCALARS)[number]): string => {
    const [x, y] = [a[field], b[field]];
    if (x === y) return x;
    if (base && x === base[field]) return y;
    if (base && y === base[field]) return x;
    lost.add(field);
    return kept[field];
  };
  const title = scalar('title');
  const kind = scalar('kind');
  const summary = scalar('summary');

  let body: string;
  let sources: readonly string[];
  const merged = base ? mergeText(base.body, a.body, b.body, later) : a.body === b.body ? { text: a.body, conflicted: false } : null;
  if (merged && !merged.conflicted) {
    body = merged.text;
    sources = sortedUnique([...a.sources, ...b.sources]);
  } else {
    body = kept.body;
    sources = kept.sources;
    lost.add('body');
  }

  const page: WikiPage = {
    slug,
    title,
    kind,
    summary,
    sources,
    generated: laterTime(a.generated, b.generated),
    verified: laterTime(a.verified, b.verified),
    updated_at: laterTime(a.updated_at, b.updated_at) ?? '',
    body,
    extra: mergeExtra(base?.extra ?? {}, a.extra, b.extra),
  };
  if (lost.size === 0) return { bytes: serializePage(page), conflict: null };
  const fields = sortedUnique(lost);
  const side: Omit<WikiConflict, 'id'> = {
    slug,
    fields,
    ...Object.fromEntries(SCALARS.filter((field) => lost.has(field)).map((field) => [field, other[field]])),
    ...(lost.has('body') ? { body: other.body } : {}),
    sources: lost.has('body') ? other.sources : [],
    at: other.updated_at,
  };
  const bytes = serializeConflict(side);
  return { bytes: serializePage(page), conflict: { name: sha256(bytes), bytes } };
}

/** The path, under the wiki directory, of a page's set-aside side. */
export function wikiConflictPath(slug: string, name: string): string {
  return `${CONFLICTS}/${slug}/${name}.md`;
}

/** The derived file a side holds, and the release that generated it. */
async function derivedOf(source: ObjectSource, tree: string | null, name: string): Promise<Buffer | null> {
  if (!tree) return null;
  const entry = (await source.tree(tree)).find((e) => e.name === name);
  return entry && entry.mode !== TREE_MODE ? source.blob(entry.oid) : null;
}

/**
 * Regenerates the index and the log of a folded wiki directory: never merged
 * as text, always derived again from the folded pages and records. A file a
 * newer release generated on either side is kept instead (the newest such,
 * then the lower bytes), since no release rewrites one.
 */
export async function regenerateWikiTree(
  objects: ObjectSource & { editTree(base: string | null, edits: ReadonlyMap<string, FileEdit>): Promise<string | null> },
  merged: string | null,
  a: string | null,
  b: string | null,
): Promise<string | null> {
  if (!merged) return merged;
  const contents = await readWiki(objects, merged);
  const fresh = { [INDEX]: renderWikiIndex([...contents.pages.values()], (slug) => contents.conflicts.has(slug)), [LOG]: renderWikiLog(contents.edits) };
  const edits = new Map<string, FileEdit>();
  for (const name of [INDEX, LOG] as const) {
    const sides = (await Promise.all([derivedOf(objects, a, name), derivedOf(objects, b, name)])).filter((x): x is Buffer => x !== null && newerRelease(x));
    const newest = sides.sort((x, y) => compareVersions(generatedBy(y)!, generatedBy(x)!) || Buffer.compare(x, y))[0];
    const bytes = newest ?? fresh[name];
    const current = name === INDEX ? contents.index : contents.log;
    if (!current?.equals(bytes)) edits.set(name, bytes);
  }
  return edits.size === 0 ? merged : objects.editTree(merged, edits);
}
