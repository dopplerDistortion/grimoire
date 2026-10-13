// The human gate on skill proposals (spec §18 Review and decisions, Risk
// flags, Mechanical checks at accept, Pending lifecycle, The skill ledger;
// §15 reaching others; §20 the proposal screen; ADR 0005): a person lists and
// shows proposals (human-read) and decides them (human-only): accept, reject,
// dismiss, reconsider and purge. No decision is ever offered to agents.
//
// Every decision is a skill ledger record naming the proposal, with its
// actor, the basis `human review`, the surface and the versions the person
// saw. An accept is one tracker commit holding the record and the version
// text; an accept whose accept-time checks fail writes a `lapse` instead,
// which frees the pending slot. Statuses are derived on read
// (src/knowledge/proposals.ts); nothing aggregated is committed.
import { GrimoireError, invalid } from '../errors';
import {
  decisionHistory,
  liveEvidence,
  redFlags,
  type DecisionHistory,
  type LiveEvidence,
  type LivePage,
  type LiveTrace,
  type RedFlag,
} from '../knowledge/gate';
import { parseSkillText, proposalStates, readSkills, targetedPatterns, writeSkillChange, type LedgerEntry, type ProposalState, type ProposalStatus, type SkillBook } from '../knowledge';
import { activeQuarantine, checkProposal, Serving, type ActiveQuarantine, type OpenRun } from '../knowledge/chores';
import { itemHash, type ServedLog } from '../knowledge/chores/runs';
import { shownDiff } from '../knowledge/line-diff';
import { deriveScorecards, type Scorecard } from '../knowledge/scorecards';
import { cloneTag, MachineLocalStore } from '../machine-local';
import type { SecretScanner } from '../scanner';
import type { ProposalRecord, RiskFlag, TokenOrigin, TrackerDraft, TrackerView } from '../tracker';
import { traceCapture } from './capture';
import { recordedActor } from './attempts';
import { define, oneLine, writer, type OpEnv } from './op';
import { handwrittenTexts, stubCollides } from './proposal-sources';
import { s } from './schema';
import { storeSetting } from './settings';
import { patternOf, scanned, traceFacts } from './skills';

/** Every decision in v1 is a person's (spec §18). */
const BASIS = 'human review';

/** The reject reason codes (spec §18 Review and decisions). */
export const REJECT_REASONS = [
  'incorrect',
  'too-vague',
  'one-off',
  'duplicates-existing-guidance',
  'contradicts-instructions',
  'trigger-too-broad',
  'too-long',
  'suspicious',
  'not-worth-it',
  'other',
] as const;

const idInput = s.string({ ...oneLine, description: 'the proposal’s id (pp-…)' });

/** The proposal `id` in `view`, or NOT_FOUND (saying so when a tombstone purged it). */
async function proposalIn(view: TrackerView, id: string): Promise<ProposalRecord> {
  const wanted = id.trim().toLowerCase();
  const record = (await view.proposals.records()).find((proposal) => proposal.id === wanted);
  if (record) return record;
  const purged = view.proposalPurge(wanted);
  if (purged) throw new GrimoireError('NOT_FOUND', `the skill proposal ${wanted} was purged`, { field: 'id', ref: wanted, purged: { by: purged.by, at: purged.at } });
  throw new GrimoireError('NOT_FOUND', `there is no skill proposal ${wanted}`, { field: 'id', ref: wanted });
}

/**
 * The versions a decision's person was shown: the proposal's base and the
 * version current then, and last the proposal's own version. It is always
 * last, so a reject still names the change it refused after the proposal is
 * purged (`saw` keeps its order; the repeat check reads it).
 */
function decisionSaw(proposal: ProposalRecord, current: string | null): string[] {
  const shown = [proposal.base, current].filter((v): v is string => v !== null && v !== proposal.version);
  return [...new Set(shown), proposal.version];
}

function stateOf(book: SkillBook, proposals: readonly ProposalRecord[], id: string): ProposalState {
  return proposalStates(proposals, book.skills).find((state) => state.record.id === id)!;
}

/** The live evidence and red flags of `proposal` in `view`. */
export async function flagsOf(view: TrackerView, proposal: ProposalRecord, quarantine?: ActiveQuarantine): Promise<{ evidence: LiveEvidence; flags: RedFlag[] }> {
  const active = quarantine ?? (await activeQuarantine(view));
  const pages = new Set((await view.wiki.pages()).map((page) => page.slug));
  const evidence = liveEvidence(view, proposal, active, pages);
  return { evidence, flags: redFlags(proposal, evidence) };
}

/** The checkout facts the accept-time checks read: the hand-written texts, and the client skill folders. */
interface CheckoutFacts {
  readonly handwritten: readonly string[];
  readonly collides: (name: string) => Promise<boolean>;
}

function checkoutFacts(root: string, handwritten: readonly string[]): CheckoutFacts {
  const known = new Map<string, Promise<boolean>>();
  return {
    handwritten,
    collides: (name) => {
      let found = known.get(name);
      if (!found) known.set(name, (found = stubCollides(root, name)));
      return found;
    },
  };
}

/** What the accept-time checks found: the reason codes of everything but the evidence minimum, which is the live red flag. */
export interface AcceptChecks {
  passed: boolean;
  reasons: string[];
  problems: Record<string, string>;
}

/**
 * Runs the proposal's mechanical checks again with the current rules, as at
 * accept (spec §18): the proposal as submitted, against `view` and the
 * checkout. BASE_MOVED when the skill moved off its base (the proposal is
 * stale).
 */
async function acceptChecks(view: TrackerView, scanner: SecretScanner, book: SkillBook, proposal: ProposalRecord, checkout: CheckoutFacts): Promise<AcceptChecks> {
  const quarantine = await activeQuarantine(view);
  const result: Record<string, unknown> =
    proposal.action === 'create'
      ? { action: 'create', target: proposal.skill, text: proposal.text }
      : { action: 'patch', target: proposal.skill, base_version: proposal.base, ops: proposal.ops };
  Object.assign(result, { citations: [...proposal.citations], claims: proposal.claims, client: proposal.unverified.client, model: proposal.unverified.model });
  const served = new Map(proposal.served.map((entry) => [entry.item, entry.hash]));
  // A patch was served the skill it patches (its base is the version that run read).
  if (proposal.action === 'patch' && !served.has(`skill:${proposal.skill}`)) served.set(`skill:${proposal.skill}`, proposal.base ?? '');
  const log = { run: proposal.run, items: [...served].map(([item, hash]) => ({ item, hash, at: proposal.at })) } as ServedLog;
  const check = await checkProposal(result, {
    view,
    run: { id: proposal.run } as OpenRun,
    served: log,
    scanner,
    book,
    maxActive: storeSetting(view, 'skills.max_active') as number,
    descriptionMax: storeSetting(view, 'skills.description_max') as number,
    handwritten: checkout.handwritten,
    collides: checkout.collides,
    servableTrace: async (trace) => view.attempt(trace)?.end != null && !quarantine.traces.has(trace),
    servablePage: (slug) => !quarantine.pages.has(slug),
    drafted: { traces: proposal.traces },
  });
  if (check.ok) return { passed: true, reasons: [], problems: {} };
  const reasons = check.rejection.reasons.filter((reason) => reason !== 'too_little_evidence');
  const problems = Object.fromEntries(Object.entries(check.rejection.problems).filter(([field]) => field !== 'citations' || reasons.includes('unserved')));
  return reasons.length === 0 ? { passed: true, reasons: [], problems: {} } : { passed: false, reasons, problems };
}

/** Hours from `from` to `to`, two decimals. */
function hoursBetween(from: string, to: Date): number | null {
  const at = Date.parse(from);
  return Number.isFinite(at) ? Math.round(((to.getTime() - at) / 3_600_000) * 100) / 100 : null;
}

/** One proposal as `proposal_list` lists it. */
export interface ListedProposal {
  id: string;
  skill: string;
  action: string;
  status: ProposalStatus;
  at: string;
  /** How long it has waited (pending ones) or waited before its decision, in hours: there is no time-based expiry. */
  age_hours: number | null;
  /** When it went stale or lapsed; null otherwise. */
  since: string | null;
  decided_at: string | null;
}

export interface ProposalListResult {
  proposals: ListedProposal[];
  /** The proposals holding the pending slot, oldest first. */
  pending: string[];
  /** proposals.pending_limit: how many may wait at once. */
  pending_limit: number;
  /** Pending proposals of one skill with the same text: duplicates a merge left, grouped (accepting one stales the rest). */
  duplicates: string[][];
  history: DecisionHistory;
}

export const proposalList = define({
  name: 'proposal_list',
  description: 'List the skill proposals with their derived statuses, the pending slot, and the decision history (accept rate, median time to decision). Human-read.',
  kind: 'read',
  policy: 'human-read',
  replay: 'none',
  input: s.object({
    status: s.optional(s.literal(['pending', 'stale', 'lapsed', 'accepted', 'rejected', 'dismissed', 'undone', 'contested', 'superseded'], 'list only proposals with this status')),
  }),
  async run(input, { tracker, scanner }): Promise<ProposalListResult> {
    const view = await tracker.read();
    const book = await readSkills(view, scanner);
    const states = proposalStates(await view.proposals.records(), book.skills);
    const now = tracker.now();
    const pending = states.filter((state) => state.status === 'pending');
    const groups = new Map<string, string[]>();
    for (const state of pending) {
      const key = `${state.record.skill}\n${state.record.version}`;
      groups.set(key, [...(groups.get(key) ?? []), state.record.id]);
    }
    return {
      proposals: states
        .filter((state) => input.status === undefined || state.status === input.status)
        .map((state) => ({
          id: state.record.id,
          skill: state.record.skill,
          action: state.record.action,
          status: state.status,
          at: state.record.at,
          age_hours: state.decision ? hoursBetween(state.record.at, new Date(state.decision.at)) : hoursBetween(state.record.at, now),
          since: state.staleSince,
          decided_at: state.decision?.at ?? null,
        })),
      pending: pending.map((state) => state.record.id),
      pending_limit: storeSetting(view, 'proposals.pending_limit') as number,
      duplicates: [...groups.values()].filter((ids) => ids.length > 1),
      history: decisionHistory(states),
    };
  },
});

/** A cited trace as `proposal_show` shows it: as at drafting and now, and the versions of the skill it read. */
export interface ShownTrace extends LiveTrace {
  /** The versions of the proposal's skill this trace's contexts read (null: a read whose version is unknown). */
  versions_read: (string | null)[];
}

export interface ShownPage extends LivePage {
  /** The page (or set-aside side) as served now differs from what the run was served; null when it can't be told (gone). */
  changed_since: boolean | null;
}

export interface ShownLedgerRecord {
  record: string;
  kind: string;
  from: string | null;
  to: string | null;
  by: string;
  at: string;
  proposal?: string;
  reason?: string;
}

export interface ProposalShowResult {
  id: string;
  skill: string;
  action: string;
  status: ProposalStatus;
  at: string;
  age_hours: number | null;
  base: string | null;
  version: string;
  /** When it went stale or lapsed. */
  since: string | null;
  /** 1. Grimoire's checks run again as at accept (pending proposals only; null otherwise), then the flags. */
  checks: AcceptChecks | null;
  /** The flags a person must each acknowledge before accepting. */
  red_flags: RedFlag[];
  /** Every risk flag recorded at drafting (red and amber), and where each added token was found. */
  risk_flags: RiskFlag[];
  tokens: TokenOrigin[];
  /** 2. The description diff, then the body diff, against the base (a create: against nothing). */
  description_diff: string[];
  body_diff: string[];
  /** 3. The cited traces, with the evidence minimum as it stands now. */
  evidence: { meets: boolean; pages: number; traces: number; issues: number; fails: number };
  traces: ShownTrace[];
  /** 4. The cited pages. */
  pages: ShownPage[];
  /** 5. The base version's scorecard (patches only). */
  scorecard: Scorecard | null;
  /** 6. The skill ledger's history for the skill or name. */
  ledger: ShownLedgerRecord[];
  /** The decision that decided it, if any. */
  decision: (ShownLedgerRecord & { acks?: string[]; note?: string; actor: Record<string, unknown> }) | null;
  /** 7. The full result: the proposed SKILL.md and, for a patch, its ops. */
  result: { text: string; ops: ProposalRecord['ops'] };
  /** 8. Last: the LLM's own words, unverified. */
  claims: ProposalRecord['claims'] & { unverified: true; client: string | null; model: string | null };
}

function shownRecord(record: LedgerEntry): ShownLedgerRecord {
  return {
    record: record.id,
    kind: record.kind,
    from: record.from,
    to: record.to,
    by: record.by,
    at: record.at,
    ...(record.proposal !== undefined ? { proposal: record.proposal } : {}),
    ...(record.reason !== undefined ? { reason: record.reason } : {}),
  };
}

function partsOf(text: string): { description: string; body: string } {
  try {
    const parts = parseSkillText(text);
    return { description: parts.description, body: parts.body };
  } catch {
    return { description: '', body: text };
  }
}

/** Whether each cited page (or side) as served now differs from the hash its run was served. */
async function pagesChanged(view: TrackerView, root: string, scanner: SecretScanner, proposal: ProposalRecord): Promise<Map<string, boolean | null>> {
  const serving = new Serving({
    view,
    run: { id: proposal.run, kind: 'skill-proposer', batch: [], compiles: [], conflicted: [], manifest: [] } as unknown as OpenRun,
    root,
    scanner,
    pairs: new Map(),
  });
  const changed = new Map<string, boolean | null>();
  for (const slug of proposal.pages) {
    const items = proposal.served.filter((entry) => entry.item === `page:${slug}` || entry.item.startsWith(`side:${slug}/`));
    if (items.length === 0) {
      changed.set(slug, null);
      continue;
    }
    let differs: boolean | null = false;
    for (const entry of items) {
      const now = await serving.item(entry.item);
      if (now === null) differs = null;
      else if (differs !== null && itemHash(now) !== entry.hash) differs = true;
    }
    changed.set(slug, differs);
  }
  return changed;
}

export const proposalShow = define({
  name: 'proposal_show',
  description:
    "Show one skill proposal for review: grimoire's checks and risk flags first (the red flags an accept must acknowledge, the evidence re-checked now), the description and body diffs, the cited traces and pages, the scorecard, the skill's ledger history, the full result, and last the proposer's claims, unverified. Human-read.",
  kind: 'read',
  policy: 'human-read',
  replay: 'none',
  input: s.object({ id: idInput }),
  async run(input, { ctx, tracker, scanner }): Promise<ProposalShowResult> {
    const view = await tracker.read();
    const proposal = await proposalIn(view, input.id);
    const book = await readSkills(view, scanner);
    const state = stateOf(book, await view.proposals.records(), proposal.id);
    const skill = book.skills.get(proposal.skill);
    const { evidence, flags } = await flagsOf(view, proposal);
    const checks =
      state.status === 'pending'
        ? await acceptChecks(view, scanner, book, proposal, checkoutFacts(ctx.repo.root, await handwrittenTexts(ctx.repo.root))).catch((error: unknown) => {
            if (error instanceof GrimoireError && error.code === 'BASE_MOVED') return { passed: false, reasons: ['base_moved'], problems: { base_version: error.message } };
            throw error;
          })
        : null;
    const baseText = proposal.base === null ? '' : ((await book.text(proposal.base)) ?? '');
    const before = partsOf(baseText);
    const after = partsOf(proposal.text);
    const traces: ShownTrace[] = [];
    for (const row of evidence.traceRows) {
      const capture = row.purged ? null : await traceCapture(view, row.trace);
      const versions = (capture?.contexts ?? []).flatMap((context) =>
        context.skills_read.flatMap((read) => {
          const { name, version } = (read ?? {}) as { name?: unknown; version?: unknown };
          return name === proposal.skill ? [typeof version === 'string' ? version : null] : [];
        }),
      );
      traces.push({ ...row, versions_read: [...new Set(versions)] });
    }
    const changed = await pagesChanged(view, ctx.repo.root, scanner, proposal);
    let scorecard: Scorecard | null = null;
    if (proposal.action === 'patch' && skill && proposal.base !== null) {
      const cards = deriveScorecards(proposal.skill, skill.records, await traceFacts(view), { patternOf: patternOf(await targetedPatterns(view, skill.records)) });
      scorecard = cards.find((card) => card.version === proposal.base) ?? null;
    }
    const decision = state.decision;
    return {
      id: proposal.id,
      skill: proposal.skill,
      action: proposal.action,
      status: state.status,
      at: proposal.at,
      age_hours: decision ? hoursBetween(proposal.at, new Date(decision.at)) : hoursBetween(proposal.at, tracker.now()),
      base: proposal.base,
      version: proposal.version,
      since: state.staleSince,
      checks,
      red_flags: flags,
      risk_flags: [...proposal.flags],
      tokens: [...proposal.tokens],
      description_diff: shownDiff(proposal.base === null ? '' : `${before.description}\n`, `${after.description}\n`),
      body_diff: shownDiff(proposal.base === null ? '' : before.body, after.body),
      evidence: { meets: evidence.meets, pages: evidence.pages, traces: evidence.traces, issues: evidence.issues, fails: evidence.fails },
      traces,
      pages: evidence.pageRows.map((row) => ({ ...row, changed_since: row.gone ? null : (changed.get(row.slug) ?? null) })),
      scorecard,
      ledger: (skill?.records ?? []).map(shownRecord),
      decision: decision
        ? {
            ...shownRecord(decision),
            ...(decision.acks !== undefined ? { acks: [...decision.acks] } : {}),
            ...(decision.note !== undefined ? { note: decision.note } : {}),
            actor: { ...decision.actor },
          }
        : null,
      result: { text: proposal.text, ops: proposal.ops },
      claims: { unverified: true, ...proposal.claims, client: proposal.unverified.client, model: proposal.unverified.model },
    };
  },
});

/** Who a decision is made by, as its ledger record carries it. */
async function authorOf(env: OpEnv): Promise<{ email: string; name: string; clone: string }> {
  const author = writer(env.ctx);
  // Provenance only: machine-local data this release can't write leaves the record's clone unknown.
  const clone = await cloneTag(new MachineLocalStore(env.tracker.location.commonDir).records).catch(() => '');
  return { ...author, clone };
}

function changeAuthor(env: OpEnv, author: { email: string; clone: string }) {
  return { actor: env.actor, by: author.email, surface: env.ctx.surface, clone: author.clone, basis: BASIS };
}

/** INVALID unless the proposal's status is one of `allowed` (BASE_MOVED for a stale proposal where only pending ones may go). */
function requireStatus(state: ProposalState, allowed: readonly ProposalStatus[], verb: string): void {
  if (allowed.includes(state.status)) return;
  if (state.status === 'stale' && allowed.includes('pending')) {
    throw new GrimoireError(
      'BASE_MOVED',
      `the skill proposal ${state.record.id} is stale: ${state.record.skill} moved off its base since it was drafted, so it can't be ${verb}`,
      { id: state.record.id, skill: state.record.skill, since: state.staleSince },
    );
  }
  throw invalid({ id: `the skill proposal ${state.record.id} is ${state.status}; only a ${allowed.join(' or ')} proposal can be ${verb}` });
}

export interface ProposalAcceptResult {
  id: string;
  skill: string;
  /** `accepted`, or `lapsed` when the checks at accept failed: nothing was accepted, and the slot is free. */
  status: 'accepted' | 'lapsed';
  /** Accepted: the version now current, and the one before it. */
  version?: string;
  from?: string | null;
  /** The red flags acknowledged, as the ledger records them. */
  acks?: string[];
  /** Lapsed: the checks' reason codes, and what failed where. */
  reasons?: string[];
  problems?: Record<string, string>;
  /** Accept-then-edit: the command that edits the accepted version. */
  edit?: string;
  /** The ledger record written. */
  record: string;
}

export const proposalAccept = define({
  name: 'proposal_accept',
  description:
    'Accept a pending skill proposal: the checks run again first (a failure makes it lapsed, freeing the slot), every red flag must be acknowledged in `ack` (one item per flag; `--ack <flag>` repeats at the CLI), then one commit records the decision and the version text and the copies and stubs refresh. With then_edit, also names the `skill edit` command. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({
    id: idInput,
    ack: s.optional(s.array(s.string(oneLine), 'the red flags acknowledged, by flag (proposal show lists them); each red flag needs its own')),
    then_edit: s.optional(s.boolean('true: accept, then edit the accepted version with `grimoire skill edit <name>`')),
  }),
  async run(input, env): Promise<ProposalAcceptResult> {
    const { tracker, scanner, ctx, requestSync, servedChanged } = env;
    const author = await authorOf(env);
    const checkout = checkoutFacts(ctx.repo.root, await handwrittenTexts(ctx.repo.root));
    const acks = new Set((input.ack ?? []).map((flag) => flag.trim()));
    const write = await tracker.transact<ProposalAcceptResult>({ op: 'accept', author: { name: author.name, email: author.email }, actor: env.actor }, async (draft) => {
      const proposal = await proposalIn(draft, input.id);
      const book = await readSkills(draft, scanner);
      const state = stateOf(book, await draft.proposals.records(), proposal.id);
      requireStatus(state, ['pending'], 'accepted');
      const current = book.skills.get(proposal.skill)?.version ?? null;
      const checks = await acceptChecks(draft, scanner, book, proposal, checkout);
      if (!checks.passed) {
        const lapse = await writeSkillChange(
          draft,
          scanner,
          { kind: 'lapse', skill: proposal.skill, proposal: proposal.id, reason: checks.reasons.join(','), to: current, saw: decisionSaw(proposal, current) },
          changeAuthor(env, author),
        );
        return { result: { id: proposal.id, skill: proposal.skill, status: 'lapsed', reasons: checks.reasons, problems: checks.problems, record: lapse.record } };
      }
      const { flags } = await flagsOf(draft, proposal);
      const missing = flags.filter((flag) => !acks.has(flag.flag));
      if (missing.length > 0) {
        throw new GrimoireError(
          'INVALID',
          `accepting ${proposal.id} needs each red flag acknowledged first: ${missing.map((flag) => flag.flag).join(', ')}`,
          { fields: { ack: `acknowledge each red flag (proposal show lists them): ${missing.map((flag) => `${flag.flag} (${flag.detail})`).join('; ')}` }, red_flags: missing },
        );
      }
      const acknowledged = flags.map((flag) => flag.flag).filter((flag) => acks.has(flag));
      const written = await writeSkillChange(
        draft,
        scanner,
        {
          kind: 'accept',
          skill: proposal.skill,
          text: proposal.text,
          proposal: proposal.id,
          acks: acknowledged,
          saw: decisionSaw(proposal, current),
        },
        changeAuthor(env, author),
      );
      return {
        result: {
          id: proposal.id,
          skill: proposal.skill,
          status: 'accepted',
          version: written.version!,
          from: written.from,
          acks: [...acknowledged].sort(),
          ...(input.then_edit === true ? { edit: `grimoire skill edit ${proposal.skill}` } : {}),
          record: written.record,
        },
      };
    });
    // A knowledge decision triggers the automatic sync (spec §4); an accept changes what agents get here at once (§15).
    if (write.commit) {
      requestSync(write.commit);
      if (write.result.status === 'accepted') servedChanged();
    }
    return write.result;
  },
});

export interface ProposalRejectResult {
  id: string;
  skill: string;
  status: 'rejected';
  reason: string;
  /** A `suspicious` reject's quarantine of the cited traces and pages: what it marked now. */
  quarantined: { traces: string[]; pages: string[] };
  record: string;
}

/** Quarantines the proposal's cited traces and pages not already quarantined (a `suspicious` reject's offer). */
async function quarantineCited(draft: TrackerDraft, proposal: ProposalRecord, env: OpEnv, email: string): Promise<{ traces: string[]; pages: string[] }> {
  const active = await activeQuarantine(draft);
  const marked = { traces: [] as string[], pages: [] as string[] };
  const reason = `cited by the skill proposal ${proposal.id}, rejected as suspicious`;
  const common = { clears: [], reason, basis: BASIS, surface: env.ctx.surface, actor: recordedActor(email, env.actor), by: email };
  for (const trace of [...new Set(proposal.traces.map((t) => t.trace))].sort()) {
    const attempt = draft.attempt(trace);
    if (!attempt?.end || active.traces.has(trace)) continue;
    draft.quarantine.add({ kind: 'quarantine-mark', target: { trace }, from: null, to: null, saw: [], ...common });
    marked.traces.push(trace);
  }
  for (const slug of [...proposal.pages].sort()) {
    const page = await draft.wiki.page(slug);
    if (!page || active.pages.has(slug)) continue;
    draft.quarantine.add({ kind: 'quarantine-mark', target: { page: slug }, from: page.version, to: page.version, saw: [page.version], ...common });
    marked.pages.push(slug);
  }
  return marked;
}

export const proposalReject = define({
  name: 'proposal_reject',
  description:
    'Reject a skill proposal with a reason code (other takes `text`); a rejected change is never proposed again. With suspicious, the cited traces and pages are quarantined too unless quarantine is false. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({
    id: idInput,
    reason: s.literal(REJECT_REASONS, 'why it is rejected'),
    text: s.optional(s.string({ description: 'with reason other: the reason, in your words (required then)' })),
    quarantine: s.optional(s.boolean('with suspicious: quarantine the cited traces and pages (default true)')),
  }),
  async run(input, env): Promise<ProposalRejectResult> {
    const { tracker, scanner, requestSync } = env;
    const note = input.text?.trim() ?? '';
    if (input.reason === 'other' && note === '') throw invalid({ text: 'is required with the reason other: say why it is rejected' });
    if (input.reason !== 'other' && input.text !== undefined) throw invalid({ text: 'goes only with the reason other' });
    if (input.reason !== 'suspicious' && input.quarantine !== undefined) throw invalid({ quarantine: 'goes only with the reason suspicious' });
    if (note !== '') scanned(scanner, note);
    const author = await authorOf(env);
    const write = await tracker.transact<ProposalRejectResult>({ op: 'reject', author: { name: author.name, email: author.email }, actor: env.actor }, async (draft) => {
      const proposal = await proposalIn(draft, input.id);
      const book = await readSkills(draft, scanner);
      const state = stateOf(book, await draft.proposals.records(), proposal.id);
      requireStatus(state, ['pending', 'stale', 'lapsed', 'dismissed'], 'rejected');
      const current = book.skills.get(proposal.skill)?.version ?? null;
      const quarantined = input.reason === 'suspicious' && input.quarantine !== false ? await quarantineCited(draft, proposal, env, author.email) : { traces: [], pages: [] };
      const written = await writeSkillChange(
        draft,
        scanner,
        {
          kind: 'reject',
          skill: proposal.skill,
          proposal: proposal.id,
          reason: input.reason,
          ...(note !== '' ? { note } : {}),
          to: current,
          saw: decisionSaw(proposal, current),
        },
        changeAuthor(env, author),
      );
      return { result: { id: proposal.id, skill: proposal.skill, status: 'rejected', reason: input.reason, quarantined, record: written.record } };
    });
    if (write.commit) requestSync(write.commit);
    return write.result;
  },
});

export interface ProposalDecisionResult {
  id: string;
  skill: string;
  status: ProposalStatus;
  record: string;
}

/** Dismiss and reconsider: a record naming the proposal, changing no skill. */
async function simpleDecision(
  env: OpEnv,
  id: string,
  kind: 'dismiss' | 'reconsider',
  allowed: readonly ProposalStatus[],
  verb: string,
  guard?: (draft: TrackerDraft, book: SkillBook, proposals: readonly ProposalRecord[]) => Promise<void>,
): Promise<ProposalDecisionResult> {
  const { tracker, scanner, requestSync } = env;
  const author = await authorOf(env);
  const write = await tracker.transact<ProposalDecisionResult>({ op: kind, author: { name: author.name, email: author.email }, actor: env.actor }, async (draft) => {
    const proposal = await proposalIn(draft, id);
    const book = await readSkills(draft, scanner);
    const proposals = await draft.proposals.records();
    requireStatus(stateOf(book, proposals, proposal.id), allowed, verb);
    await guard?.(draft, book, proposals);
    const current = book.skills.get(proposal.skill)?.version ?? null;
    const written = await writeSkillChange(
      draft,
      scanner,
      { kind, skill: proposal.skill, proposal: proposal.id, to: current, saw: decisionSaw(proposal, current) },
      changeAuthor(env, author),
    );
    const after = stateOf(await readSkills(draft, scanner), await draft.proposals.records(), proposal.id);
    return { result: { id: proposal.id, skill: proposal.skill, status: after.status, record: written.record } };
  });
  if (write.commit) requestSync(write.commit);
  return write.result;
}

export const proposalDismiss = define({
  name: 'proposal_dismiss',
  description: 'Dismiss a skill proposal without a verdict: it frees the pending slot, is no negative evidence, and may be reconsidered while the slot is free. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({ id: idInput }),
  run: (input, env) => simpleDecision(env, input.id, 'dismiss', ['pending', 'stale'], 'dismissed'),
});

export const proposalReconsider = define({
  name: 'proposal_reconsider',
  description: 'Reconsider a dismissed skill proposal: it waits for a decision again, but only while the pending slot is free. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({ id: idInput }),
  run: (input, env) =>
    simpleDecision(env, input.id, 'reconsider', ['dismissed'], 'reconsidered', async (draft, book, proposals) => {
      const limit = storeSetting(draft, 'proposals.pending_limit') as number;
      const pending = proposalStates(proposals, book.skills).filter((state) => state.status === 'pending');
      if (pending.length >= limit) {
        throw new GrimoireError('PENDING_LIMIT', `the pending slot is full (${pending.map((state) => state.record.id).join(', ')}); decide that proposal first`, {
          pending: pending.map((state) => state.record.id),
        });
      }
    }),
});

export interface ProposalPurgeResult {
  id: string;
  purged: true;
  /** False when it was purged already: only what was left of it went. */
  changed: boolean;
  by: string;
  at: string;
  reason: string;
  history: { unpushed_rewritten: number; pushed: boolean };
}

export const proposalPurge = define({
  name: 'proposal_purge',
  description:
    'Purge a skill proposal, with a reason: its record goes in one commit, a tombstone {by, at, reason} stays and dominates every fold, and unpushed commits are rewritten without it (pushed history keeps it). Its ledger decisions stay: a rejected change stays refused when proposed again with the exact text, but its text is gone, so a near-identical rewording is no longer caught. Human-only.',
  kind: 'write',
  policy: 'human-only',
  replay: 'none',
  input: s.object({ id: idInput, reason: s.string({ nonBlank: true, description: 'why it is purged (required)' }) }),
  async run(input, { ctx, tracker, actor, requestSync }): Promise<ProposalPurgeResult> {
    const author = writer(ctx);
    const id = input.id.trim().toLowerCase();
    const reason = input.reason.trim();
    const write = await tracker.transact({ op: 'purge', author, actor }, async (draft) => {
      const stored = draft.proposalPurge(id);
      await draft.purgeProposal(id, { by: author.email, reason });
      const tombstone = draft.proposalPurge(id)!;
      return { result: { id, purged: true as const, changed: !stored, by: tombstone.by, at: tombstone.at, reason: tombstone.reason } };
    });
    if (write.commit) requestSync(write.commit);
    const drop = write.history;
    return { ...write.result, history: { unpushed_rewritten: drop?.rewritten ?? 0, pushed: drop?.pushed ?? false } };
  },
});

/** The live proposals that cite the trace `handle` (purge_trace's cited_by). */
export async function citingProposals(view: TrackerView, handle: string): Promise<string[]> {
  const citing = (proposal: ProposalRecord) =>
    proposal.traces.some((trace) => trace.trace === handle) ||
    proposal.citations.some((item) => item === `trace:${handle}` || item === `issue:${handle}` || item === `debrief:${handle}` || item.startsWith(`excerpt:${handle}/`));
  return (await view.proposals.records()).filter(citing).map((proposal) => proposal.id);
}

