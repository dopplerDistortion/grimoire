// What each `Grimoire-Op` (spec §3, Commits) tells a reader of the tracker's
// history about what changed, for the dashboard's live events (spec §20,
// SSE): which views refetch.
//
//   issue      the issue and attempt named by `Grimoire-Issue` / `Grimoire-Attempt`
//   knowledge  the Knowledge views (proposals, skills, the ledger, the wiki, traces)
//   settings   the Settings view
//   reload     everything: a fold, a new or rewritten history
//
// Every op a write commits must be listed (test/core/commits.test.ts checks
// the sources). An op not listed, such as a newer release's arriving by sync,
// means reload. A knowledge op commits under the ledger kind it records,
// except that a skill's delete is `skill-delete` (bare `delete` deletes an
// issue) and a skill's edit is `skill-edit`.

export type OpEffect = 'issue' | 'knowledge' | 'settings' | 'reload';

const OP_EFFECTS: ReadonlyMap<string, OpEffect> = new Map<string, OpEffect>([
  ...(['create', 'update', 'comment', 'claim', 'release', 'close', 'assign', 'reassign', 'reopen', 'delete', 'resolve', 'outcome-set'] as const).map(
    (op) => [op, 'issue'] as const,
  ),
  ...(
    [
      // Decisions on a proposal (spec §18).
      'accept',
      'reject',
      'dismiss',
      'reconsider',
      // Skill changes (spec §15, §18).
      'skill-edit',
      'record',
      'discard',
      'restore',
      'skill-delete',
      'eject',
      'acknowledge',
      'unblock',
      // The wiki (spec §17) and trace quarantine.
      'wiki-edit',
      'compile',
      // A Skill Proposer run's end: its proposal, no_action or failure (spec §16).
      'propose',
      'quarantine',
      'unquarantine',
    ] as const
  ).map((op) => [op, 'knowledge'] as const),
  ['settings-set', 'settings'],
  // A sweep's capture attaches session records to open attempts of any issue, naming none.
  ...(['fold', 'init', 'purge', 'capture'] as const).map((op) => [op, 'reload'] as const),
]);

/** What a commit with `Grimoire-Op: <op>` changed; `reload` for an op this release doesn't list. */
export function opEffect(op: string): OpEffect {
  return OP_EFFECTS.get(op) ?? 'reload';
}

/** Whether this release lists `op`. */
export function isKnownOp(op: string): boolean {
  return OP_EFFECTS.has(op);
}
