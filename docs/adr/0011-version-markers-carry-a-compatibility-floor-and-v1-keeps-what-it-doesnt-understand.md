# Version markers carry a compatibility floor, and v1 keeps what it doesn't understand

The pinned version travels with branches (ADR 0009), so the worktrees of one clone, and every teammate, run different releases against one tracker branch, and each machine's worktrees against one machine-local store. A refuse-anything-newer format check would stop every worktree and teammate on an older pin with `UPGRADE_REQUIRED` at every store change, until they took the upgrade.

So the tracker's `format` file and the machine-local store's marker each hold three values:
- **`format`:** the shape the data is at.
- **`compat`:** the oldest format a release must understand to read and write that data.
- **`requires`:** the oldest release that understands `compat`. It is used only to tell people exactly what to merge, rebase onto or upgrade to.

Each release declares, per marker, the newest format it knows (K) and the oldest it can run against (J). It runs iff **J ≤ `compat` ≤ K**. `install_format` stays a single number in `config.yml`, because it belongs to one checkout and one pin.

**v1 ships format 1 everywhere, with no migrations, and keeps what it doesn't understand.** Its K and J are both 1, so it runs against any store whose `compat` is 1, even after a later release has raised `format`. In such a store it never loses another release's data:
- **Unknown keys survive.** Unknown frontmatter keys are kept through rewrites and folds. An issue's revision covers every frontmatter key except a fixed exclusion list, so pins agree on it.
- **Unknown files survive.** They are never rewritten. In a fold, a change made on only one side wins, the lower blob hash breaks a tie, and a modification beats a delete, unless v1 deleted the whole directory (an issue delete or a purge).
- **Derivations ignore what they don't know.** Unknown record kinds play no part in the current skill version, ready and blocked, or outcomes.
- **Markers only rise.** A fold merges each marker to its field-by-field maximum.
- **Derived files aren't fought over.** Each one carries `generated-by`, and no release rewrites one that a newer release generated.
- **Every tracker commit names its release** in a `Grimoire-Version` trailer.

**The release number carries the promise:**
- A patch release changes no format.
- A minor release may raise a `format` additively, but never `compat` or `install_format`.
- Only a major release may raise `compat` or bump `install_format`.

So within one major, an upgrade is undone by reverting its commit, and no pin is stranded.

## Considered Options

- **One integer per marker, refusing anything newer.** Rejected: mixed pins are normal, and every later store change would strand all of them at once.
- **An N-1 window, where each release reads and writes two formats.** Rejected for two reasons:
  - it doubles the cost of every change;
  - it still strands pins two releases back.
- **Separate read and write floors, as in SQLite's file header.** Rejected: it adds a read-only state, and an agent that can see issues but can't claim them is worse off than one told exactly what to do.

## Consequences

**Later releases are bound by named rules.** These rules are recorded instead of v2-and-later migrations being designed now:
- **Additive within a major.** A minor may add only optional frontmatter keys, and write-once files under new paths, that v1's generic handling folds correctly. Anything that changes a derivation raises `compat`: the current skill version, fork resolution, wiki folds, ready and blocked, outcomes, revisions.
- **Expand, then contract.** A breaking change first ships as an additive minor that reads and writes the new shape. The major that raises `compat` comes later.
  - It runs only when nothing would be stranded: for the store, the remote default branch's committed pin is at least the new `requires`; for the machine-local store, every registered worktree's pin is.
  - It is interactive only, with a typed confirmation.
- **A store migration is a forward commit.** It is one tracker commit per format step, holding the marker and the data together. It is a deterministic function of the tree, so a lagging clone's unpushed commits are migrated at fold time, or refused with a named remedy, and never dropped.
- **Who migrates.** A marker below a release's J is migrated by an `init` that a human runs at that release, joins included, because machine-local data never travels by git. It is never migrated by upkeep, a hook or an agent's process.

**The cross-pin contract is frozen, and can only gain fields that older releases ignore.** It is everything one pin's process may meet from another pin:
- **Entries:** the bootstrap and the entry verbs.
- **Package loading:** the launcher↔package contract.
- **Shared data formats:**
  - the marker schema;
  - the join record;
  - machine-local coordination data, kept version-free (leases, locks, process records, seen-here rows, runner counters);
  - the control channel;
  - the manifest's entry kinds;
  - the generated-path list.

In particular, Codex runs the main checkout's entries in every linked worktree, so any entry may meet any pin.

**`UPGRADE_REQUIRED` names `requires`.** That lets it say exactly which branch to merge or rebase onto, or which `init --upgrade` to run, instead of only "upgrade".
