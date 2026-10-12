// Attempts (spec §3, The attempt directory): one directory per attempt,
// `attempts/<a>/<b>/<issue-id>/<attempt-id>/`, holding the write-once
// `start.md`, `issue-at-start.md` (the issue's blob at open), `end.md` (written
// once, at the seal) and `activity/`; and a separate, mutable outcome record,
// `outcomes/<a>/<b>/<issue-id>/<attempt-id>.md`. Every record is frontmatter in
// the shared line format, and keys this release doesn't know are kept.
import { randomBytes } from 'node:crypto';
import { ID_ALPHABET } from './ids';
import { formatLine, lineValue, parseLines } from './lines';
import type { CommentEntry } from './comment';

export const ATTEMPT_PREFIX = 'at-';
export const ATTEMPT_LENGTH = 6;
export const ATTEMPT_PATTERN = /^at-[0-9a-hjkmnp-tv-z]{6}$/;

/** How an attempt opened. */
export type AttemptOpening = 'claim' | 'assign' | 'unclaimed-close';
/** How an attempt ended (spec §3: `end.md`). */
export type AttemptEnding = 'done' | 'canceled' | 'release' | 'release-abandoned' | 'reassign' | 'superseded';
export type Verdict = 'pass' | 'fail' | 'none';

/**
 * One evolved skill a checkout offered at an attempt's opening (spec §14
 * Facts, Offered): per stub, the ledger version whose normalized text equals
 * the checkout's copy; else `unknown` with the copy's hash; or `missing`, the
 * stub present but the copy absent. Never the ledger's current pointer.
 */
export type OfferedSkill =
  | { readonly name: string; readonly version: string; readonly hash?: undefined }
  | { readonly name: string; readonly version: 'unknown'; readonly hash: string };

/** The store's evolved-skill delivery switch as it stood at an attempt's opening. */
export type DeliveryState = 'on' | 'off';

/** `start.md`. */
export interface AttemptStart {
  /** The person who holds the attempt (an email): always a person, never an agent. */
  readonly assignee: string;
  /** Who opened it: the person, plus the agent facts when an agent did. */
  readonly actor: Readonly<Record<string, unknown>>;
  readonly opened: string;
  readonly at: string;
  /** The tracker commit the attempt opened on; bindings are read from there onward. */
  readonly start_commit: string;
  /** Whether the opening context had been exposed to the wiki. */
  readonly wiki_exposed: boolean;
  /** The delivery switch at the opening; absent in a `start.md` that doesn't record it. */
  readonly delivery?: DeliveryState;
  /**
   * The evolved skills the opening checkout offered, by name; absent when the
   * opening had no checkout of the attempt's own (a human assign), so nothing
   * is known of what it offered.
   */
  readonly skills_offered?: readonly OfferedSkill[];
  readonly extra: Readonly<Record<string, string>>;
}

/** `end.md`: attempt-level fields only (per-context entries live in the session records). */
export interface AttemptEnd {
  readonly ended: string;
  readonly ended_by: Readonly<Record<string, unknown>>;
  readonly at: string;
  /** The id of the debrief comment, or null. */
  readonly debrief: string | null;
  readonly worker_kind: string;
  /** The OR of every binding write's wiki exposure. */
  readonly wiki_exposed: boolean;
  /** Issue fields changed during the attempt, its own close included. */
  readonly field_changes: readonly string[];
  /**
   * The referenced commits (spec §14 Facts: Commits): commits on any branch
   * whose `Refs:` trailer names the issue, committed inside the attempt, each
   * `{hash, via: "referenced", at, subject, files, added, removed}` (a hash
   * the sealing clone lacked: bare), flagged `agent_skill_edit` or
   * `agent_assisted`. Observed commits live in the session records.
   */
  readonly commits: readonly unknown[];
  /** For a `superseded` seal: the ending the call asked for (replays match on it). */
  readonly requested?: string;
  readonly extra: Readonly<Record<string, string>>;
}

/** The outcome record: mutable, and the latest verdict wins. */
export interface AttemptOutcome {
  readonly verdict: string;
  readonly reason: string;
  /** `grimoire` or `human:<email>`. */
  readonly set_by: string;
  readonly at: string;
  readonly extra: Readonly<Record<string, string>>;
}

/** What one activity entry says; read only while its attempt is open. */
export interface ActivityDetail {
  /** `comment` or `debrief` (a comment's own blob), or `update` (a field change). */
  readonly kind: string;
  readonly actor: Readonly<Record<string, unknown>>;
  /** The handle the write named, when it named one (that write binds). */
  readonly attempt?: string;
  /** For `update`: the fields it changed. */
  readonly fields: readonly string[];
}

export interface ActivityEntry extends CommentEntry {
  /** Null for a sealed attempt's entries: the trace views read those. */
  readonly detail: ActivityDetail | null;
}

/** One attempt as a reader sees it. */
export interface AttemptRecord {
  readonly id: string;
  readonly issue: string;
  readonly start: AttemptStart;
  /** Null while the attempt is open. */
  readonly end: AttemptEnd | null;
  readonly outcome: AttemptOutcome | null;
  /** Writes on the issue during the attempt, oldest first. */
  readonly activity: readonly ActivityEntry[];
  /** Other seals of this attempt a fold set aside (two clones ended it differently): the attempt is in conflict. */
  readonly setAside: readonly AttemptEnd[];
  /** Its session records (`sessions/<session-key>.md`, one per bound context): each session key with its blob. */
  readonly sessions: ReadonlyMap<string, string>;
}

/** A fresh `at-` handle: 6 crypto-random Crockford characters. */
export function randomAttemptHandle(): string {
  return ATTEMPT_PREFIX + [...randomBytes(ATTEMPT_LENGTH)].map((byte) => ID_ALPHABET[byte & 31]).join('');
}

type Values = Map<string, unknown>;

/** The frontmatter of a record file: known keys parsed, the rest kept raw. */
function frontmatter(bytes: Buffer, known: ReadonlySet<string>): { values: Values; extra: Record<string, string> } {
  const text = bytes.toString('utf8');
  const close = text.startsWith('---\n') ? text.indexOf('\n---\n', 3) : -1;
  const end = close >= 0 ? close : text.endsWith('\n---') ? text.length - 4 : -1;
  const values: Values = new Map();
  const extra: Record<string, string> = {};
  if (end >= 0) {
    for (const { key, raw } of parseLines(text.slice(4, end))) {
      if (known.has(key)) values.set(key, lineValue(raw));
      else extra[key] = raw;
    }
  }
  return { values, extra };
}

function serialize(lines: string[], extra: Readonly<Record<string, string>>, known: ReadonlySet<string>): Buffer {
  for (const key of Object.keys(extra).sort()) if (!known.has(key)) lines.push(`${key}: ${extra[key]}`);
  return Buffer.from(`---\n${lines.join('\n')}\n---\n`, 'utf8');
}

const str = (values: Values, key: string, fallback = '') => {
  const value = values.get(key);
  return typeof value === 'string' ? value : fallback;
};
const obj = (values: Values, key: string): Record<string, unknown> => {
  const value = values.get(key);
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
};
const objects = (values: Values, key: string): Record<string, unknown>[] => {
  const value = values.get(key);
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item)) : [];
};
const strings = (values: Values, key: string): string[] => {
  const value = values.get(key);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
};

const START_KEYS = ['assignee', 'actor', 'opened', 'at', 'start_commit', 'wiki_exposed', 'delivery', 'skills_offered'];
const START_KNOWN = new Set(START_KEYS);

export function serializeStart(start: AttemptStart): Buffer {
  const lines = [
    formatLine('assignee', start.assignee),
    formatLine('actor', start.actor),
    formatLine('opened', start.opened),
    formatLine('at', start.at),
    formatLine('start_commit', start.start_commit),
    formatLine('wiki_exposed', start.wiki_exposed),
  ];
  if (start.delivery !== undefined) lines.push(formatLine('delivery', start.delivery));
  if (start.skills_offered !== undefined) lines.push(formatLine('skills_offered', start.skills_offered));
  return serialize(lines, start.extra, START_KNOWN);
}

export function parseStart(bytes: Buffer): AttemptStart {
  const { values, extra } = frontmatter(bytes, START_KNOWN);
  const delivery = values.get('delivery');
  const offered = offeredSkills(values.get('skills_offered'));
  return {
    assignee: str(values, 'assignee'),
    actor: obj(values, 'actor'),
    opened: str(values, 'opened'),
    at: str(values, 'at'),
    start_commit: str(values, 'start_commit'),
    wiki_exposed: values.get('wiki_exposed') === true,
    ...(delivery === 'on' || delivery === 'off' ? { delivery } : {}),
    ...(offered !== undefined ? { skills_offered: offered } : {}),
    extra,
  };
}

/** The offered skills a `start.md` holds: an entry it can't read is skipped. */
function offeredSkills(value: unknown): OfferedSkill[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const offered: OfferedSkill[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object') continue;
    const { name, version, hash } = item as { name?: unknown; version?: unknown; hash?: unknown };
    if (typeof name !== 'string' || typeof version !== 'string') continue;
    if (version !== 'unknown') offered.push({ name, version });
    else if (typeof hash === 'string') offered.push({ name, version, hash });
  }
  return offered;
}

const END_KNOWN = new Set(['ended', 'ended_by', 'at', 'debrief', 'worker_kind', 'wiki_exposed', 'field_changes', 'commits', 'requested']);

export function serializeEnd(end: AttemptEnd): Buffer {
  const lines = [
    formatLine('ended', end.ended),
    formatLine('ended_by', end.ended_by),
    formatLine('at', end.at),
    formatLine('debrief', end.debrief),
    formatLine('worker_kind', end.worker_kind),
    formatLine('wiki_exposed', end.wiki_exposed),
    formatLine('field_changes', end.field_changes),
    formatLine('commits', end.commits),
  ];
  if (end.requested !== undefined) lines.push(formatLine('requested', end.requested));
  return serialize(lines, end.extra, END_KNOWN);
}

export function parseEnd(bytes: Buffer): AttemptEnd {
  const { values, extra } = frontmatter(bytes, END_KNOWN);
  const debrief = values.get('debrief');
  const requested = values.get('requested');
  return {
    ended: str(values, 'ended'),
    ended_by: obj(values, 'ended_by'),
    at: str(values, 'at'),
    debrief: typeof debrief === 'string' ? debrief : null,
    worker_kind: str(values, 'worker_kind', 'human'),
    wiki_exposed: values.get('wiki_exposed') === true,
    field_changes: strings(values, 'field_changes'),
    commits: objects(values, 'commits'),
    ...(typeof requested === 'string' ? { requested } : {}),
    extra,
  };
}

const OUTCOME_KNOWN = new Set(['verdict', 'reason', 'set_by', 'at']);

export function serializeOutcome(outcome: AttemptOutcome): Buffer {
  const lines = [
    formatLine('verdict', outcome.verdict),
    formatLine('reason', outcome.reason),
    formatLine('set_by', outcome.set_by),
    formatLine('at', outcome.at),
  ];
  return serialize(lines, outcome.extra, OUTCOME_KNOWN);
}

export function parseOutcome(bytes: Buffer): AttemptOutcome {
  const { values, extra } = frontmatter(bytes, OUTCOME_KNOWN);
  return {
    verdict: str(values, 'verdict', 'none'),
    reason: str(values, 'reason'),
    set_by: str(values, 'set_by', 'grimoire'),
    at: str(values, 'at'),
    extra,
  };
}

/** An `update` activity entry: the fields one write changed while the attempt was open. */
export function serializeUpdateActivity(entry: {
  actor: Readonly<Record<string, unknown>>;
  at: string;
  attempt?: string;
  fields: readonly string[];
}): Buffer {
  const lines = [formatLine('actor', entry.actor), formatLine('at', entry.at), formatLine('kind', 'update')];
  if (entry.attempt !== undefined) lines.push(formatLine('attempt', entry.attempt));
  lines.push(formatLine('fields', entry.fields));
  return Buffer.from(`---\n${lines.join('\n')}\n---\n`, 'utf8');
}

const ACTIVITY_KNOWN = new Set(['actor', 'at', 'kind', 'attempt', 'fields']);

/** What an activity file says: a comment's own blob, or an `update` entry. */
export function parseActivity(bytes: Buffer): ActivityDetail {
  const { values } = frontmatter(bytes, ACTIVITY_KNOWN);
  const attempt = values.get('attempt');
  return {
    kind: str(values, 'kind', 'comment'),
    actor: obj(values, 'actor'),
    ...(typeof attempt === 'string' ? { attempt } : {}),
    fields: strings(values, 'fields'),
  };
}
