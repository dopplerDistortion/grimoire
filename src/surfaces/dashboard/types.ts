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
  | { readonly kind: 'stray_edit'; readonly stray: ShownStrayEdit };

export interface AttentionResult {
  readonly items: readonly AttentionItem[];
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
    readonly proposals: readonly { readonly id: string; readonly skill: string; readonly action: string; readonly at: string }[];
  };
  readonly quarantine: { readonly by: string; readonly at: string; readonly reason: string } | null;
}
