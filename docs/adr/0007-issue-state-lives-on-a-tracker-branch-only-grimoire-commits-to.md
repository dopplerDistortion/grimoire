# Issue state lives on a tracker branch that only grimoire commits to

All of a clone's worktrees must share one live issue state, so that a claim made in one worktree stops the next frontier query in another. Issue state must never be committed only on a feature or throwaway branch, and agents never stage `.grimoire/` (ADR 0003). Files in each checkout can't meet both requirements. So grimoire keeps everything its own code writes on a **tracker branch**: issues, comments, attempts, traces, outcomes, idempotency keys and knowledge-layer records.

**Refs.** Locally the tracker is the ref `refs/grimoire/tracker`. On the remote it is the branch `grimoire/tracker`, so a default fetch brings it to every full clone.

**Writes.** Grimoire writes the tracker only through git plumbing. It writes the objects first, then moves the ref with a compare-and-set. Each operation is one commit, so it either happens completely or not at all.

**The live store.** The ref and its objects sit in the git common directory, which every worktree shares. Grimoire's never-committed machine-local data sits beside them in `<git-common-dir>/grimoire/`, and the two together are the live store.

**The checkout.** The checkout's `.grimoire/` keeps only install configuration, the manifest, and the files agents read straight from the checkout.

**Reads.** A read shows the merge of the local tip and the fetched remote tip, computed in memory. A plain `git fetch` is therefore enough to see a teammate's changes, and a read never writes.

**Merges and sync.** A write commits that merge together with its own change. Grimoire merges the tracker itself, with rules that know each record's shape, and never with `git merge`. After every attempt-ending write it syncs in the background with ordinary git fetch and push.

## Considered Options

- **Records as files in each checkout's `.grimoire/` that travel with branches**, plus a machine-local claim overlay and a read view merged with the default branch. This was the strongest design before Agent interface resolved. Rejected for three reasons:
  - Nobody may commit those files: agents never stage `.grimoire/`, and grimoire never commits in a checkout.
  - State written on never-merged `research/*` branches would be lost.
  - Parallel wayfinder sessions insert at the same map anchor, which a git line merge always turns into a conflict.
- **Writing to the default branch.** Rejected for two reasons:
  - `update-ref` moves a branch even while another worktree has it checked out, and that silently corrupts the checkout (verified).
  - Protected branches reject direct pushes.
- **A machine-local store only**, in SQLite or as files in the git common directory. Rejected: nothing would reach git, and git is the only sync layer.
- **A custom ref on the remote (`refs/grimoire/*`), or Dolt.** Rejected: the default refspec doesn't fetch them, so every clone would need its own setup.
- **A local branch named `grimoire`.** Rejected for three reasons:
  - `git switch` would check it out.
  - Branch-cleanup scripts would delete it, along with unpushed state.
  - It blocks every `grimoire/*` branch name.

## Consequences

- **The dotfolder no longer holds issue state.**
  - Humans read issues through grimoire, the dashboard, or the forge's view of `grimoire/tracker`, which carries a generated index.
  - Committed issue links default to the record's URL on the forge.
- **Grimoire pushes on its own.** It runs a best-effort background sync after attempt-ending writes, and a store setting turns this off.
  - Host-repo rules that cover all branches can reject or act on the tracker branch: signed commits, linear history, push protection, and preview deploys of every branch.
  - Sync reports rejections, and teams exempt `grimoire/tracker`.
  - Tracker commits are unsigned and skip the host's pre-push hooks.
- **Claims are exclusive only within one clone (ADR 0004).** Across clones, conflicts are settled when the tracker is merged, and they surface as `STATE_CONFLICT`.
- **Every write is a commit, and history grows with every claim and comment.**
  - A naive build spawns git several times per write, about 240 ms on Windows. Writes must therefore build objects in-process to stay fast with dozens of concurrent writers.
  - Trees are sharded two levels deep by id.
- **Purge has limits.** A purged trace leaves the tracker's tip, but pushed history keeps it (ADR 0001). Purge can rewrite only the unpushed part of the tracker.
- **Forks without push access** can't share tracker state with upstream.

_Amended by ADR 0008: `Grimoire-Actor` also carries the context, call id, spawn-env id, process nonce and any chore-exposure basis. `Grimoire-Attempt` carries the handle the caller named, on claim, update, comment and ending ops only. `end.md` keeps only attempt-level fields, and per-context entries are read from the frozen session records. A single session record's purge writes its own tombstone._

_Amended by ADR 0010: the tracker also holds the wiki (`knowledge/wiki/`), and the evolved-skill texts are its skill versions. The fold merges wiki pages and resolves skill forks by rules that belong to the store format. Accepted chore submits and human knowledge decisions trigger the same background sync as attempt-ending writes._
