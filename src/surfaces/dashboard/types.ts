// The core's result shapes the Issues screens read (spec §8 `list`, `show`;
// §20 `activity`), as the browser sees them. Kept beside the dashboard, which
// type-checks without Node's types; the core's own definitions are in
// src/core/{list,show,activity}.ts.

export interface Conflict {
  readonly fields: readonly string[];
  readonly theirs: Readonly<Record<string, unknown>>;
  readonly base: Readonly<Record<string, unknown>>;
}

export interface ListedOpenAttempt {
  readonly attempt: string;
  readonly assignee: string;
  readonly since: string;
  readonly last_activity_at: string;
  readonly clients_seen: readonly string[];
  readonly held_by_you: boolean;
  readonly stale: boolean;
}

export interface ListRow {
  readonly id: string;
  readonly seq: number;
  readonly title: string;
  readonly status: string;
  readonly labels: readonly string[];
  readonly assignee: string | null;
  readonly parent: string | null;
  readonly blocked_by: readonly string[];
  readonly open_blocker_count: number;
  readonly open_child_count: number;
  readonly ready: boolean;
  readonly open_attempts: readonly ListedOpenAttempt[];
  readonly conflict: Conflict | null;
  readonly comment_count: number;
  readonly last_comment_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly link: string;
}

export interface ListResult {
  readonly rows: readonly ListRow[];
  readonly total: number;
  readonly cursor: string | null;
  readonly truncated?: true;
}

export interface RelatedIssue {
  readonly id: string;
  readonly title: string | null;
  readonly status: 'open' | 'done' | 'canceled' | 'unknown';
}

export interface ShownComment {
  readonly id: string;
  readonly at: string;
  readonly kind: string;
  readonly actor: Readonly<Record<string, unknown>>;
  readonly attempt?: string;
  readonly body: string;
}

export interface PastAttempt {
  readonly attempt: string;
  readonly assignee: string;
  readonly opened: string;
  readonly since: string;
  readonly ended: string;
  readonly ended_at: string;
  readonly ended_by: string;
  readonly worker_kind: string;
  readonly outcome: { readonly verdict: string; readonly reason: string; readonly set_by: string; readonly at: string } | null;
  readonly debrief: string | null;
  readonly conflict: unknown;
}

export interface IssueLink {
  readonly target: string;
  readonly title: string;
}

export interface ShowResult {
  readonly id: string;
  readonly seq: number;
  readonly title: string;
  readonly status: string;
  readonly labels: readonly string[];
  readonly parent: string | null;
  readonly blocked_by: readonly string[];
  readonly links: readonly IssueLink[];
  readonly created_at: string;
  readonly created_by: string;
  readonly updated_at: string;
  readonly body?: string;
  readonly body_from?: number;
  readonly revision: string;
  readonly link: string;
  readonly local_link: string;
  readonly children: readonly RelatedIssue[];
  readonly blockers: readonly RelatedIssue[];
  readonly assignee: string | null;
  readonly open_attempts: readonly ListedOpenAttempt[];
  readonly past_attempts: readonly PastAttempt[];
  readonly last_assignee: string | null;
  readonly ready: boolean;
  readonly conflict: Conflict | null;
  readonly comment_count: number;
  readonly comments: readonly ShownComment[];
  readonly cursor: string | null;
  readonly truncated?: true;
}

/** An issue as the detail pane holds it: the whole body and every comment. */
export interface IssueDetail extends Omit<ShowResult, 'body' | 'body_from' | 'cursor' | 'truncated'> {
  readonly body: string;
}

export interface ActivityEntry {
  readonly commit: string;
  readonly at: string;
  readonly op: string;
  readonly issue: string | null;
  readonly attempt: string | null;
  readonly person: string;
  readonly actor: Readonly<Record<string, string>>;
  readonly fields?: readonly string[];
}

export interface ActivityResult {
  readonly entries: readonly ActivityEntry[];
  readonly cursor: string | null;
}

// ---------- Attention (src/core/attention.ts) ----------

export interface ShownStrayEdit {
  readonly id: string;
  readonly skill: string;
  readonly worktree: string;
  readonly path: string;
  readonly text: string;
  readonly base: string | null;
  readonly served: string | null;
  readonly current: string | null;
  readonly at: string;
  readonly edited_at: string | null;
  readonly open_attempts: readonly string[];
  readonly notice: string;
}

export type AttentionItem =
  | {
      readonly kind: 'sync_failure';
      readonly class: 'auth' | 'rejected';
      readonly message: string;
      readonly remote: string | null;
      readonly url: string | null;
      readonly client: string;
      readonly surface: string;
      readonly at: string;
      readonly fix: string;
      readonly pending_since: string | null;
    }
  | { readonly kind: 'id_collision'; readonly id: string; readonly sides: readonly { readonly id: string; readonly title: string; readonly status: string }[]; readonly command: string }
  | { readonly kind: 'field_conflict'; readonly issue: string; readonly title: string; readonly fields: readonly string[] }
  | { readonly kind: 'open_attempts'; readonly issue: string; readonly title: string; readonly attempts: readonly ListedOpenAttempt[] }
  | { readonly kind: 'stale_claim'; readonly issue: string; readonly title: string; readonly attempt: ListedOpenAttempt }
  | { readonly kind: 'stray_edit'; readonly stray: ShownStrayEdit }
  | KnowledgeItem;

export interface ForkChoice {
  readonly version: string;
  readonly standing: boolean;
  readonly kind: string | null;
  readonly by: string | null;
  readonly at: string | null;
}

/** The knowledge items of Attention (src/core/attention.ts). */
export type KnowledgeItem =
  | { readonly kind: 'pending_proposal'; readonly proposal: PendingProposalSummary }
  | {
      readonly kind: 'skill_fork';
      readonly skill: string;
      readonly current: string | null;
      readonly fork: boolean;
      readonly contested: readonly string[];
      readonly choices: readonly ForkChoice[];
    }
  | { readonly kind: 'wiki_conflict'; readonly slug: string; readonly title: string; readonly sides: number }
  | ({ readonly kind: 'set_aside' } & SetAsidePair)
  | { readonly kind: 'flagged_page'; readonly slug: string; readonly title: string; readonly flagged_by: readonly string[] };

/** A section of the queue the core couldn't read: its items may be missing. */
export interface UnreadableSection {
  readonly section: 'stray_edits' | 'knowledge';
  readonly code: string;
  readonly message: string;
}

export interface AttentionResult {
  readonly items: readonly AttentionItem[];
  readonly unreadable: readonly UnreadableSection[];
  readonly counts: { readonly ready: number; readonly claimed: number; readonly stale: number; readonly blocked: number; readonly conflicts: number };
}

// ---------- the attempt page (src/core/attempt-show.ts) ----------

export interface ShownOutcome {
  readonly verdict: string;
  readonly reason: string;
  readonly set_by: string;
  readonly at: string;
}

export interface ShownContext {
  readonly key: string;
  readonly client: string;
  readonly client_version: string | null;
  readonly reader_version: number | null;
  readonly session: string | null;
  readonly context: string | null;
  readonly source: string | null;
  readonly window: { readonly start: unknown; readonly end: unknown } | null;
  readonly counts: { readonly steps: number; readonly kept: number; readonly characters: number };
  readonly excerpt: { readonly status: string; readonly notes: readonly string[] };
  readonly facts: string;
  readonly skills_read: readonly unknown[];
  readonly commits: readonly unknown[];
  readonly text: string | null;
  readonly purge: { readonly by: string; readonly at: string; readonly reason: string; readonly facts: string } | null;
}

export interface ExposureHit {
  readonly commit: string;
  readonly at: string;
  readonly op: string;
  readonly basis: string;
  readonly client: string | null;
  readonly session: string | null;
}

export interface AttemptShowResult {
  readonly attempt: string;
  readonly state: 'open' | 'ended' | 'purged';
  readonly purged: { readonly by: string; readonly at: string; readonly reason: string } | null;
  readonly issue: { readonly id: string; readonly title: string | null; readonly status: string } | null;
  readonly start: {
    readonly assignee: string;
    readonly actor: Readonly<Record<string, unknown>>;
    readonly opened: string;
    readonly at: string;
    readonly start_commit: string;
    readonly wiki_exposed: boolean;
    readonly delivery: string | null;
    readonly skills_offered: readonly unknown[] | null;
  } | null;
  readonly end: {
    readonly ended: string;
    readonly ended_by: Readonly<Record<string, unknown>>;
    readonly at: string;
    readonly debrief: string | null;
    readonly worker_kind: string;
    readonly wiki_exposed: boolean;
    readonly field_changes: readonly string[];
    readonly commits: readonly unknown[];
  } | null;
  readonly outcome: ShownOutcome | null;
  readonly outcome_history: readonly ShownOutcome[];
  readonly last_activity_at: string | null;
  readonly stale: boolean;
  readonly set_aside: number;
  readonly capture: {
    readonly contexts: readonly ShownContext[];
    readonly facts_complete: boolean;
    readonly wiki_exposed: { readonly exposed: boolean; readonly at_start: boolean; readonly at_end: boolean | null; readonly hits: readonly ExposureHit[] };
    readonly commits: readonly Readonly<Record<string, unknown>>[];
  };
  readonly knowledge: {
    readonly pages: readonly { readonly slug: string; readonly title: string; readonly kind: string }[];
    readonly proposals: readonly { readonly id: string; readonly skill: string; readonly action: string; readonly at: string; readonly status: string }[];
  };
  readonly quarantine: { readonly by: string; readonly at: string; readonly reason: string } | null;}

// ---------- Settings (src/core/settings.ts, sync.ts, purge.ts) ----------

export interface ShownSetting {
  readonly value: unknown;
  readonly default: boolean;
  readonly at?: string;
  readonly by?: string;
  readonly description?: string;
}

export interface SettingsResult {
  readonly store: Readonly<Record<string, ShownSetting>>;
  readonly machine: Readonly<Record<string, ShownSetting>>;
}

export interface SettingsSetResult {
  readonly key: string;
  readonly scope: 'store' | 'machine';
  readonly value: unknown;
  readonly changed: boolean;
  readonly disclosure?: readonly string[];
  readonly warning?: string;
  readonly stripped?: number;
}

export interface SyncPosition {
  readonly state: 'none' | 'unpublished' | 'in-sync' | 'ahead' | 'behind' | 'diverged';
  readonly local: string | null;
  readonly remote_tip: string | null;
  readonly ahead: number | null;
  readonly behind: number | null;
}

export interface SyncStatus {
  readonly remote: string | null;
  readonly url: string | null;
  readonly auto_sync: boolean | null;
  readonly pending_since: string | null;
  readonly last_attempt_at: string | null;
  readonly last_success_at: string | null;
  readonly last_result: string | null;
  readonly failure: { readonly class: 'auth' | 'network' | 'rejected'; readonly message: string; readonly client: string; readonly surface: string; readonly at: string } | null;
  readonly retry_at: string | null;
  readonly fix: string | null;
  readonly position: SyncPosition | null;
  readonly summary: string;
}

export interface SyncResult {
  readonly state: 'in-sync' | 'pushed' | 'pending';
  readonly reason?: 'no-remote' | 'no-default-branch' | 'failed';
  readonly failure?: { readonly class: string; readonly message: string };
  readonly fold: string | null;
}

export interface PurgedRecord {
  readonly kind: 'trace' | 'session' | 'proposal';
  readonly id: string;
  readonly key?: string;
  readonly facts?: 'kept' | 'purged';
  readonly by: string;
  readonly at: string;
  readonly reason: string;
}

export interface PurgeListResult {
  readonly purged: readonly PurgedRecord[];
  readonly note: string;
}

/** `GET /api/runner`: this machine's runner, status only. */
export interface RunnerInfo {
  readonly enabled: boolean;
  readonly kind?: string;
  readonly binary?: string;
  readonly model?: string | null;
  readonly allow_api_billing?: boolean;
  readonly auth_method?: string | null;
  readonly bills_api?: boolean;
  readonly runs_today: number;
  readonly runs_per_day: number;
  readonly next_run_at?: string | null;
  readonly paused_until?: string | null;
  readonly last?: { readonly at: string; readonly kind: string | null; readonly result: string; readonly reason?: string } | null;
  readonly consecutive_failures?: number;
  /** The `start` runner trigger's last evaluation, or null before its first. */
  readonly trigger?: { readonly at: string; readonly outcome: 'ran' | 'nothing due' | 'refused'; readonly code?: string; readonly message?: string; readonly preflight?: boolean } | null;
  readonly lines: readonly string[];
  readonly warnings: readonly string[];
  readonly commands: { readonly enable: readonly string[]; readonly disable: string };
}

// ---------- Knowledge (src/core/knowledge-overview.ts, chore-runs.ts, proposals.ts, skills.ts, wiki.ts) ----------

export interface PendingProposalSummary {
  readonly id: string;
  readonly skill: string;
  readonly action: string;
  readonly at: string;
  readonly age_hours: number;
  readonly red_flags: number;
  readonly traces: number;
  readonly pages: number;
}

export interface KeptResult {
  readonly n: number;
  readonly at: string;
  readonly reasons: readonly string[];
  readonly rules: readonly string[];
  readonly text_kept: boolean;
  readonly text?: string | null;
  readonly problems?: Readonly<Record<string, string>>;
}

export interface ChoreRunRow {
  readonly id: string;
  readonly kind: string;
  readonly origin: string;
  readonly isolation: string;
  readonly outcome: string;
  readonly reasons: readonly string[];
  readonly pages: readonly string[];
  readonly proposal: string | null;
  readonly consumed: number;
  readonly started_at: string;
  readonly at: string;
  readonly by: string | null;
  readonly unverified: { readonly client: string | null; readonly model: string | null };
  readonly where: 'tracker' | 'this machine';
  readonly kept: readonly KeptResult[];
}

export interface ChoreRunsResult {
  readonly runs: readonly ChoreRunRow[];
  readonly total: number;
}

export interface DecisionHistory {
  readonly decided: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly dismissed: number;
  readonly accept_rate: number | null;
  readonly median_hours_to_decision: number | null;
  readonly baseline: number;
}

export interface DueFacts {
  readonly due: boolean;
  readonly why: string;
}

export interface KnowledgeOverviewResult {
  readonly loop: 'on' | 'paused';
  readonly delivery: 'on' | 'off';
  readonly pickup: string;
  readonly pending: PendingProposalSummary | null;
  readonly pending_count: number;
  readonly pending_limit: number;
  readonly backlog: { readonly pairs: number; readonly fails: number; readonly passes: number };
  readonly last_compile: { readonly run: string; readonly at: string } | null;
  readonly cap: { readonly active: number; readonly max: number; readonly over: boolean };
  readonly due: { readonly paused: boolean; readonly next: string | null; readonly 'wiki-maintainer': DueFacts; readonly 'skill-proposer': DueFacts };
  readonly counts: { readonly stale: number; readonly lapsed: number; readonly contested: number; readonly forks: number; readonly set_aside: number; readonly quarantined: number };
  readonly history: DecisionHistory;
  readonly decisions: readonly { readonly id: string; readonly skill: string; readonly action: string; readonly status: string; readonly decided_at: string; readonly by: string; readonly hours: number | null }[];
  readonly set_aside: readonly SetAsidePair[];
  readonly runs: readonly ChoreRunRow[];
}

export interface SetAsidePair {
  readonly pair: string;
  readonly trace: string;
  readonly issue: string;
  readonly outcome: string;
  readonly strikes: number;
  readonly ended_at?: string;
}

export interface ListedProposal {
  readonly id: string;
  readonly skill: string;
  readonly action: string;
  readonly status: string;
  readonly at: string;
  readonly age_hours: number | null;
  readonly since: string | null;
  readonly decided_at: string | null;
}

export interface ProposalListResult {
  readonly proposals: readonly ListedProposal[];
  readonly pending: readonly string[];
  readonly pending_limit: number;
  readonly duplicates: readonly (readonly string[])[];
  readonly history: DecisionHistory;
}

export interface RedFlag {
  readonly flag: string;
  readonly detail: string;
  readonly live: boolean;
}

export interface ScorecardCounts {
  readonly offered: number;
  readonly read: number;
  readonly read_unknown: number;
  readonly pass: number;
  readonly fail: number;
  readonly none: number;
  readonly reopens: number;
}

export interface Scorecard extends ScorecardCounts {
  readonly version: string;
  readonly previous: string | null;
  readonly n: number;
  readonly small_sample: boolean;
  readonly recurrence: number | null;
  readonly wiki_exposed: ScorecardCounts;
  readonly delivery_off: ScorecardCounts;
  readonly attention: readonly string[];
}

export interface ShownLedgerRecord {
  readonly record: string;
  readonly kind: string;
  readonly from: string | null;
  readonly to: string | null;
  readonly by: string;
  readonly at: string;
  readonly proposal?: string;
  readonly reason?: string;
}

export interface CitedTraceRow {
  readonly trace: string;
  readonly issue: string;
  readonly outcome_at_drafting: string;
  readonly outcome_now: string | null;
  readonly wiki_exposed: boolean;
  readonly purged: boolean;
  readonly quarantined: boolean;
  readonly counts: boolean;
  readonly versions_read: readonly (string | null)[];
}

export interface ProposalShowResult {
  readonly id: string;
  readonly skill: string;
  readonly action: string;
  readonly status: string;
  readonly at: string;
  readonly age_hours: number | null;
  readonly base: string | null;
  readonly version: string;
  readonly since: string | null;
  readonly checks: { readonly passed: boolean; readonly reasons: readonly string[]; readonly problems: Readonly<Record<string, string>> } | null;
  readonly red_flags: readonly RedFlag[];
  readonly risk_flags: readonly { readonly flag: string; readonly severity: 'red' | 'amber'; readonly detail: string }[];
  readonly tokens: readonly { readonly token: string; readonly kind: string; readonly origin: 'green' | 'amber' | 'red'; readonly found: string }[];
  readonly description_diff: readonly string[];
  readonly body_diff: readonly string[];
  readonly evidence: { readonly meets: boolean; readonly pages: number; readonly traces: number; readonly issues: number; readonly fails: number };
  readonly traces: readonly CitedTraceRow[];
  readonly pages: readonly { readonly slug: string; readonly gone: boolean; readonly quarantined: boolean; readonly counts: boolean; readonly changed_since: boolean | null }[];
  readonly scorecard: Scorecard | null;
  readonly ledger: readonly ShownLedgerRecord[];
  readonly decision: (ShownLedgerRecord & { readonly acks?: readonly string[]; readonly note?: string; readonly actor: Readonly<Record<string, unknown>> }) | null;
  readonly result: { readonly text: string; readonly ops: readonly { readonly op: string; readonly anchor?: string; readonly text: string }[] };
  readonly claims: {
    readonly unverified: true;
    readonly rationale?: string;
    readonly failures?: readonly { readonly trace: string; readonly line: string }[];
    readonly expected_signal?: string;
    readonly provenance?: string;
    readonly client: string | null;
    readonly model: string | null;
  };
}

export interface ShownChange {
  readonly record: string;
  readonly kind: string;
  readonly version: string | null;
  readonly by: string;
  readonly at: string;
}

export interface ShownSkill {
  readonly name: string;
  readonly status: string;
  readonly description: string | null;
  readonly current: string | null;
  readonly served: string | null;
  readonly blocked: boolean;
  readonly superseded: readonly ShownChange[];
  readonly contested: readonly { readonly proposal: string; readonly accepted: readonly string[]; readonly rejected: readonly string[]; readonly withheld: boolean }[];
  readonly provenance: (ShownChange & { readonly origin: string; readonly actor: Readonly<Record<string, unknown>>; readonly commit: string | null }) | null;
  readonly scorecards: readonly Scorecard[];
  readonly attention: readonly string[];
  readonly acknowledge: readonly string[];
  readonly versions: number;
  readonly last_change: ShownChange | null;
  readonly pending_proposal: string | null;
  readonly worktrees?: readonly string[];
  readonly copies?: readonly { readonly worktree: string; readonly version: string | null; readonly state: 'current' | 'behind' | 'none' }[];
  readonly text?: string | null;
  readonly history?: readonly (ShownChange & { readonly from: string | null; readonly origin: string; readonly proposal?: string; readonly reason?: string; readonly fate?: string })[];
}

export interface PlannedChange {
  readonly record: string;
  readonly kind: string;
  readonly version: string | null;
  readonly by: string;
  readonly at: string;
  readonly proposal?: string;
}

export interface RestorePlan {
  readonly skill: string;
  readonly version: string;
  readonly current: string | null;
  readonly status: string;
  readonly undone: PlannedChange | null;
  readonly dropped: readonly (PlannedChange & { readonly diff: readonly string[] })[];
  readonly diff: readonly string[];
  readonly lifts_block: boolean;
  readonly active: number;
  readonly cap: number;
}

export interface SkillShowResult {
  readonly skills: readonly ShownSkill[];
  readonly active: number;
  readonly cap: number;
  readonly over_cap: boolean;
  readonly delivery: 'on' | 'off';
  readonly restore?: RestorePlan;
}

export interface WikiListRow {
  readonly slug: string;
  readonly title: string;
  readonly kind: string;
  readonly summary: string;
  readonly sources: readonly string[];
  readonly generated: string | null;
  readonly verified: string | null;
  readonly updated_at: string;
  readonly conflicted: boolean;
  readonly quarantined: boolean;
  readonly purged_sources: readonly string[];
  readonly flagged_by: readonly string[];
}

export interface WikiLogEntry {
  readonly at: string;
  readonly kind: 'edit' | 'compile';
  readonly action: string;
  readonly by: string | null;
  readonly run: string | null;
  readonly pages: readonly string[];
  readonly traces: number;
  readonly resolved: number;
}

export interface WikiListResult {
  readonly pages: readonly WikiListRow[];
  readonly log: readonly WikiLogEntry[];
}

export interface WikiSide {
  readonly id: string;
  readonly fields: readonly string[];
  readonly title?: string;
  readonly kind?: string;
  readonly summary?: string;
  readonly body?: string;
  readonly sources: readonly string[];
  readonly at: string;
}

export interface WikiShowResult extends WikiListRow {
  readonly body: string;
  readonly base: string;
  readonly sides: readonly WikiSide[];
  readonly link: string | null;
}
