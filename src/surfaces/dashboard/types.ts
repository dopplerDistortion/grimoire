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
  readonly lines: readonly string[];
  readonly warnings: readonly string[];
  readonly commands: { readonly enable: readonly string[]; readonly disable: string };
}
