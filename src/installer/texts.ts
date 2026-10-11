// The shipped text of grimoire's content pointer files and docs (spec §11):
// the instruction rules file, the AGENTS.md block, the adapter doc block and
// the triage-labels seed. The instruction text is the server instructions,
// word for word. Markers carry no version.
import { SERVER_INSTRUCTIONS } from '../instructions';

/** `.claude/rules/grimoire.md`: the instruction text inline. */
export function instructionRulesText(): string {
  return `# grimoire\n\n${SERVER_INSTRUCTIONS}\n`;
}

/** A marked block's first and last lines in Markdown. */
export function markdownMarkers(marker: string): { begin: string; end: string } {
  return { begin: `<!-- >>> ${marker} (managed block) -->`, end: `<!-- <<< ${marker} -->` };
}

/** The marker name of the `AGENTS.md` block. */
export const AGENTS_MARKER = 'grimoire';

/** The body of the `AGENTS.md` block (between its markers). */
export function agentsBlockBody(): string {
  return `## grimoire\n\n${SERVER_INSTRUCTIONS}\n`;
}

/** The marker name of the adapter doc block: named after the skill pack's tracker docs. */
export const ADAPTER_MARKER = 'grimoire issue-tracker-grimoire.md';

/** Where the adapter doc lives. */
export const ADAPTER_DOC = 'docs/agents/issue-tracker.md';

/** Where the triage labels are seeded. */
export const TRIAGE_LABELS_DOC = 'docs/agents/triage-labels.md';

/**
 * The body of the adapter doc block (`issue-tracker-grimoire.md`), with the
 * skill pack's exact headings. `supersedes`: the block sits at the top of a
 * doc that described another tracker, and overrides the rest of it.
 */
export function adapterBlockBody(options: { supersedes: boolean }): string {
  const lines = [
    '# Issue tracker: grimoire',
    '',
    "Issues for this repo live in grimoire, on the `grimoire/tracker` branch (never checked out or merged). Agents use grimoire's MCP tools; when no grimoire tools are listed, they run the same verbs as `node .grimoire/run.cjs <verb>` from the repo root, which prints one JSON object. Parameters are in the tool schemas, or `node .grimoire/run.cjs <verb> --help`.",
    ...(options.supersedes ? ['', 'This section supersedes the rest of this file: the tracker it describes below is no longer where issues live.'] : []),
    '',
    '## Conventions',
    '',
    '- **Create an issue**: `create` (CLI `create --title …`). Pass an `idempotency_key` so a retry never duplicates: one key per logical write, stable across retries.',
    '- **Read an issue**: `show` (CLI `show <id>`).',
    '- **List issues**: `list` (CLI `list`). "Ready for agents" is `list {label: ready-for-agent, ready: true}`.',
    '- **Make an issue a sub-issue of a parent**: `create` or `update` with `parent`.',
    '- **Comment on an issue**: `comment` (CLI `comment <id> --body …`).',
    '- **Apply / remove labels**: `update` with `labels_add` / `labels_remove`.',
    '- **Close**: `close` with `reason: done`. "Delete" means close as `canceled`.',
    '- **Blockers**: create blockers first, then the issues they block (`blocked_by`).',
    '- **Claim, close and debrief**: `claim` only the leaf you will work, and pass its `attempt` handle while you hold it. End every claim with `close` or `release` and a debrief {asked, tried, failed, worked, next}. Triage, creating issues, charting, comments and reviews never claim.',
    '- **Commits**: a commit that works an issue carries a `Refs: <id>` trailer.',
    '- **Triage labels**: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix, bug, enhancement (see `docs/agents/triage-labels.md`).',
    "- **Who `me` is**: this repo's `git config user.email`.",
    '',
    '## Pull requests as a triage surface',
    '',
    '**PRs as a request surface: no.**',
    '',
    '## When a skill says "publish to the issue tracker"',
    '',
    'Create a grimoire issue with `create`.',
    '',
    '## When a skill says "fetch the relevant ticket"',
    '',
    '`show` it by id.',
    '',
    '## Wayfinding operations',
    '',
    'Used by `/wayfinder`. The **map** is one issue with **sub-issues** as tickets.',
    '',
    '- **Map**: an issue labelled `wayfinder:map` whose body has exactly five sections, with these anchors: `## Destination`, `## Notes`, `## Decisions so far`, `## Not yet specified`, `## Out of scope`. Edit it with `update` and anchored `body_patch` operations, never a full-body replace.',
    '- **Child ticket**: an issue with `parent` = the map, labelled with exactly one of `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task`.',
    '- **Blocking**: `blocked_by` on the child. A ticket is unblocked when every blocker is closed.',
    '- **Frontier query**: `list {parent: <map>, ready: true}`; the first row wins.',
    '- **Claim**: `claim` the ticket, the session’s first write.',
    '- **Resolve**: one call, `close` with `reason: done`, the answer in the debrief, and a `parent_patch` that inserts the context pointer before the map’s `## Not yet specified` heading.',
  ];
  return `${lines.join('\n')}\n`;
}

/** `docs/agents/triage-labels.md`, seeded only when absent: the seven roles. */
export function triageLabelsText(): string {
  const roles: [string, string][] = [
    ['needs-triage', 'Maintainer needs to evaluate this issue'],
    ['needs-info', 'Waiting on reporter for more information'],
    ['ready-for-agent', 'Fully specified, ready for an AFK agent'],
    ['ready-for-human', 'Requires human implementation'],
    ['wontfix', 'Will not be actioned'],
    ['bug', 'Something is broken'],
    ['enhancement', 'A new feature or an improvement'],
  ];
  const lines = [
    '# Triage Labels',
    '',
    'The skills speak in terms of canonical triage roles. This file maps those roles to the label strings used in this repo’s issue tracker (grimoire labels).',
    '',
    '| Label in mattpocock/skills | Label in our tracker | Meaning |',
    '| -- | -- | -- |',
    ...roles.map(([label, meaning]) => `| \`${label}\` | \`${label}\` | ${meaning} |`),
    '',
    'When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.',
    '',
    'Edit the "Label in our tracker" column to match whatever vocabulary you actually use.',
  ];
  return `${lines.join('\n')}\n`;
}
