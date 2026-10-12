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
