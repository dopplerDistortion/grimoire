# Wiki pages and evolved-skill texts live on the tracker branch, and checkouts get generated copies nobody commits

A host repo is worked on many branches, worktrees and clones. Wherever knowledge-loop writes land decides who sees an evolved skill, and when. ADR 0007 already puts the knowledge layer's records (the skill ledger, skill-version texts, proposals, chore-run records and quarantine marks) on the tracker branch. Each knowledge write must commit atomically with the records that describe it. Files in a checkout can't do that, because nobody may commit them: grimoire never commits in a checkout, agents never stage `.grimoire/`, and upkeep never commits.

So the whole knowledge layer lives on the tracker:
- **Wiki pages** live at `knowledge/wiki/`, with a derived index and log. A compile's pages land in the same commit as its chore-run record.
- **Evolved-skill texts** are the ledger's skill versions. A skill's **current** version is derived from the ledger in the merged tracker view, never from any checkout.
- **Staleness** of a pending proposal is judged against that current version alone. A worktree on an old branch can neither flip a skill back nor stale a proposal.

**What a checkout holds.** Each worktree gets **generated output** only:
- the current text at `.grimoire/skills/<name>/SKILL.md`;
- the skill stubs that point at it (ADR 0002).

Each generated folder carries its own `.gitignore` of `*`, so nobody commits these files on any branch, and an agent's `git add -A` never sweeps them in. Upkeep rewrites them byte-exact from the served text, or deletes them. A **stray edit** to a copy is set aside and never served until a human records it. Humans edit through `grimoire skill edit` and `grimoire wiki edit`, which open their own editor and commit to the tracker. A SessionStart hook step writes missing copies before the client lists skills.

**"Never rolled back"** therefore means two things. Nothing done to a code branch can change the wiki or an evolved skill: abandoning, rebasing, squash-merging, reverting or resetting it. And grimoire changes them only by new tracker commits.

## Considered Options

- **Wiki and skill files in the dotfolder, committed on code branches.** This was the original assumption. Rejected for three reasons:
  - Nobody may commit them, so a compile's records could point at pages that never reach git.
  - An accept made on a branch that is later abandoned would be accepted in the ledger but missing from the code.
  - Each branch would carry its own skill text, so worktrees on old branches would disagree about "current".
- **A second grimoire ref** (`refs/grimoire/knowledge`), moved in the same `update-ref` transaction. Rejected: it buys nothing a subtree of the tracker doesn't, and it doubles fetch, fold and push.
- **Tracker-authoritative text with committed generated copies.** Rejected for three reasons:
  - Every branch would churn with "commit them" diffs.
  - Generated files would conflict between branches.
  - Agents that commit their whole working tree would sweep regenerated skill files into their commits, which Trace capture flags as agent skill edits.
- **A committed allow-list of served versions, changed only through PRs.** Not in v1. It would bring back a per-branch, commit-on-every-accept step. It can be added later without changing the record format.

## Consequences

- **Sessions on machines that never joined get no evolved skills.** That covers other agent tools, Codex cloud, single-branch forks, shallow CI checkouts and teammates who never ran `init`. This amends Knowledge delivery's user-confirmed "every agent session in the host repo" and "teammates get them through git". Both still hold on every machine that joined, and still through git, on the tracker branch.
- **The wiki is no longer files in the checkout.** Humans read it in the dashboard, on the forge's view of `grimoire/tracker`, or with `grimoire wiki show`, and edit it with `grimoire wiki edit`. This amends Knowledge delivery's user-confirmed answer that wiki files are canonical on disk and hand-editable. It also narrows ADR 0002's grep leak: an agent now has to read the tracker branch deliberately.
- **Evolved skills apply in every checkout,** whatever branch it is on. A worktree on an old release branch is served current text that may name commands its code doesn't have yet.
- **There is no code review of skill text.** Anyone who can push `grimoire/tracker` can change what every teammate's agents are told, as issue bodies already can. Every current version shows where it came from (a local decision, or another clone, with its actor and tracker commit), and `doctor` flags knowledge records without grimoire's trailers. ADR 0005's "host-repo review of `.grimoire/` changes" backstop becomes the tracker log.
- **Concurrent decisions resolve without the clock.** The fold never merges skill text. In a fork, a delete wins over a restore, which wins over an accept, and between two accepts the lower version hash serves until a human picks one. These derivation rules belong to the store format, so worktrees on different pins agree.
- **First turns in fresh worktrees.** Claude Code sees copies written by the SessionStart hook on its first turn through `reloadSkills`. Codex sees them from its second turn. Every stub names `skill_read` as the fallback.
