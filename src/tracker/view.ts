// The read model: one immutable snapshot per tip, and the draft a write round
// edits on top of it.
import { TREE_MODE } from '../git/objects';
import { ID_LENGTH, ID_PREFIX, MAX_ID_LENGTH, notFound, resolveReadRef, resolveWriteRef } from './ids';
import {
  byCommentOrder,
  commentEntry,
  commentName,
  parseComment,
  serializeComment,
  type CommentEntry,
  type IssueComment,
} from './comment';
import {
  ATTEMPT_PATTERN,
  parseActivity,
  parseEnd,
  parseOutcome,
  parseStart,
  randomAttemptHandle,
  serializeEnd,
  serializeOutcome,
  serializeStart,
  serializeUpdateActivity,
  type ActivityEntry,
  type AttemptEnd,
  type AttemptOutcome,
  type AttemptRecord,
  type AttemptStart,
} from './attempt';
import {
  ACTIVITY_DIR,
  activityFile,
  attemptDir,
  ATTEMPTS_DIR,
  COMMENTS_DIR,
  commentFile,
  conflictsDir,
  CONFLICTS_DIR,
  DELETED_DIR,
  deletedFile,
  FORMAT_FILE,
  forwardFile,
  FORWARDS_DIR,
  issueDir,
  ISSUES_DIR,
  issueFile,
  LEDGER_DIR,
  ledgerFile,
  outcomeFile,
  OUTCOMES_DIR,
  SESSION_KEY_PATTERN,
  sessionFile,
  SESSIONS_DIR,
  PURGES_DIR,
  SETTINGS_FILE,
  skillVersionFile,
} from './layout';
import { parseConflict, type ConflictRecord } from './conflict';
import { parseMarker, type Marker } from './marker';
import { BoundedMap, type FileEdit, type ObjectSource, type TrackerObjects, type VirtualObjects } from './objects';
import { parseIssue, serializeIssue, type IssueRecord } from './record';
import { parseForward, parseTombstone, serializeForward, serializeTombstone, type Tombstone } from './retired';
import { parseSetting, serializeSettings, settingLine, settingLines, type StoreSetting } from './settings';
import { WikiDraftState, WikiReader, type WikiDraft, type WikiView } from './wiki';
import { QuarantineDraftState, QuarantineReader, type QuarantineDraft, type QuarantineView } from './quarantine';
import { ChoreRunDraftState, ChoreRunReader, type ChoreRunDraft, type ChoreRunView } from './chore-runs';
import { ProposalDraftState, ProposalReader, type ProposalDraft, type ProposalView } from './proposals';

/** What every read sees: the tracker at one tip. */
export interface TrackerView {
  /** The commit this view shows. */
  readonly tip: string;
  /** The commits it was read from: the tip, or both tips of a fold (local first). */
  readonly parents: readonly string[];
  /** The live issue with this full id. */
  issue(id: string): IssueRecord | undefined;
  /** Every live issue, ordered by (seq, id). */
  issues(): readonly IssueRecord[];
  /**
   * The id a read names: a full id, a unique prefix of at least 3 characters,
   * or text holding one full id. Throws INVALID, NOT_FOUND or AMBIGUOUS_REF.
   */
  resolveRead(ref: string, field?: string): string;
  /**
   * The live issue a write names by its full id: act on and store the id it
   * returns (a bare id can name the one side left of a collision). Throws
   * INVALID, NOT_FOUND or AMBIGUOUS_REF.
   */
  resolveWrite(ref: string, field?: string): string;
  /** `link_base` + the record's path, or the bare id when no `link_base` is set (spec §3, Links). */
  link(id: string): string;
  /** The issue's comments, oldest first, from their file names (no bodies read). */
  comments(id: string): readonly CommentEntry[];
  /** One comment of the issue, read in full. */
  readComment(issue: string, comment: string): Promise<IssueComment>;
  /** The issue's attempts, open and ended, in the order they opened (then by handle). */
  attempts(issue: string): readonly AttemptRecord[];
  /** The attempt with this handle, on any issue, or undefined. */
  attempt(handle: string): AttemptRecord | undefined;
  /** Every attempt the tracker holds, open and ended, on live and deleted issues alike. */
  allAttempts(): readonly AttemptRecord[];
  /**
   * One file of the attempt `handle`'s directory (its trace), by its path in
   * there (`issue-at-start.md`, `activity/<entry>.md`), as stored; null when
   * there is no such attempt or file.
   */
  traceFile(handle: string, file: string): Promise<Buffer | null>;
  /** The issue's fold conflict records, oldest first: what folds set aside until a human resolves it. */
  conflicts(id: string): readonly ConflictRecord[];
  /** The store settings (`settings.yml`) by key, unknown keys included; lines that aren't a setting are left out. */
  settings(): ReadonlyMap<string, StoreSetting>;
  /** The record a forwarding record (`forwards/<id>.md`) maps the bare id to, or undefined. */
  forwardOf(id: string): string | undefined;
  /** The delete tombstone (`deleted/<id>.md`) that retired the id, or undefined. */
  deletion(id: string): Tombstone | undefined;
  /**
   * The skill ledger's records as stored, `knowledge/ledger/<id>.md`, by id
   * (spec §18). Only files named by a sha256 are listed; the knowledge engine
   * reads them.
   */
  ledgerFiles(): Promise<ReadonlyMap<string, Buffer>>;
  /** A skill version's stored text, `knowledge/skill-versions/<version>.md`, or null. */
  skillVersion(version: string): Promise<Buffer | null>;
  /** One session record of the attempt `handle` (spec §3: `sessions/<session-key>.md`), or null when it has none. */
  sessionRecord(handle: string, key: string): Promise<Buffer | null>;
  /** The session keys of `handle` whose records a tombstone (`purges/<handle>/<key>.md`) purged: no write may recreate them (spec §3). */
  purgedSessions(handle: string): Promise<ReadonlySet<string>>;
  /** The wiki (spec §17): pages, their set-aside sides and the human wiki edits, read on first use. */
  readonly wiki: WikiView;
  /** Quarantine marks and clears (spec §17, §18), read on first use. */
  readonly quarantine: QuarantineView;
  /** The records of the chore runs that ended (spec §16), read on first use. */
  readonly choreRuns: ChoreRunView;
  /** The skill proposal records (spec §18), read on first use. */
  readonly proposals: ProposalView;
}

/** A sha256 in hex: how ledger records and skill versions are named. */
const SHA256_NAME = /^[0-9a-f]{64}$/;

function contentName(name: string, what: string): string {
  if (!SHA256_NAME.test(name)) throw new Error(`a ${what} is named by a sha256 in hex, not ${JSON.stringify(name)}`);
  return name;
}

/** A comment a write adds; the draft picks its id and time. */
export interface NewComment {
  readonly actor: Readonly<Record<string, unknown>>;
  readonly kind: 'comment' | 'debrief';
  readonly body: string;
  readonly attempt?: string;
  /** sha256 of the idempotency key. */
  readonly key?: string;
}

/** An attempt a write opens; the draft adds its time and start commit. */
export type NewAttempt = Omit<AttemptStart, 'at' | 'start_commit' | 'extra'>;
/** The seal a write puts on an open attempt; the draft adds its time. */
export type NewEnd = Omit<AttemptEnd, 'at' | 'extra'>;
/** A verdict a write records; the draft adds its time. */
export type NewOutcome = Omit<AttemptOutcome, 'at' | 'extra'>;

/** A view a write round edits; its edits become that round's one commit. */
export interface TrackerDraft extends TrackerView {
  /** The round's instant: use it for every timestamp the write records. */
  readonly now: Date;
  /** A fresh id, free on the local and the remote-tracking tip, never a deleted or forwarded one. */
  mintIssueId(): Promise<string>;
  /** 1 + the highest seq in the view (spec §3). */
  nextSeq(): number;
  /** Writes an issue record (canonically serialized; its unknown keys kept). */
  putIssue(record: IssueRecord): void;
  /**
   * Adds a write-once comment to a live issue (or, for an issue deleted
   * elsewhere, only to the activity/ of its open attempts). Its time is the round's instant,
   * forced past the issue's latest comment and the latest comment time this
   * store wrote; comments added in one round are ordered by `n`. Every attempt
   * open on the issue gets the same blob in its `activity/`.
   */
  addComment(issue: string, comment: NewComment): IssueComment;
  /**
   * Records a field change on the issue in the `activity/` of every attempt
   * open on it: who changed which fields, and the handle the write named.
   */
  addActivity(issue: string, entry: { actor: Readonly<Record<string, unknown>>; attempt?: string; fields: readonly string[] }): void;
  /**
   * Opens an attempt on a live issue under a fresh `at-` handle: `start.md`,
   * and `issue-at-start.md` holding the issue as it stands in this draft.
   */
  openAttempt(issue: string, start: NewAttempt): AttemptRecord;
  /** Writes the open attempt's `end.md`. */
  sealAttempt(handle: string, end: NewEnd): void;
  /** Writes the attempt's outcome record. */
  putOutcome(handle: string, outcome: NewOutcome): void;
  /**
   * Deletes a live issue (spec §3, Delete): its whole directory goes, comments
   * and conflict records included, and `deleted/<id>.md` records who and when.
   * Its attempts and outcomes stay. The caller strips the id from other
   * issues' `blocked_by`.
   */
  deleteIssue(id: string, by: string): void;
  /** Removes every fold conflict record of a live issue: a human resolved it. */
  clearConflicts(id: string): void;
  /** Sets a store setting: its value, the round's instant as `at`, and `by`. */
  putSetting(key: string, value: unknown, by: string): void;
  /** Writes the forwarding record that maps the bare id `id` to the live record `to`. */
  putForward(id: string, to: string, by: string): void;
  /** Adds a write-once skill ledger record, named by its sha256. */
  putLedgerFile(id: string, bytes: Buffer): void;
  /** Stores a skill version's text, named by its sha256; one already stored stays as it is. */
  putSkillVersion(version: string, bytes: Buffer): void;
  /**
   * Writes one session record of the attempt `handle` (spec §14). The caller
   * decides whether it may replace the stored one, and never writes one a
   * tombstone purged (`purgedSessions`).
   */
  putSessionRecord(handle: string, key: string, bytes: Buffer): void;
  /** The wiki as this round changes it; page writes regenerate the derived index and log. */
  readonly wiki: WikiDraft;
  /** Quarantine as this round changes it. */
  readonly quarantine: QuarantineDraft;
  /** Chore-run records as this round adds them. */
  readonly choreRuns: ChoreRunDraft;
  /** Skill proposals as this round adds them. */
  readonly proposals: ProposalDraft;
}

function byOrder(a: IssueRecord, b: IssueRecord): number {
  return a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The settings among raw `settings.yml` lines (lines that aren't `{value, at, by}` are left out). */
function settingsOf(lines: ReadonlyMap<string, string>): Map<string, StoreSetting> {
  const settings = new Map<string, StoreSetting>();
  for (const [key, raw] of lines) {
    const setting = parseSetting(raw);
    if (setting) settings.set(key, setting);
  }
  return settings;
}

/** `link_base` + the record's path, or the bare id when no `link_base` is set (spec §3, Links). */
function linkOf(settings: ReadonlyMap<string, StoreSetting>, id: string): string {
  const base = settings.get('link_base')?.value;
  return typeof base === 'string' && base !== '' ? base + issueFile(id) : id;
}

function byOpening(a: AttemptRecord, b: AttemptRecord): number {
  return a.start.at < b.start.at ? -1 : a.start.at > b.start.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** What a snapshot is built from. */
export interface SnapshotParts {
  /** The commit the view is based on: the tip, or the local tip of a fold. */
  readonly tip: string;
  /** The parents a write on this view commits with: the tip, or both tips of a fold. */
  readonly parents: readonly string[];
  readonly rootTree: string;
  /** Reads the view's objects (a fold's own objects first). */
  readonly source: ObjectSource;
  /** A fold's in-memory objects, persisted by the write that commits the fold; null otherwise. */
  readonly virtual: VirtualObjects | null;
  readonly marker: Marker | null;
  readonly records: ReadonlyMap<string, IssueRecord>;
  /** Each live issue's `issue.md` blob. */
  readonly issueBlobs: ReadonlyMap<string, string>;
  /** `settings.yml`, or null when the tracker has none. */
  readonly settingsBytes: Buffer | null;
  /** Deleted ids, with their tombstones. */
  readonly deleted: ReadonlyMap<string, Tombstone>;
  /** Forwarded bare ids, with the record each forwards to (empty when the record doesn't say). */
  readonly forwards: ReadonlyMap<string, string>;
  /** Each issue's comment files, in comment order. */
  readonly commentFiles: ReadonlyMap<string, readonly StoredComment[]>;
  /** Each issue's attempts, in opening order. */
  readonly attemptLists: ReadonlyMap<string, readonly AttemptRecord[]>;
  /** Each issue's conflict records, oldest first. */
  readonly conflictLists: ReadonlyMap<string, readonly ConflictRecord[]>;
}

export class Snapshot implements TrackerView {
  readonly tip: string;
  readonly parents: readonly string[];
  readonly rootTree: string;
  readonly source: ObjectSource;
  readonly virtual: VirtualObjects | null;
  readonly marker: Marker | null;
  /** Ids gone from the live view but never reused: deleted and forwarded. */
  readonly retiredIds: ReadonlySet<string>;
  readonly ids: ReadonlySet<string>;
  /** `settings.yml`'s raw line values, by key (every line, settings or not). */
  readonly settingLines: ReadonlyMap<string, string>;
  private readonly records: ReadonlyMap<string, IssueRecord>;
  private readonly issueBlobs: ReadonlyMap<string, string>;
  private readonly settingMap: ReadonlyMap<string, StoreSetting>;
  private readonly deleted: ReadonlyMap<string, Tombstone>;
  private readonly forwards: ReadonlyMap<string, string>;
  private readonly commentFiles: ReadonlyMap<string, readonly StoredComment[]>;
  private readonly attemptLists: ReadonlyMap<string, readonly AttemptRecord[]>;
  private readonly conflictLists: ReadonlyMap<string, readonly ConflictRecord[]>;
  private readonly ordered: readonly IssueRecord[];
  private readonly attemptsById = new Map<string, AttemptRecord>();
  readonly wiki: WikiReader;
  readonly quarantine: QuarantineReader;
  readonly choreRuns: ChoreRunReader;
  readonly proposals: ProposalReader;

  constructor(parts: SnapshotParts) {
    this.tip = parts.tip;
    this.parents = parts.parents;
    this.rootTree = parts.rootTree;
    this.source = parts.source;
    this.virtual = parts.virtual;
    this.marker = parts.marker;
    this.deleted = parts.deleted;
    this.forwards = parts.forwards;
    this.retiredIds = new Set([...parts.deleted.keys(), ...parts.forwards.keys()]);
    this.records = parts.records;
    this.issueBlobs = parts.issueBlobs;
    this.settingLines = settingLines(parts.settingsBytes);
    this.settingMap = settingsOf(this.settingLines);
    this.commentFiles = parts.commentFiles;
    this.attemptLists = parts.attemptLists;
    this.conflictLists = parts.conflictLists;
    this.ordered = [...parts.records.values()].sort(byOrder);
    this.ids = new Set(parts.records.keys());
    for (const list of parts.attemptLists.values()) for (const attempt of list) this.attemptsById.set(attempt.id, attempt);
    this.wiki = new WikiReader(parts.source, parts.rootTree);
    this.quarantine = new QuarantineReader(() => this.ledgerFiles());
    this.choreRuns = new ChoreRunReader(parts.source, parts.rootTree);
    this.proposals = new ProposalReader(parts.source, parts.rootTree);
  }

  issue(id: string): IssueRecord | undefined {
    return this.records.get(id);
  }

  issues(): readonly IssueRecord[] {
    return this.ordered;
  }

  /** The live issue's `issue.md` blob. */
  issueBlob(id: string): string | undefined {
    return this.issueBlobs.get(id);
  }

  resolveRead(ref: string, field = 'ref'): string {
    return resolveReadRef(ref, this.ids, field, this);
  }

  resolveWrite(ref: string, field = 'id'): string {
    return resolveWriteRef(ref, this.ids, field, this);
  }

  link(id: string): string {
    return linkOf(this.settingMap, id);
  }

  settings(): ReadonlyMap<string, StoreSetting> {
    return this.settingMap;
  }

  forwardOf(id: string): string | undefined {
    return this.forwards.get(id) || undefined;
  }

  deletion(id: string): Tombstone | undefined {
    return this.deleted.get(id);
  }

  comments(id: string): readonly CommentEntry[] {
    return this.commentFiles.get(id) ?? [];
  }

  async readComment(issue: string, comment: string): Promise<IssueComment> {
    const stored = this.commentFiles.get(issue)?.find((c) => c.id === comment);
    if (!stored) throw new Error(`no comment ${comment} on ${issue}`);
    return parseComment(stored.id, await this.source.blob(stored.oid));
  }

  attempts(issue: string): readonly AttemptRecord[] {
    return this.attemptLists.get(issue) ?? [];
  }

  attempt(handle: string): AttemptRecord | undefined {
    return this.attemptsById.get(handle);
  }

  allAttempts(): readonly AttemptRecord[] {
    return [...this.attemptsById.values()];
  }

  async traceFile(handle: string, file: string): Promise<Buffer | null> {
    const record = this.attemptsById.get(handle);
    return record ? this.source.fileAt(this.rootTree, `${attemptDir(record.issue, handle)}/${file}`) : null;
  }

  conflicts(id: string): readonly ConflictRecord[] {
    return this.conflictLists.get(id) ?? [];
  }

  private ledger: Promise<ReadonlyMap<string, Buffer>> | null = null;

  ledgerFiles(): Promise<ReadonlyMap<string, Buffer>> {
    if (!this.ledger) {
      const loading = (async () => {
        const entries = await this.source.dirAt(this.rootTree, LEDGER_DIR);
        const files = entries.filter((e) => e.mode !== TREE_MODE && e.name.endsWith('.md') && SHA256_NAME.test(e.name.slice(0, -3)));
        const read = await Promise.all(files.map(async (e) => [e.name.slice(0, -3), await this.source.blob(e.oid)] as const));
        return new Map(read);
      })();
      // A failed read (a missing object) is tried again next time.
      loading.catch(() => {
        if (this.ledger === loading) this.ledger = null;
      });
      this.ledger = loading;
    }
    return this.ledger;
  }

  skillVersion(version: string): Promise<Buffer | null> {
    if (!SHA256_NAME.test(version)) return Promise.resolve(null);
    return this.source.fileAt(this.rootTree, skillVersionFile(version));
  }

  async sessionRecord(handle: string, key: string): Promise<Buffer | null> {
    const oid = this.attempt(handle)?.sessions.get(key);
    return oid === undefined ? null : this.source.blob(oid);
  }

  async purgedSessions(handle: string): Promise<ReadonlySet<string>> {
    if (!ATTEMPT_PATTERN.test(handle)) return new Set();
    const entries = await this.source.dirAt(this.rootTree, `${PURGES_DIR}/${handle}`);
    return new Set(entries.filter((e) => e.mode !== TREE_MODE && e.name.endsWith('.md')).map((e) => e.name.slice(0, -3)));
  }
}

interface StoredComment extends CommentEntry {
  readonly oid: string;
}

interface OpenedAttempt {
  readonly issue: string;
  readonly start: AttemptStart;
  readonly issueAtStart: FileEdit;
}

interface DraftActivity {
  readonly issue: string;
  readonly entry: ActivityEntry;
  /** An update entry's own bytes; a comment's entry reuses the comment's blob. */
  readonly bytes: Buffer | null;
}

export class Draft implements TrackerDraft {
  private readonly written = new Map<string, IssueRecord>();
  private readonly minted = new Set<string>();
  private readonly added = new Map<string, IssueComment[]>();
  private readonly opened = new Map<string, OpenedAttempt>();
  private readonly sealed = new Map<string, AttemptEnd>();
  private readonly outcomes = new Map<string, AttemptOutcome>();
  /** Activity entries this round adds, by attempt handle. */
  private readonly activity = new Map<string, DraftActivity[]>();
  /** Issues this round deletes, with who deletes them. */
  private readonly deletedHere = new Map<string, string>();
  /** Issues whose conflict records this round removes. */
  private readonly resolvedHere = new Set<string>();
  /** Store settings this round sets. */
  private readonly settingsHere = new Map<string, StoreSetting>();
  /** Forwarding records this round writes, by bare id. */
  private readonly forwardsHere = new Map<string, { to: string; by: string }>();
  /** Ledger records this round adds, by id. */
  private readonly ledgerHere = new Map<string, Buffer>();
  /** Skill versions this round stores, by version id. */
  private readonly versionsHere = new Map<string, Buffer>();
  /** Session records this round writes, by attempt handle, then session key. */
  private readonly sessionsHere = new Map<string, Map<string, Buffer>>();
  private commentMs: number | null = null;
  private commentN = 0;
  readonly wiki: WikiDraftState;
  readonly quarantine: QuarantineDraftState;
  readonly choreRuns: ChoreRunDraftState;
  readonly proposals: ProposalDraftState;

  constructor(
    private readonly base: Snapshot,
    readonly now: Date,
    /** Every id taken on either tip, retired ones included. */
    private readonly takenIds: () => Promise<ReadonlySet<string>>,
    private readonly randomSuffix: (length: number) => string,
    /** The latest comment time this store has written, in epoch ms. */
    private readonly storeCommentMs = 0,
    private readonly randomHandle: () => string = randomAttemptHandle,
  ) {
    this.choreRuns = new ChoreRunDraftState(base.choreRuns);
    this.proposals = new ProposalDraftState(base.proposals);
    this.wiki = new WikiDraftState(base.wiki, now, () => this.choreRuns.records());
    this.quarantine = new QuarantineDraftState(base.quarantine, now);
  }

  get tip(): string {
    return this.base.tip;
  }

  get parents(): readonly string[] {
    return this.base.parents;
  }

  issue(id: string): IssueRecord | undefined {
    if (this.deletedHere.has(id)) return undefined;
    return this.written.get(id) ?? this.base.issue(id);
  }

  issues(): readonly IssueRecord[] {
    if (this.written.size === 0 && this.deletedHere.size === 0) return this.base.issues();
    const merged = new Map(this.base.issues().map((r) => [r.id, r]));
    for (const [id, record] of this.written) merged.set(id, record);
    for (const id of this.deletedHere.keys()) merged.delete(id);
    return [...merged.values()].sort(byOrder);
  }

  private liveIds(): ReadonlySet<string> {
    const ids = new Set([...this.base.ids, ...this.written.keys()]);
    for (const id of this.deletedHere.keys()) ids.delete(id);
    return ids;
  }

  resolveRead(ref: string, field = 'ref'): string {
    return resolveReadRef(ref, this.liveIds(), field, this);
  }

  resolveWrite(ref: string, field = 'id'): string {
    return resolveWriteRef(ref, this.liveIds(), field, this);
  }

  link(id: string): string {
    return linkOf(this.settings(), id);
  }

  settings(): ReadonlyMap<string, StoreSetting> {
    if (this.settingsHere.size === 0) return this.base.settings();
    return new Map([...this.base.settings(), ...this.settingsHere]);
  }

  forwardOf(id: string): string | undefined {
    return this.forwardsHere.get(id)?.to ?? this.base.forwardOf(id);
  }

  deletion(id: string): Tombstone | undefined {
    const by = this.deletedHere.get(id);
    return by !== undefined ? { by, at: this.now.toISOString(), extra: {} } : this.base.deletion(id);
  }

  comments(id: string): readonly CommentEntry[] {
    const added = this.added.get(id);
    if (!added) return this.base.comments(id);
    return [...this.base.comments(id), ...added.map((c) => commentEntry(c.id)!)].sort(byCommentOrder);
  }

  async readComment(issue: string, comment: string): Promise<IssueComment> {
    return this.added.get(issue)?.find((c) => c.id === comment) ?? this.base.readComment(issue, comment);
  }

  /** An attempt as this draft leaves it. */
  private withEdits(record: AttemptRecord): AttemptRecord {
    const end = this.sealed.get(record.id);
    const outcome = this.outcomes.get(record.id);
    const activity = this.activity.get(record.id);
    if (!end && !outcome && !activity) return record;
    return {
      ...record,
      end: end ?? record.end,
      outcome: outcome ?? record.outcome,
      activity: activity ? [...record.activity, ...activity.map((a) => a.entry)] : record.activity,
    };
  }

  attempts(issue: string): readonly AttemptRecord[] {
    const records = this.base.attempts(issue).map((record) => this.withEdits(record));
    for (const [id, opened] of this.opened) {
      if (opened.issue === issue) {
        records.push(
          this.withEdits({ id, issue, start: opened.start, end: null, outcome: null, activity: [], setAside: [], sessions: new Map() }),
        );
      }
    }
    return records.sort(byOpening);
  }

  attempt(handle: string): AttemptRecord | undefined {
    const opened = this.opened.get(handle);
    if (opened) return this.attempts(opened.issue).find((a) => a.id === handle);
    const record = this.base.attempt(handle);
    return record ? this.withEdits(record) : undefined;
  }

  allAttempts(): readonly AttemptRecord[] {
    return [...this.base.allAttempts().map((record) => this.withEdits(record)), ...[...this.opened.keys()].map((handle) => this.attempt(handle)!)];
  }

  traceFile(handle: string, file: string): Promise<Buffer | null> {
    return this.base.traceFile(handle, file);
  }

  conflicts(id: string): readonly ConflictRecord[] {
    return this.resolvedHere.has(id) || this.deletedHere.has(id) ? [] : this.base.conflicts(id);
  }

  deleteIssue(id: string, by: string): void {
    if (!this.issue(id)) throw notFound('id', id);
    this.deletedHere.set(id, by);
  }

  clearConflicts(id: string): void {
    if (!this.issue(id)) throw notFound('id', id);
    this.resolvedHere.add(id);
  }

  putSetting(key: string, value: unknown, by: string): void {
    this.settingsHere.set(key, { value, at: this.now.toISOString(), by });
  }

  putForward(id: string, to: string, by: string): void {
    if (!this.issue(to)) throw notFound('keep', to);
    this.forwardsHere.set(id, { to, by });
  }

  async ledgerFiles(): Promise<ReadonlyMap<string, Buffer>> {
    const stored = await this.base.ledgerFiles();
    return this.ledgerHere.size === 0 ? stored : new Map([...stored, ...this.ledgerHere]);
  }

  async skillVersion(version: string): Promise<Buffer | null> {
    return this.versionsHere.get(version) ?? this.base.skillVersion(version);
  }

  putLedgerFile(id: string, bytes: Buffer): void {
    this.ledgerHere.set(contentName(id, 'ledger record'), bytes);
  }

  putSkillVersion(version: string, bytes: Buffer): void {
    this.versionsHere.set(contentName(version, 'skill version'), bytes);
  }

  async sessionRecord(handle: string, key: string): Promise<Buffer | null> {
    return this.sessionsHere.get(handle)?.get(key) ?? this.base.sessionRecord(handle, key);
  }

  purgedSessions(handle: string): Promise<ReadonlySet<string>> {
    return this.base.purgedSessions(handle);
  }

  putSessionRecord(handle: string, key: string, bytes: Buffer): void {
    if (!this.attempt(handle)) throw new Error(`no attempt ${handle}`);
    if (!SESSION_KEY_PATTERN.test(key)) throw new Error(`a session key is a hex hash, not ${JSON.stringify(key)}`);
    let records = this.sessionsHere.get(handle);
    if (!records) this.sessionsHere.set(handle, (records = new Map()));
    records.set(key, bytes);
  }

  private openAttemptsOf(issue: string): AttemptRecord[] {
    return this.attempts(issue).filter((attempt) => attempt.end === null);
  }

  private pushActivity(handle: string, item: DraftActivity): void {
    let list = this.activity.get(handle);
    if (!list) this.activity.set(handle, (list = []));
    list.push(item);
  }

  addComment(issue: string, comment: NewComment): IssueComment {
    const live = this.issue(issue) !== undefined;
    // An issue deleted elsewhere keeps no comments; one made while ending an
    // attempt on it lives only in that attempt's activity/.
    if (!live && this.openAttemptsOf(issue).length === 0) throw notFound('id', issue);
    const existing = this.comments(issue);
    const latest = existing.length > 0 ? existing[existing.length - 1]!.ms : 0;
    const ms = Math.max(this.commentMs ?? Math.max(this.now.getTime(), this.storeCommentMs + 1), latest + 1);
    this.commentMs = ms;
    const added: IssueComment = {
      id: commentName(ms, this.commentN++),
      at: new Date(ms).toISOString(),
      kind: comment.kind,
      actor: comment.actor,
      ...(comment.attempt !== undefined ? { attempt: comment.attempt } : {}),
      ...(comment.key !== undefined ? { key: comment.key } : {}),
      body: comment.body,
    };
    let bytes: Buffer | null = null;
    if (live) {
      let list = this.added.get(issue);
      if (!list) this.added.set(issue, (list = []));
      list.push(added);
    } else {
      const { id: _id, ...stored } = added;
      bytes = serializeComment(stored);
    }
    const entry: ActivityEntry = {
      ...commentEntry(added.id)!,
      detail: {
        kind: added.kind,
        actor: added.actor,
        ...(added.attempt !== undefined ? { attempt: added.attempt } : {}),
        fields: [],
      },
    };
    for (const attempt of this.openAttemptsOf(issue)) this.pushActivity(attempt.id, { issue, entry, bytes });
    return added;
  }

  addActivity(
    issue: string,
    { actor, attempt, fields }: { actor: Readonly<Record<string, unknown>>; attempt?: string; fields: readonly string[] },
  ): void {
    const open = this.openAttemptsOf(issue);
    if (open.length === 0) return;
    const ms = this.commentMs ?? this.now.getTime();
    const at = new Date(ms).toISOString();
    const id = commentName(ms, this.commentN++);
    const entry: ActivityEntry = {
      ...commentEntry(id)!,
      detail: { kind: 'update', actor, ...(attempt !== undefined ? { attempt } : {}), fields: [...fields] },
    };
    const bytes = serializeUpdateActivity({ actor, at, ...(attempt !== undefined ? { attempt } : {}), fields });
    for (const record of open) this.pushActivity(record.id, { issue, entry, bytes });
  }

  /** The comment time this round used, in epoch ms, or null when it added none. */
  get roundCommentMs(): number | null {
    return this.commentMs;
  }

  async mintIssueId(): Promise<string> {
    const taken = await this.takenIds();
    // Three clashes in a row add a character (spec §3).
    for (let length = ID_LENGTH; length <= MAX_ID_LENGTH; length++) {
      for (let clash = 0; clash < 3; clash++) {
        const id = ID_PREFIX + this.randomSuffix(length);
        if (!taken.has(id) && !this.minted.has(id) && !this.written.has(id)) {
          this.minted.add(id);
          return id;
        }
      }
    }
    throw new Error('could not mint a free issue id: the random source keeps repeating taken ids');
  }

  nextSeq(): number {
    let highest = 0;
    for (const record of this.issues()) highest = Math.max(highest, record.seq);
    return highest + 1;
  }

  putIssue(record: IssueRecord): void {
    this.written.set(record.id, record);
  }

  openAttempt(issue: string, start: NewAttempt): AttemptRecord {
    if (!this.issue(issue)) throw notFound('id', issue);
    let handle = this.randomHandle();
    for (let tries = 0; this.base.attempt(handle) || this.opened.has(handle); tries++) {
      if (tries > 16) throw new Error('could not mint a free attempt handle: the random source keeps repeating');
      handle = this.randomHandle();
    }
    const written = this.written.get(issue);
    const blob = this.base.issueBlob(issue);
    const record: AttemptStart = { ...start, at: this.now.toISOString(), start_commit: this.base.tip, extra: {} };
    this.opened.set(handle, {
      issue,
      start: record,
      issueAtStart: written || !blob ? serializeIssue(this.issue(issue)!) : { oid: blob },
    });
    return this.attempt(handle)!;
  }

  sealAttempt(handle: string, end: NewEnd): void {
    const attempt = this.attempt(handle);
    if (!attempt || attempt.end) throw new Error(`attempt ${handle} is not open`);
    this.sealed.set(handle, { ...end, at: this.now.toISOString(), extra: {} });
  }

  putOutcome(handle: string, outcome: NewOutcome): void {
    const attempt = this.attempt(handle);
    if (!attempt) throw new Error(`no attempt ${handle}`);
    this.outcomes.set(handle, { ...outcome, at: this.now.toISOString(), extra: attempt.outcome?.extra ?? {} });
  }

  /** The file edits this round's commit makes. */
  edits(): Map<string, FileEdit> {
    const edits = new Map<string, FileEdit>();
    for (const record of this.written.values()) {
      if (!this.deletedHere.has(record.id)) edits.set(issueFile(record.id), serializeIssue(record));
    }
    const at = this.now.toISOString();
    for (const [id, by] of this.deletedHere) {
      edits.set(issueDir(id), null);
      edits.set(deletedFile(id), serializeTombstone({ by, at, extra: {} }));
    }
    for (const id of this.resolvedHere) if (!this.deletedHere.has(id)) edits.set(conflictsDir(id), null);
    if (this.settingsHere.size > 0) {
      const lines = new Map(this.base.settingLines);
      for (const [key, setting] of this.settingsHere) lines.set(key, settingLine(setting));
      edits.set(SETTINGS_FILE, serializeSettings(lines));
    }
    for (const [id, { to, by }] of this.forwardsHere) edits.set(forwardFile(id), serializeForward({ to, by, at, extra: {} }));
    for (const [id, bytes] of this.ledgerHere) edits.set(ledgerFile(id), bytes);
    for (const [version, bytes] of this.versionsHere) edits.set(skillVersionFile(version), bytes);
    const commentBytes = new Map<string, Buffer>();
    for (const [issue, comments] of this.added) {
      for (const { id, ...comment } of comments) {
        const bytes = serializeComment(comment);
        commentBytes.set(id, bytes);
        edits.set(commentFile(issue, id), bytes);
      }
    }
    for (const [handle, opened] of this.opened) {
      const dir = attemptDir(opened.issue, handle);
      edits.set(`${dir}/start.md`, serializeStart(opened.start));
      edits.set(`${dir}/issue-at-start.md`, opened.issueAtStart);
    }
    for (const [handle, items] of this.activity) {
      for (const { issue, entry, bytes } of items) {
        // A comment's entry is the comment's own blob.
        edits.set(activityFile(issue, handle, entry.id), bytes ?? commentBytes.get(entry.id)!);
      }
    }
    for (const [handle, end] of this.sealed) {
      const issue = this.attempt(handle)!.issue;
      edits.set(`${attemptDir(issue, handle)}/end.md`, serializeEnd(end));
    }
    for (const [handle, outcome] of this.outcomes) {
      edits.set(outcomeFile(this.attempt(handle)!.issue, handle), serializeOutcome(outcome));
    }
    for (const [handle, records] of this.sessionsHere) {
      const issue = this.attempt(handle)!.issue;
      for (const [key, bytes] of records) edits.set(sessionFile(issue, handle, key), bytes);
    }
    for (const [file, edit] of this.wiki.fileEdits()) edits.set(file, edit);
    for (const [file, edit] of this.quarantine.fileEdits()) edits.set(file, edit);
    for (const [file, edit] of this.choreRuns.fileEdits()) edits.set(file, edit);
    for (const [file, edit] of this.proposals.fileEdits()) edits.set(file, edit);
    return edits;
  }
}

interface IssueEntry {
  readonly record: IssueRecord;
  readonly oid: string;
  readonly comments: readonly StoredComment[];
  /** Its conflict records, oldest first. */
  readonly conflicts: readonly ConflictRecord[];
}

type LoadedAttempt = Omit<AttemptRecord, 'outcome'>;

interface LoadedOutcome {
  readonly issue: string;
  readonly attempt: string;
  readonly outcome: AttemptOutcome;
}

/** What the loader remembers by oid; objects are immutable, so a fold's in-memory ones share it. */
class LoaderMemos {
  readonly issuesByTree = new BoundedMap<string, readonly IssueEntry[]>(8_192);
  readonly namesByTree = new BoundedMap<string, readonly string[]>(8_192);
  readonly records = new BoundedMap<string, IssueRecord>(50_000);
  readonly attemptsByTree = new BoundedMap<string, readonly LoadedAttempt[]>(8_192);
  readonly outcomesByTree = new BoundedMap<string, readonly LoadedOutcome[]>(8_192);
  readonly tombstonesByTree = new BoundedMap<string, ReadonlyMap<string, Tombstone>>(64);
}

/** Builds snapshots from tracker trees, memoizing every subtree by oid. */
export class SnapshotLoader {
  private readonly issuesByTree: BoundedMap<string, readonly IssueEntry[]>;
  private readonly namesByTree: BoundedMap<string, readonly string[]>;
  private readonly records: BoundedMap<string, IssueRecord>;
  private readonly attemptsByTree: BoundedMap<string, readonly LoadedAttempt[]>;
  private readonly outcomesByTree: BoundedMap<string, readonly LoadedOutcome[]>;

  constructor(
    private readonly objects: TrackerObjects | VirtualObjects,
    private readonly memos = new LoaderMemos(),
  ) {
    this.issuesByTree = memos.issuesByTree;
    this.namesByTree = memos.namesByTree;
    this.records = memos.records;
    this.attemptsByTree = memos.attemptsByTree;
    this.outcomesByTree = memos.outcomesByTree;
  }

  /** The snapshot at the commit `tip`. */
  async load(tip: string): Promise<Snapshot> {
    const { tree } = await this.objects.commit(tip);
    return this.loadTree(tip, [tip], tree, null);
  }

  /** The snapshot of a fold: its merged tree, read from `virtual`, committed later with both tips as parents. */
  folded(local: string, remote: string, tree: string, virtual: VirtualObjects): Promise<Snapshot> {
    return new SnapshotLoader(virtual, this.memos).loadTree(local, [local, remote], tree, virtual);
  }

  private async loadTree(
    tip: string,
    parents: readonly string[],
    tree: string,
    virtual: VirtualObjects | null,
  ): Promise<Snapshot> {
    const root = await this.objects.tree(tree);
    const find = (name: string) => root.find((entry) => entry.name === name);
    const subtree = (name: string) => {
      const entry = find(name);
      return entry?.mode === TREE_MODE ? entry.oid : null;
    };
    const [issues, markerBytes, settingsBytes, deleted, forwards, attempts, outcomes] = await Promise.all([
      this.issuesUnder(subtree(ISSUES_DIR), 0),
      this.blobOf(find(FORMAT_FILE)),
      this.blobOf(find(SETTINGS_FILE)),
      this.deletedIn(tree),
      this.forwardsIn(tree),
      this.sharded(subtree(ATTEMPTS_DIR), 0, this.attemptsByTree, (issue, oid) => this.attemptsOf(issue, oid)),
      this.sharded(subtree(OUTCOMES_DIR), 0, this.outcomesByTree, (issue, oid) => this.outcomesOf(issue, oid)),
    ]);
    const verdicts = new Map(outcomes.map((o) => [`${o.issue}/${o.attempt}`, o.outcome]));
    const attemptLists = new Map<string, AttemptRecord[]>();
    for (const loaded of attempts) {
      let list = attemptLists.get(loaded.issue);
      if (!list) attemptLists.set(loaded.issue, (list = []));
      list.push({ ...loaded, outcome: verdicts.get(`${loaded.issue}/${loaded.id}`) ?? null });
    }
    for (const list of attemptLists.values()) list.sort(byOpening);
    return new Snapshot({
      tip,
      parents,
      rootTree: tree,
      source: this.objects,
      virtual,
      marker: markerBytes ? parseMarker(markerBytes.toString('utf8')) : null,
      records: new Map(issues.map(({ record }) => [record.id, record])),
      issueBlobs: new Map(issues.map(({ record, oid }) => [record.id, oid])),
      settingsBytes,
      deleted,
      forwards,
      commentFiles: new Map(issues.map(({ record, comments }) => [record.id, comments])),
      attemptLists,
      conflictLists: new Map(issues.map(({ record, conflicts }) => [record.id, conflicts])),
    });
  }

  /** Every id a tip holds, live or retired, from tree names alone. */
  async takenIds(tip: string): Promise<Set<string>> {
    const { tree } = await this.objects.commit(tip);
    const issues = await this.objects.entryAt(tree, ISSUES_DIR);
    const names = issues && issues.mode === TREE_MODE ? await this.namesUnder(issues.oid, 0) : [];
    return new Set([...names.map((name) => name.replace(/~.*$/, '')), ...(await this.retiredIn(tree))]);
  }

  private async blobOf(entry: { mode: string; oid: string } | undefined): Promise<Buffer | null> {
    return entry && entry.mode !== TREE_MODE ? this.objects.blob(entry.oid) : null;
  }

  private async retiredIn(tree: string): Promise<Set<string>> {
    const [deleted, forwards] = await Promise.all([
      this.objects.dirAt(tree, DELETED_DIR),
      this.objects.dirAt(tree, FORWARDS_DIR),
    ]);
    return new Set([...deleted, ...forwards].map((entry) => entry.name.replace(/\.md$/, '')));
  }

  /** The delete tombstones under `deleted/`, by id (memoized by the directory's oid). */
  private async deletedIn(tree: string): Promise<ReadonlyMap<string, Tombstone>> {
    const dir = await this.objects.entryAt(tree, DELETED_DIR);
    if (!dir || dir.mode !== TREE_MODE) return new Map();
    let tombstones = this.memos.tombstonesByTree.get(dir.oid);
    if (!tombstones) {
      const files = (await this.objects.tree(dir.oid)).filter((e) => e.mode !== TREE_MODE && e.name.endsWith('.md'));
      const parsed = await Promise.all(
        files.map(async (e) => [e.name.slice(0, -3), parseTombstone(await this.objects.blob(e.oid))] as const),
      );
      tombstones = new Map(parsed);
      this.memos.tombstonesByTree.set(dir.oid, tombstones);
    }
    return tombstones;
  }

  /** The forwarding records under `forwards/`: each bare id with the record it forwards to. */
  private async forwardsIn(tree: string): Promise<Map<string, string>> {
    const entries = (await this.objects.dirAt(tree, FORWARDS_DIR)).filter((e) => e.mode !== TREE_MODE && e.name.endsWith('.md'));
    const parsed = await Promise.all(
      entries.map(async (e) => [e.name.slice(0, -3), parseForward(await this.objects.blob(e.oid)).to] as const),
    );
    return new Map(parsed);
  }

  /**
   * Records under `issues/` (depth 0), `<a>` (1), `<b>` (2) or the issue
   * directory `name` (3). A record is known by its directory's name: its id,
   * or `<id>~<hash4>` for one side of a cross-clone id collision.
   */
  private async issuesUnder(oid: string | null, depth: number, name = ''): Promise<readonly IssueEntry[]> {
    if (!oid) return [];
    const memoKey = `${depth}:${oid}:${name}`;
    const cached = this.issuesByTree.get(memoKey);
    if (cached) return cached;
    const entries = await this.objects.tree(oid);
    let records: readonly IssueEntry[];
    if (depth < 3) {
      const children = await Promise.all(
        entries.filter((e) => e.mode === TREE_MODE).map((e) => this.issuesUnder(e.oid, depth + 1, e.name)),
      );
      records = children.flat();
    } else {
      const file = entries.find((e) => e.name === 'issue.md' && e.mode !== TREE_MODE);
      const dir = entries.find((e) => e.name === COMMENTS_DIR && e.mode === TREE_MODE);
      const conflicts = entries.find((e) => e.name === CONFLICTS_DIR && e.mode === TREE_MODE);
      if (file) {
        const record = await this.record(file.oid);
        records = [
          {
            record: record.id === name ? record : { ...record, id: name },
            oid: file.oid,
            comments: dir ? await this.commentsIn(dir.oid) : [],
            conflicts: conflicts ? await this.conflictsIn(conflicts.oid) : [],
          },
        ];
      } else records = [];
    }
    this.issuesByTree.set(memoKey, records);
    return records;
  }

  /**
   * What `leaf` finds in each issue directory of a tree sharded like
   * `attempts/` and `outcomes/`: `<root>` (depth 0), `<a>` (1), `<b>` (2),
   * whose entries are the issue directories.
   */
  private async sharded<T>(
    oid: string | null,
    depth: number,
    memo: BoundedMap<string, readonly T[]>,
    leaf: (issue: string, oid: string) => Promise<readonly T[]>,
  ): Promise<readonly T[]> {
    if (!oid) return [];
    const memoKey = `${depth}:${oid}`;
    const cached = memo.get(memoKey);
    if (cached) return cached;
    const dirs = (await this.objects.tree(oid)).filter((e) => e.mode === TREE_MODE);
    const found = await Promise.all(
      dirs.map((e) => (depth < 2 ? this.sharded(e.oid, depth + 1, memo, leaf) : leaf(e.name, e.oid))),
    );
    const items = found.flat();
    memo.set(memoKey, items);
    return items;
  }

  /** The attempts in one issue's `attempts/<a>/<b>/<issue>/` directory. */
  private async attemptsOf(issue: string, oid: string): Promise<readonly LoadedAttempt[]> {
    const memoKey = `${issue}:${oid}`;
    const cached = this.attemptsByTree.get(memoKey);
    if (cached) return cached;
    const dirs = (await this.objects.tree(oid)).filter((e) => e.mode === TREE_MODE && ATTEMPT_PATTERN.test(e.name));
    const loaded = await Promise.all(dirs.map((e) => this.attemptAt(issue, e.name, e.oid)));
    const attempts = loaded.filter((a): a is LoadedAttempt => a !== null);
    this.attemptsByTree.set(memoKey, attempts);
    return attempts;
  }

  private async attemptAt(issue: string, id: string, oid: string): Promise<LoadedAttempt | null> {
    const entries = await this.objects.tree(oid);
    const file = (name: string) => entries.find((e) => e.name === name && e.mode !== TREE_MODE);
    const startFile = file('start.md');
    if (!startFile) return null;
    const endFile = file('end.md');
    const [start, end] = await Promise.all([
      this.objects.blob(startFile.oid).then(parseStart),
      endFile ? this.objects.blob(endFile.oid).then(parseEnd) : null,
    ]);
    const dir = entries.find((e) => e.name === ACTIVITY_DIR && e.mode === TREE_MODE);
    const activity: ActivityEntry[] = [];
    for (const entry of dir ? await this.objects.tree(dir.oid) : []) {
      const parsed = entry.mode !== TREE_MODE && entry.name.endsWith('.md') ? commentEntry(entry.name.slice(0, -3)) : null;
      // An open attempt's entries are read, for its activity facts; a sealed one's only when a trace is viewed.
      if (parsed) activity.push({ ...parsed, detail: end ? null : parseActivity(await this.objects.blob(entry.oid)) });
    }
    activity.sort(byCommentOrder);
    const conflicts = entries.find((e) => e.name === CONFLICTS_DIR && e.mode === TREE_MODE);
    const setAside = conflicts
      ? await Promise.all(
          (await this.objects.tree(conflicts.oid))
            .filter((e) => e.mode !== TREE_MODE && e.name.endsWith('.md'))
            .map(async (e) => parseEnd(await this.objects.blob(e.oid))),
        )
      : [];
    setAside.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));
    const sessionsDir = entries.find((e) => e.name === SESSIONS_DIR && e.mode === TREE_MODE);
    const sessions = new Map<string, string>();
    for (const entry of sessionsDir ? await this.objects.tree(sessionsDir.oid) : []) {
      const key = entry.name.replace(/\.md$/, '');
      if (entry.mode !== TREE_MODE && entry.name.endsWith('.md') && SESSION_KEY_PATTERN.test(key)) sessions.set(key, entry.oid);
    }
    return { id, issue, start, end, activity, setAside, sessions };
  }

  /** The outcome records in one issue's `outcomes/<a>/<b>/<issue>/` directory. */
  private async outcomesOf(issue: string, oid: string): Promise<readonly LoadedOutcome[]> {
    const memoKey = `${issue}:${oid}`;
    const cached = this.outcomesByTree.get(memoKey);
    if (cached) return cached;
    const files = (await this.objects.tree(oid)).filter(
      (e) => e.mode !== TREE_MODE && e.name.endsWith('.md') && ATTEMPT_PATTERN.test(e.name.slice(0, -3)),
    );
    const outcomes = await Promise.all(
      files.map(async (e) => ({ issue, attempt: e.name.slice(0, -3), outcome: parseOutcome(await this.objects.blob(e.oid)) })),
    );
    this.outcomesByTree.set(memoKey, outcomes);
    return outcomes;
  }

  /** A `conflicts/` directory's records, oldest first (then by name). */
  private async conflictsIn(tree: string): Promise<ConflictRecord[]> {
    const files = (await this.objects.tree(tree)).filter((e) => e.mode !== TREE_MODE && e.name.endsWith('.md'));
    const parsed = await Promise.all(
      files.map(async (e) => ({ name: e.name, record: parseConflict(await this.objects.blob(e.oid)) })),
    );
    return parsed
      .sort((x, y) => (x.record.at < y.record.at ? -1 : x.record.at > y.record.at ? 1 : x.name < y.name ? -1 : 1))
      .map((p) => p.record);
  }

  /** A `comments/` directory's files, in comment order; names only, no blobs read. */
  private async commentsIn(tree: string): Promise<StoredComment[]> {
    const comments: StoredComment[] = [];
    for (const entry of await this.objects.tree(tree)) {
      const parsed =
        entry.mode !== TREE_MODE && entry.name.endsWith('.md') ? commentEntry(entry.name.slice(0, -3)) : null;
      if (parsed) comments.push({ ...parsed, oid: entry.oid });
    }
    return comments.sort(byCommentOrder);
  }

  private async namesUnder(oid: string, depth: number): Promise<readonly string[]> {
    const memoKey = `${depth}:${oid}`;
    const cached = this.namesByTree.get(memoKey);
    if (cached) return cached;
    const dirs = (await this.objects.tree(oid)).filter((e) => e.mode === TREE_MODE);
    const names =
      depth < 2
        ? (await Promise.all(dirs.map((e) => this.namesUnder(e.oid, depth + 1)))).flat()
        : dirs.map((e) => e.name);
    this.namesByTree.set(memoKey, names);
    return names;
  }

  private async record(blob: string): Promise<IssueRecord> {
    let record = this.records.get(blob);
    if (!record) {
      record = parseIssue(await this.objects.blob(blob));
      this.records.set(blob, record);
    }
    return record;
  }
}
