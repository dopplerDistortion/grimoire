# Spec review: grimoire v1 close-out (HEAD 3af2e35, `git diff origin/main...HEAD`)

Reviewer: spec lens. Read-only; no tests run (one `npm pack --dry-run --json --ignore-scripts`).
Spec: GOK-123 (local copy `grimoire-v1-notes/spec/`). Already-recorded amendments taken as spec: the 7 GOK-123 comments (bootstrap ~819 chars and `--` entries; GOK-141 JSON-literal flags and `CLI writes fail in sandboxed shells`; GOK-143 wiki edits, ledger quarantine, page timestamps; GOK-138 seal fold and `reach`; GOK-142 INTERNAL and the CLI-fallback sentence), ADRs, spikes and codex-ruling.md.
Scope, in priority order: (d) on-disk and wire formats (§3 §5 §6 §8 §9 §10 §21); (b) GOK-160/163/169/170 (§20) and GOK-172; (a) PRIORITY/OPEN followups; (c) merger, flake and infra behaviour (§4 §14).
I checked every finding below against the code at HEAD. Where a sub-reviewer raised a finding, I re-read the cited lines for every medium and above.

Severity rubric: integrity, fail-open and anything that freezes at first publish is at least medium.

---

## 1. Missing or partial requirements

**1.1 medium: `init --from-node-modules` is not implemented**
- Spec §10 (Runtime): `init [--clients] [--yes] [--excerpts <mode>] [--new-tracker] [--adapter] [--from-node-modules] [--upgrade] [--json]`.
- Spec §11: "`init --from-node-modules` copies a matching devDependency into the store."
- Code: `src/surfaces/cli/init.ts:26-27`. `BOOLEAN_FLAGS`/`VALUE_FLAGS` don't have the flag, so it is rejected as a usage error (exit 2). `grep -rn "from-node-modules\|fromNodeModules" src` finds nothing.
- followups line 45 deferred it to GOK-161, and it never landed. CLI verbs and flags freeze at 1.0.0.
- Fix: implement it, or record the removal on GOK-123.

**1.2 low: the tracker's top-level `README.md` (generated index) is never written**
- Spec §3 Layout: "`README.md`: a generated index for forge browsing", and "Derived files (`README.md`, the wiki index and the wiki log) carry `generated-by`".
- Code: `grep -rn README src` finds nothing. Only the wiki index and log are derived (`src/tracker/wiki.ts:457-473`). No ticket's acceptance criteria named it (GOK-132 does not).
- It is additive later, since v1 keeps unknown files. Implement it, or record it as deferred.

**1.3 low: `start.md` has no delivery-switch state for attempts opened by `assign`/`reassign`**
- Spec §3: `start.md` holds "the delivery-switch state". Spec §14 Facts: "Offered (in `start.md`, with the delivery-switch state)".
- Code: `src/core/human-ops.ts:46-51` and `:89` call `openAttempt` with no `delivery`. Claims and unclaimed closes do pass it (`src/core/attempts.ts:122-129`, `:382-389`).
- Leaving out `skills_offered` is defensible, since there is no checkout. But the delivery switch is a store setting, so it can always be recorded.
- Effect: agent traces under an assigned attempt with delivery off are scored in the `main` group (`src/knowledge/scorecards.ts:110`).

**1.4 low: `--help` gaps**
- Spec §10: "Every verb accepts `--help`".
- Global `grimoire --help` leaves out `start` and `open`: `RUNTIME_VERBS` at `src/surfaces/cli/args.ts:341-350` doesn't list them, because `src/surfaces/entry.ts:62` dispatches them before `runCli`.
- `mcp --help` starts the server (`entry.ts:29-33`; `src/surfaces/mcp/serve.ts:133` ignores flags).
- `hook --help` prints nothing and exits 0 (`src/surfaces/hooks/run-hook.ts:31-37`).
- `runner --help` exits 2 (`src/surfaces/cli/runner.ts:72-73`).
- Fix `start`/`open`/`runner`. Record that the internal entry verbs are exempt, since §21 says `mcp` ignores unknown flags.

**1.5 low: some MCP results are never cut at ~24 KB**
- Spec §8: "Every result stays under ~24 KB and is cut well-formed by grimoire, with `truncated` and a cursor."
- Code: `labels` (`src/core/ops.ts:108-117`), the `chore_start` brief's `manifest` (`src/core/chores.ts:180`) and `update`'s `noops` are never trimmed. `src/surfaces/mcp/result.ts:23` only drops notices; it never cuts the body. Hitting the cap is unlikely in practice.

**1.6 low: `proposal_purge` doesn't say that pushed history keeps the content, or what cites it**
- User story 68 asks for both. Spec §3: "every purge says so".
- Code: `ProposalPurgeResult` (`src/core/proposals.ts:681-690`) has no `history` note and no `cited_by`. `purge_trace` has both.

**1.7 low: uninstall finds the Codex TOML block and the Markdown blocks by marker only**
- Spec §21: entries are "found by the frozen bootstrap and verb text first, then by key or marker".
- Code: JSON entries follow this (`src/installer/removal.ts:218, 232`), but the TOML and Markdown blocks match markers only (`removal.ts:411-418`). With edited markers the entry counts as gone and `[mcp_servers.grimoire]` is left behind.

**1.8 low: `skill_acknowledge` can't side with the reject on a contested create**
- Spec §18: Acknowledge "settles a contested decision".
- Code: `src/core/skill-changes.ts:312-323` (`acknowledgeable`) offers only the accepted version when `from` is null. Siding with a `suspicious` reject means `skill_delete`, which also blocks the name.

**1.9 low: the dashboard assign picker doesn't list identities seen on the tracker**
- Spec §20: assign "picks from identities seen on the tracker or takes a typed email".
- Code: `src/surfaces/dashboard/issues.tsx:93-98` uses only the signed-in person and the current open-attempt assignees. `issue.tsx:137-151` adds this issue's people. Typing an email works.

**1.10 low: the runner trigger doesn't react to `reopen`**
- GOK-169: re-evaluate "when the tracker ref moves with a trace write, an outcome change or a decision".
- Code: `src/runner/trigger.ts:27-37` (`TRIGGER_OPS`) has no `reopen`, though `reopen` flips an outcome and seals attempts (`src/core/human-ops.ts:179-189`). Due-ness waits for the 30-minute timer.

**1.11 low: no CI, so the Node floor is unverified**
- Spec §1: "CI runs on Windows, macOS and Linux…; the floor is the oldest 22.x minor that CI tests."
- Code: there is no CI. `package.json` `engines: ">=22"` was checked only on Windows with Node 24. A grep for post-22.0 APIs found none, and zstd is feature-detected.
- This is recorded on GOK-172 and in `README.md:171` (1.0.1 follow-up), but not on GOK-123.

## 2. Scope creep

None of these is harmful. Each becomes a public surface at 1.0.0, so record it or remove it.

**2.1 low: CLI verbs and flags beyond §10's verb table**
- Every registry op becomes a CLI verb automatically (`src/core/index.ts:181-237`; `args.ts:163-173`).
- Human-read verbs added: `proposal list`, `skill strays`, `purge list`, `activity`, `attention`, `attempt show`, `knowledge overview`, `chore runs`.
- Agent verb added, CLI only: `sync status`.
- Extra flags: `runner enable --model/--binary` (`src/surfaces/cli/runner.ts:95-96`) and `init --from` (`init.ts:27`).
- None of them reaches MCP; the MCP tool set is exactly §8's 15 tools.

**2.2 low: environment variables the spec doesn't name**
- `GRIMOIRE_BROWSER` (`src/surfaces/start/browser.ts:8`).
- `GRIMOIRE_DEBUG` (`src/surfaces/hooks/debug.ts:8`, documented at `README.md:112`).
- Only `GRIMOIRE_CHORE_ORIGIN` is in the spec (§16).

**2.3 low: dashboard HTTP endpoints beyond §20's list**
- `GET /health` (public; echoes the nonce for §12's probe), `GET /api/session`, `GET /api/instance`, `GET /api/runner` (`src/surfaces/start/server.ts:6-16`).
- Also a status-code mapping (400/401/403/404/500/503, everything else 409; `server.ts:65-72`) and live-event extras: a `ready` event, `instance`/`agent` flags, `?last_event_id=` and `<local>:<remote>:<stamp>` ids (`src/surfaces/start/events.ts:7-23`).
- These are needed plumbing. Only the same release's bundled dashboard uses them.

**2.4 low: a new human-read op, `purge_list`, not in §20's list of dashboard read ops** (`src/core/purge.ts:179-210`). It is used by the Settings "purged records" panel.

## 3. Implemented but wrong

**3.1 medium (integrity): a purge can wrongly report "never pushed", because sync's push runs outside the fairness lock**
- Spec §3: "Unpushed content is dropped by rewriting the unpushed tracker segment… Pushed history is never rewritten, and every purge says so."
- Code: `src/tracker/sync.ts:372-399`. The fold (`host.fold`) and the strip (`host.stripUnpushed`) each take the lock for themselves only (`src/tracker/store.ts:387`, `:606`). The push then sends a fixed `local` oid with no lock (`sync.ts:393`).
- A purge that commits in between rewrites the segment, and the sync still pushes the old, unpurged commits.
- The purge's `history.pushed` is read from remote-tracking refs right after its compare-and-set (`store.ts:543-545`, `:578-582`). It misses the push in flight, so `src/core/purge.ts:73` says "It was never pushed".
- Variant: after a successful push, a failed remote-tracking update is swallowed (`sync.ts:399` `.catch(() => {})`). A later purge then also says "never pushed".
- This is the open PRIORITY from followups 147/151.
- Fix: push under the fairness lock, or re-check the local tip against `local` just before the push. Have `pushed` assume "maybe" while a sync lease is held.

**3.2 medium: a purge can answer BUSY ("nothing changed"), or `changed: false`, after its own commit landed**
- Spec §9: "An error always means nothing changed." ADR 0012 makes INTERNAL the only exception.
- Code: in `round()`, after `moveRef` succeeds (`store.ts:780`; the rewrite-only path at `:766`), the round awaits `droppedHistory` → `pushedHolds`. That runs a one-shot `git rev-list -1 <tips> -- <paths>` (`store.ts:580`) with no catch.
- Inside a write, a stalled git is killed as stuck with the leftover budget (up to 5 s, possibly ~0 ms near the deadline). That throws `GitStalledError`.
- `rounds()` (`store.ts:715-728`) re-throws it as BUSY after the deadline. Before the deadline it retries, and the retry answers `changed: false` (`src/core/purge.ts:117`) for a purge this same call committed.
- `pushedHolds` walks all pushed history when the content was never pushed, so on a large tracker the 5 s limit can run out in the common case.
- Fix: run the post-commit facts outside the round's stall regime, and treat a failure there as "pushed: maybe" (never an error).

**3.3 medium (fail-open; PRIORITY, followups 167/173): a malformed Wiki Maintainer result is kept as full text even if it holds a secret**
- Spec §16: "the result text stays machine-local, except after a secret-scan failure: then only the reason codes and matched rule ids are kept". Spec §8: no result text is kept after a secret-scan failure.
- Code: `src/knowledge/chores/compile.ts:186-188` returns the `shape` rejection before any scan. `src/core/chore-submit.ts:299-305` then keeps `text: JSON.stringify(result)`, because `rejection.secret` is false.
- The proposer secret-scans the raw result first (`src/knowledge/chores/propose.ts` `scanRaw`); compile doesn't.

**3.4 medium (fail-open): a Codex `_meta` with only a `callId` gets past chore admission**
- Spec §16 admission and §9: `NOT_ISOLATED` for "`chore_start` from a context grimoire can't identify as attempt-free".
- Code: `src/knowledge/chores/admission.ts:101-106`. When `evidence.source === 'meta'` and both `session` and `context` are undefined, `root = (session ?? context)!` is undefined. That gives key `codex/undefined`, `rootSession: undefined`, and an isolation of `codex-root`.
- The open-attempt check matches nothing, so the caller is admitted, and every such caller shares one key. The other GOK-154 integrity fixes are in place (admission fails closed on a null email or a seen-here error; `chore_start` is atomic; `withRunLock`).
- Fix: throw `NOT_ISOLATED` when neither id is present.

**3.5 medium (integrity): a stale remote-tracking tracker ref is adopted or folded when the remote has no tracker** (followups 46)
- Spec §12: "First install (no R): adopt the remote tracker, or a kept local one." Spec §4: sync fetches, folds, pushes.
- Code: `src/installer/init.ts:504` reads `tips.remote` from the remote-tracking ref even when `ls-remote` showed no tracker, and `:554-562` adopts its root.
- In sync, `src/tracker/sync.ts:367` sets `remoteTip = refs.remotes.get(remote)` whatever `tracker` is (null when the remote has none), and folds it in.
- `dropStaleRemoteTracker` (`src/installer/preflight.ts:144`) runs only for `--new-tracker`.
- Effect: a tracker deleted from the remote (the uninstall's printed delete command) comes back from any clone's stale ref.

**3.6 medium (freezes at publish): UPGRADE_REQUIRED `details` has three shapes**
- Spec §5/§9: details are `marker` (`store`, `machine` or `install`), `why` (`newer` or `older`), `running`, `pin`, `requires`, and ordered `remedies[]`.
- Core path: `remedies` are objects `{kind, text, command?}` (`src/core/upgrade.ts:12-16, 106`). That is fine, but unrecorded (see §4).
- `init --upgrade`: `remedies: []` always (`src/installer/upgrade.ts:102`), and the compat-raise branch also sends `requires: null` (`src/installer/init.ts:610-617`).
- `uninstall`, for an unknown manifest kind: `marker: 'manifest'`, `why: 'unknown: …'` and `remedies: [<string>]` (`src/installer/uninstall.ts:284-291`). The marker and why values are outside the enum, and the remedies are strings, not objects.
- Fix: one shape everywhere. Give uninstall's case its own code, or record `marker: 'manifest'`.

**3.7 medium (liveness): the runner can hang forever while holding the clone-wide `runner` lock** (followups 264)
- Spec §16: runner caps, one run per machine.
- Code: `src/runner/process.ts:50-62` resolves only on `close`. If the child exits but a grandchild still holds its pipes, the kill timer's `killTree` returns at once because `exitCode` is set (`src/git/run.ts:82`). `close` never fires, so `runChores` never returns and `locks.acquire('runner')` (`src/runner/run.ts`) stays held. Every later `chore run` and the `start` trigger then get NOT_DUE.
- Fix: resolve on `exit` after a short drain timeout.

**3.8 medium (fail-open): Attention can say "Nothing needs you" while items are hidden** (GOK-163/170, §20)
- Spec §20: Attention lists "only what a human must unblock … The empty state reads 'Nothing needs you…'".
- Code: `src/core/attention.ts:248` and `:250` turn a failed stray-edit read or knowledge read into empty lists, with no marker. `src/surfaces/dashboard/attention.tsx:78` then shows the empty state while a pending proposal, a fork, a set-aside pair or a stray edit exists.
- Fix: return `unreadable: [...]` and suppress the empty state when it is set.

**3.9 medium (freezes at publish): the §10 verb `purge proposal` is `proposal purge`**
- Spec §10 (Human issue ops): `purge trace`, `purge session`, `purge proposal`.
- Code: the op is `proposal_purge` (`src/core/proposals.ts:694`). `resolveVerb` (`src/surfaces/cli/args.ts:163-173`) looks up `purge_proposal`, then `purge`, finds neither, and exits 2. `VERB_ALIASES` (`args.ts:26`) holds one-word aliases only.
- Fix: add the alias (or rename the op) before 1.0.0.

**3.10 low: a lost push race is reported to people as a refusal**
- Spec §4: "sync status records the failure class (auth, network or rejected)".
- Code: a lost race is stored as `class: 'rejected'` (`src/tracker/sync.ts:409`). `syncSummary` then says "the remote rejected the push" (`src/core/sync.ts:420`, `:468`), and `syncFix` points at "a branch protection rule, a ruleset or a server hook" (`:438`, `:518`), when the remote was only busy.

**3.11 low: an edge case where a genuine refusal reads as a lost race**
- This answers the PRIORITY question in followups 209.
- Mostly fine: hook, protected-branch, ruleset and D/F refusals classify as null and fail on the first push (`src/tracker/remote.ts:183-193`). Auth fails as `auth`. A non-fast-forward against an unmoved remote stops after `UNMOVED_REJECTIONS = 3` (`sync.ts:147`, `:307-310`).
- Residual: if the push URL refuses (via `pushurl`/`pushInsteadOf`) while the fetch URL's repo keeps moving, `unmoved` resets every round. All 10 rounds run and end as `lostRace`, with no backoff, on every automatic sync.

**3.12 low: the push-time text strip treats only the chosen remote as pushed**
- Spec §3: "Pushed history is never rewritten." Spec §14: "Pushed text stays."
- Code: `stripUnpushed`/`stripUnpushedText` (`src/tracker/store.ts:474`, `:517`) exclude only the chosen remote's tip. `dropUnpushed` (`:537`) and `unpushed()` (`:448-450`) exclude every remote, so commits already pushed to a second remote can be rewritten.

**3.13 low: the reflog expiry removes more than the rewritten commits**
- Spec §3: "the tracker reflog entries for the rewritten commits are expired".
- Code: `git reflog expire --expire=never --expire-unreachable=now refs/grimoire/tracker` (`store.ts:573`) drops every unreachable entry. After `init --new-tracker` that includes the whole old tracker, which breaks init's own promise that "the old history stays in this clone's reflog" (`src/installer/init.ts:518`).

**3.14 low: `chore_submit` idempotency ignores the result**
- Spec §9: `IDEMPOTENCY_MISMATCH` when "a key [is] reused with a different fingerprint".
- Code: the fingerprint is `{run}` only (`src/core/chore-submit.ts:215`, `:400`), and `:185` replays a stored refusal for the same key whatever the new result. A fix-up sent under the reused key is never checked.

**3.15 low: a compiled page can be created citing nothing**
- Spec §16: compile "keeps each page's `sources`", and "only served items may be cited".
- Code: a created page that no map entry names is written with `sources: []` (`src/knowledge/chores/compile.ts:216`), with no later check.

**3.16 low: `knowledge/wiki/log.md` bytes can differ between clones**
- Spec §3/§17: the log is derived. Derived files must be deterministic, or every fold churns them.
- Code: `src/tracker/fold.ts:255-262` takes side a's records then side b's, unsorted. `renderWikiLog` (`src/tracker/wiki.ts:513`) breaks ties on equal `at` by that index. The draft path sorts by `byAt` (`src/tracker/chore-runs.ts:200`, `:259`).

**3.17 low: `init --upgrade` asks more than "one consent"**
- Spec §21 Step 1: "plan and one consent".
- Code: `src/installer/init.ts:668` still asks "Restore them?" for permission entries during `--upgrade` (there is no upgrade guard).
- Also, `init --upgrade --json` without `--yes` (a dry run) that needs a compat raise gets an INVALID refusal instead of a plan (`init.ts:604` keys on `!prompter`).

**3.18 low: reconsidering a proposal dismissed while stale commits a decision that changes nothing**
- Code: `src/core/proposals.ts:671` allows it. The status reads `stale` afterwards (`src/knowledge/proposals.ts:90-91`).

**3.19 low: scorecards count an unversioned read as "offered, not read"**
- Spec §18: "`facts_complete = false` read as 'read unknown'". Spec §14: a lone `Skill` call has `version: null`.
- Code: `src/knowledge/scorecards.ts:107-117` counts a lone Skill call (version null) or an `unknown`-version read with complete facts as offered, not read. It should be "read unknown".

**3.20 low: `chore run` shows the policy `human-read` in help**
- Spec §10: its gate is "refuses agent markers". Spec §7: human-read means ops that carry text.
- Code: `src/surfaces/cli/args.ts:348`. The real gate (`src/surfaces/cli/runner.ts:130-132`) is right.

**3.21 low: the excerpt disclosure is shown only after the setting change commits**
- Spec §20: "excerpt mode (re-shows the disclosure)". Spec §14: loosening "re-shows the disclosure".
- Code: `src/surfaces/dashboard/settings.tsx:207-211` shows `result.disclosure` after `settings_set`. The confirm dialog (`:119-129`) has only the short warning. The CLI has the same order.

**3.22 low: uninstall reports contradictory or wrong things**
- `src/installer/leave.ts:551-552` and `:404`: when uninstall also leaves, the just-uninstalled checkout is reported as "still pins grimoire", and leave "never changes the host repo".
- `src/installer/uninstall.ts:375-377`: stray edits already saved machine-locally are listed as "uninstalling loses them".
- `src/installer/removal.ts:583`: a kept dotfolder file is reported a second time as "grimoire didn't write it".

**3.23 low: tightening the excerpt mode doesn't refresh the dashboard's attempt views**
- Spec §20 live events.
- Code: `src/tracker/ops.ts:47` maps `settings-set` only to `settings`, but the commit also strips open attempts' records. Attempt and trace views keep showing the stripped text until reload.

**3.24 low: `purge_trace` leaves earlier session tombstones behind**
- Code: `src/tracker/view.ts:798-819` leaves `purges/<attempt>/<key>.md` tombstones that carry kept facts, and doesn't drop them from the unpushed segment.

**3.25 low: a Skill Proposer run can loop on BASE_MOVED forever**
- Code: `src/knowledge/chores/propose.ts:376-378`. A create naming an active skill this run wasn't served (for example, one contested by a `suspicious` reject) always throws BASE_MOVED, so the run can never make progress or get a reason code.

**3.26 low: runner status and guard misreport billing; `--due` can lose its report**
- `src/runner/guard.ts:110-113`: a Codex setup with only an API key in env is refused even with `allow_api_billing`. With a ChatGPT login plus an allowed key, it reports `chatgpt` and `bills_api: false`.
- `src/runner/status.ts:12`: the last run's auth method wins over the current config.
- `src/runner/run.ts:126`: an error in a later `--due` iteration drops the report of runs that already succeeded.

**3.27 low: admission edge cases and a CLI positional bug**
- `src/knowledge/chores/admission.ts:112-121`: a Claude shell is recognised by `ctx.client`, not by `CLAUDE_CODE_SESSION_ID`.
- `src/knowledge/chores/serving.ts:548-552`: an oversize item is pushed with its text dropped.
- `src/surfaces/cli/args.ts:38`: `quarantine --trace <h> "<reason>"` maps the reason to `page`, so it gets INVALID.

**3.28 low: commit facts miss some creations and over-match co-authors**
- Spec §14 Commits.
- `src/capture/commit-facts.ts:65` misses `git -C "<path with spaces>" commit`.
- `:366` counts any co-author named Claude*/Codex* or any address at `@anthropic.com` as an agent.

**3.29 low: live-process checks fail open**
- `src/machine-local/processes.ts:158` swallows every `readdir` error, so liveness checks such as `pruneCopies` see no live processes.
- `ProcessRecords.prune()` is never called, so records of hard-killed processes accumulate, though the doc comment says they are "pruned as such".

**3.30 low: the slot create falls back to non-atomic writes on NTFS too**
- Code: `src/machine-local/fs-atomic.ts:84`. `NO_HARD_LINKS` includes `EPERM` on every platform, so on NTFS a hard link held up past 3 s falls back to the non-atomic `open('wx')`. That contradicts the comment at `:90-92`. A crash there leaves a 0-byte generation that holds the lock for 30 s.

**3.31 low: a forced skill refresh throttles pointer refresh**
- Code: `src/upkeep/run.ts:299` writes the shared per-worktree stamp after a skill-reconcile-only forced refresh (`src/upkeep/refresh.ts:27`). Pointer refresh is then skipped for 5 minutes.

---

## 4. Spec amendments to record on GOK-123

These are acceptable divergences, or definitions the spec leaves open, that ship at HEAD and are not among the 7 recorded comments. Every on-disk item freezes at 1.0.0. The source is followups.md (FU line) or this review (R).

### §1 Packaging
1. markdown-it and diff are not bundled. The dashboard uses its own inert `markdown.tsx` and DiffView. `dist/THIRD_PARTY_LICENSES.md` lists only MCP SDK core/server (Apache-2.0), zod and preact. (FU 340)
2. There is no CI in 1.0.0, and the Node 22 floor is unverified. A GitHub Actions matrix plus trusted publishing comes in 1.0.1. `publishConfig` is `{access: public}` with no provenance. (FU 309, 339; recorded only on GOK-172)
3. License MIT, pending advisor confirmation. (FU 338)

### §3 Tracker store format
4. **Store settings line format:** `settings.yml` holds `key: {"value":…,"at":…,"by":…}`, one line per key, sorted (`src/tracker/settings.ts`). (FU 7; R)
5. **Store setting key catalog** (`src/core/settings.ts`):
   - `excerpts`, `auto-sync`, `link_base`;
   - `skills.delivery`, `skills.max_active` (8), `skills.description_max` (300);
   - `knowledge.loop`;
   - `chores.settle_hours`, `chores.compile_pairs`, `chores.compile_fails`, `chores.compile_wait_days`, `chores.batch_pairs`, `chores.batch_fails`, `chores.batch_passes`, `chores.strikes`, `chores.propose_fails`;
   - `proposals.pending_limit` (1).

   Note the hyphenated `auto-sync`, while `link_base` uses an underscore. (FU 31, 34, 40, 156; R)
6. **Attempt directory gains `conflicts/<sha256>.md`:** a fold's set-aside seal, when two clones ended one attempt differently, goes to `attempts/<a>/<b>/<issue>/<attempt>/conflicts/<hash>.md` (`src/tracker/fold.ts:421-422`). §3 lists no `conflicts/` in the attempt directory. The GOK-138 comment records the rule, not the path. (FU 20; R)
7. **`start.md` keys**, in order: `assignee`, `actor`, `opened`, `at`, `start_commit`, `wiki_exposed`, `delivery` (`on`/`off`), `skills_offered`. `skills_offered` holds `[{name, version} | {name, version:"unknown", hash} | {name, version:"missing"}]`. Both are absent on a human assign (`src/tracker/attempt.ts:166-180`). (FU 105)
8. **`end.md` keys:** `ended`, `ended_by`, `at`, `debrief` (comment id), `worker_kind`, `wiki_exposed`, `field_changes`, `commits` (always written), and `requested` (on a `superseded` seal, the ending the call asked for; replays match on it) (`attempt.ts:216-228`). (FU 178; R)
9. **Commit fact shape**, in `end.md` and session records: `{hash, via: "observed"|"referenced", session?, context?, at, subject, files, added, removed, agent_skill_edit?, agent_assisted?}`; bare `{hash, via…}` when the clone lacks the commit.
   - Known agent co-authors: a name starting with Claude or Codex, `@anthropic.com`, `codex@`/`noreply@openai.com`.
   - Reflog creating subjects: commit, initial, amend, merge, cherry-pick, revert, plus git-made merges (`merge <x>:`, `pull:`); never rebases.
   - Snapshot counts are taken against the first parent. (FU 178, 190)
10. **`activity/` also holds `update` entries** `{actor, at, kind: "update", attempt?, fields}` for field changes. §3 says only "points at the blobs of comments". A comment made on a deleted issue lives only as a blob in the attempt's `activity/` (`attempt.ts:283-301`; `src/tracker/view.ts:883-920`). (R)
11. **Session record key list**, in order: `client`, `client_version`, `reader_version`, `session`, `context`, `source`, `window_start`, `window_end`, `steps`, `steps_kept`, `characters`, `excerpt`, `excerpt_notes`, `facts`, `skills_read`, `commits`, `reach`, `cut_at`, `roots`, then the body = excerpt text (`src/capture/session-record.ts:79-99`).
    - `skills_read` is `[{name, version (sha | "unknown" | null), via: file|shell|skill|skill_read, at, session, context}]`.
    - A record's body keeps CRLF verbatim; only CR in the frontmatter is non-canonical. (FU 61, 105; R)
12. **Purge tombstones:**
    - `purges/<attempt>.md`, `purges/<attempt>/<session-key>.md` and `purges/<pp-id>.md`, with frontmatter `by`, `at`, `reason`.
    - Session tombstones add `facts: "kept"|"purged"`. A facts-kept tombstone's body is the session record without text (excerpt `purged`). `purged` dominates `kept` in a fold.
    - The snapshot drops what a tombstone names even if the tree holds it. (FU 131, 146, 244)
13. **Proposal records:** `knowledge/proposals/<pp-id>.md`.
    - Body = the whole proposed SKILL.md; `version` is its sha256; `after` = the skill's ledger heads at drafting.
    - Statuses are derived: pending, stale, accepted, rejected, dismissed, lapsed, undone, contested, superseded.
    - Id prefix `pp-`. (FU 156)
14. **Chore-run records:** `knowledge/chore-runs/<a>/<b>/<cr-id>.md`, including `resolved` (`<slug>/<side id>`). Summary format: `grimoire chores: compile done, N traces, M pages (c created, u updated)[, k conflicts resolved]; run <id>`. (FU 128)
15. **Skill ledger keys**, in order: `kind`, `skill`, `proposal`, `reason`, `note`, `acks`, `from`, `to`, `after`, `saw`, `basis`, `surface`, `actor`, `by`, `clone`, `at`.
    - Kinds: `accept`, `reject`, `dismiss`, `reconsider`, `edit`, `record`, `restore`, `delete`, `eject`, `acknowledge`, `unblock`, `lapse`, `quarantine-mark`, `quarantine-clear`.
    - `lapse` = an accept whose accept-time checks failed (`reason` = comma-joined codes).
    - reject/dismiss/reconsider/lapse records carry `to` = `from`.
    - `note` holds a reject `other`'s text, secret-scanned.
    - Proposals and versions live in their own directories rather than as ledger kinds (`src/knowledge/ledger.ts:16-97`). (FU 244; R)
16. **Red-flag ids:** a stored risk flag's name, `token:<token>`, and `evidence`. Accept refuses with INVALID `{fields.acks, red_flags}` until each one is acknowledged. Reject reasons follow the spec list, including `not-worth-it`. (FU 244)
17. **Commit message format:** subject `grimoire: <op>[ <issue>]`.
    - `Grimoire-Actor` keys, in order: `kind`, `client`, `session`, `context`, `call`, `spawn_env`, `nonce`, `chore_exposure` (`src/core/context.ts:103-149`; `store.ts:838-847`).
    - `Grimoire-Op` vocabulary (`src/tracker/ops.ts:18-50`): create, update, comment, claim, release, close, assign, reassign, reopen, delete, resolve, `outcome-set`, accept, reject, dismiss, reconsider, `skill-edit`, record, discard, restore, `skill-delete`, eject, acknowledge, unblock, `wiki-edit`, compile, propose, quarantine, unquarantine, `settings-set`, fold, init, purge, capture.
    - A sweep's capture commit carries no Issue or Attempt trailer.
    - Reflog messages: `grimoire: write`, `grimoire: sync`. (FU 31, 33, 97, 156, 299; R)
18. **Ids:** run ids `cr-…`, proposal ids `pp-…`, archive tag `refs/tags/grimoire-tracker-archive`. (R; FU 315)

### §4 Writes, reads, folds, sync
19. The merged excerpt mode is applied at push (the unpushed segment is rewritten before it leaves), not inside the pure tree fold. A fold committed by an ordinary local write keeps local unpushed text until the next push. This deviates from "every fold and every push applies the merged excerpt mode" (`src/tracker/sync.ts:390`; `fold.ts` has no excerpt handling). Record it, or fix it. (FU 97, 109)
20. A push that loses the race in all 10 jittered rounds is recorded as a lost race (`lostRace: true`) with no backoff. "Failures back off exponentially" applies to auth, network and rejected only. A non-fast-forward against an unmoved remote counts as a refusal after 3 rounds (`sync.ts:147`, `:307-310`, `:419-420`; `core/sync.ts:193-203`). (FU 155, 235)
21. The fairness lock (`locks/tracker-write`) is advisory and not FIFO: a random 20–60 ms poll. The in-process turnstile is FIFO. At about 160 concurrent writers, starvation can give BUSY. The FIFO lock is deferred past v1. (FU 33, 47, 69)
22. Only configured remotes plus `git config grimoire.remote` count as tracker remotes. Remote choice uses `grimoire.remote`. (FU 33, 45)
23. `init --new-tracker` moves the ref with no old value (it doesn't compare-and-set). This is reachable only after the typed confirmation. (FU 72)

### §5 Version markers
24. **UPGRADE_REQUIRED `remedies` are objects** `{kind: rebase|upgrade|join|init|restart, text, command?}` (`src/core/upgrade.ts:12-16`). Make every caller use this shape first (finding 3.6).
25. **`config.yml` keys:** `version: <pin>` as a top-level line, `install_format: 1`, `tracker_root: <sha>` (the spec's "root R"), and `adapter: grimoire|declined`, absent when never asked (`src/installer/config.ts:54-61`). (FU 34, 42)
26. A compat raise is detected and planned (`compat-raise`), but v1 ships no migration. Interactive `init --upgrade` refuses with UPGRADE_REQUIRED "ships no migration", and `--yes` refuses with INVALID. (FU 196)

### §6 Machine-local data (frozen at 1.0.0; the coordination class by §21)
27. **Layout** (`src/machine-local/store.ts:19-36`):
    - `format`;
    - `leases/<name>/<gen>.json` and `locks/<name>/<gen>.json`;
    - `processes/<pid>-<nonce>.json`;
    - `coordination/<kind>/<key>.json`;
    - `records/<kind>/<key>.json`;
    - `caches/<name>.json`;
    - `records/generated-paths.txt`;
    - `pkg/<v>/`, `pkg/.trash/`, `launcher.cjs`.

    A name or key that isn't `^[a-z0-9_-][a-z0-9._-]{0,79}$` (or that is a Windows device name) becomes `~` plus the first 40 hex chars of its sha256 (`names.ts`). (R)
28. **Lock and lease holder format** (slots):
    - The highest generation `n` holds the lock. Take, renew and release each create generation n+1 exclusively, then prune the lower ones.
    - The holder JSON requires `owner`, `pid` and `host`. `name`, `start_time`, `acquired_at`, `expires_at`, `released_at` and `data` are optional.
    - The lock is free when `released_at` is set, `expires_at` has passed, or (same host) the pid is dead or its start time differs.
    - An unreadable holder is held for 30 s from its mtime (`UNREADABLE_GRACE_MS`). (R)
29. **Lock names:**
    - `tracker-write` (the fairness lock), `install`, `start` (data `{port, nonce}`), `runner`, `chore-start`, `chore-run/<run>`;
    - `records/<kind>`, `coordination/<kind>` and `records/generated-paths`.

    **Lease names:** `sync`, `upkeep-<part>` (parts `pointer-refresh`, `prune-copies`, `pending-sync`, `excerpt-sweep`, skill reconcile), and the worktree lease `worktree:<worktreeKey>`. (FU 11, 49, 51; R)
30. **Coordination kinds:**
    - `seen-here`, keyed `<handle>/<sessionKey>`, and gaining `swept`;
    - `sync-pending`, keyed by tip, `{tip, at}`;
    - `upgrade-in-progress`, keyed by worktreeKey: `{worktree, from, to, started_at, token?}`;
    - `runner/counters` (rolling 24 h, `paused_until`, `auth_method`);
    - `upkeep-runs`: throttle stamps `{at, pid, version}`, keyed by part or `worktree:<key>`. §6 doesn't list this one under coordination. (FU 44, 49, 214, 247)
31. **Process records** `{pid, start_time, host, nonce, role, client, worktree, pin, node, path_source, registered_at}`. Roles are `mcp`, `start`, `sync`, `init`; role `init` is registered from before init installs its copy until its upkeep ran. Records from another host count as live. (FU 44, 49, 224)
32. **Records kinds:**
    - `join/<pin>`: `{excerpt_mode, codex_hook_hash, joined_at}`;
    - `machine-settings`;
    - `runner-config/runner`;
    - `runner-logs` (newest 20) — new;
    - `stray-edits`;
    - `chore-exposure`, keyed `<basis>/<id>` and pruned after 30 days;
    - `skill-reads` (append);
    - `chore-runs` (open runs), `chore-served` (served-item logs, including `no_pattern`), `chore-results` (`<run>/<n>`, invalid result texts);
    - `sync-status/tracker`;
    - `transcript-roots`, keyed by session. This is also the Codex "session-start mark";
    - `capture-stats/late-cut-drops` `{count, last_at, last[]}`;
    - `client-runtime`, keyed by client: `{client, node, path_source, pin, worktree, at}` — new;
    - `pointer-refresh`, per worktree: `{worktree, paths, at}` — new;
    - `moved-aside` (folders upkeep moved into the store) — new;
    - `clone/tag` (the clone tag in ledger `clone`) — new.

    (FU 40, 49, 60, 97, 197, 225, 247; R)
33. **Caches:** `served-set` and `copy-state-<sha24 of worktreeKey>`. (R)
34. **`pkg/<v>/.complete`** is `{integrity, files: {<posix path>: sha256}}`. doctor checks a copy against it. (FU 60)
35. **Machine-setting key** spellings as in §6. `dashboard.port` defaults to a port derived from the clone. (R)

### §8 MCP surface (additive wire extras that freeze)
36. **Result extras:**
    - A top-level `notices: string[]` on any result, errors included, so an error is `{error, notices?}`.
    - `skill_list` returns `{skills: [...]}`, because structuredContent must be an object.
    - `skill_read` takes `cursor?` and may return `truncated`/`cursor`.
    - ALREADY_CLAIMED details are `{open_attempts: [...]}`, and the rows add `stale`.
    - `show` adds `body_from` and `past_attempts[].conflict`.

    (R, from `src/surfaces/mcp/result.ts:41`, `src/core/skills.ts:84-96, 134`, `src/core/attempts.ts:54-67`)
37. **The reserved hint key** is `_grimoire` and carries no `transcript_path` (spike A override). Codex's fallback session is `_meta['x-codex-turn-metadata'].session_id`. (FU 26)
38. **The pin-mismatch SessionStart line** (§12 priority 2) uses §8's wording, from a live `mcp` record of this client on another pin, and is skipped on `source: startup`. (FU 292)
39. **The chore session line plus proposal note** drops the pickup text's final period ("…don't run it unasked; 1 skill proposal awaits review"). (FU 279)

### §9 Error table
40. **BUSY beyond the §9 row.** Either record these or recode them:
    - the per-session chore lock and chore-start lock (`src/core/chores.ts:294, 307, 321`; reachable from MCP, details `{}`);
    - a local git silent for 5 s, killed as stuck (`src/git/run.ts:53-69, 196-206`);
    - the install lock `{holder}` (`src/installer/lock.ts:19`);
    - init's locks (`init.ts:924, 935, 941`);
    - leave/uninstall live processes `{processes:[{pid, role, client, worktree, pin}]}` (`leave.ts:232`, `uninstall.ts:151`). These say `retryable: true`, but retrying doesn't help;
    - `start` with no free port of 10 (`src/surfaces/start/run.ts:245, 277`; `server.ts:339`). (FU 86, 225; R)
41. **NOT_FOUND / NOT_ISOLATED / RUN_SUPERSEDED for chore runs:**
    - an unknown run → NOT_FOUND;
    - a run already ended (abandoned or expired) → NOT_FOUND `{run, state}`. RUN_SUPERSEDED only when a newer run started;
    - an unknown item → NOT_FOUND `{item}`;
    - another context's run → NOT_ISOLATED.

    (`src/core/chores.ts:329-377`; `src/core/chore-submit.ts:184`)
42. **`start` and `open`:** NOT_FOUND `{start: null}` (no running start), INTERNAL (control channel unreachable, no browser opener; `start/run.ts:200, 219, 223`), and `sync.ts:446` INTERNAL. (FU 86)
43. **Runner refusals:**
    - INVALID: `details.fields.runner` (none enabled); `details.fields.preflight='refused'` plus `details.preflight {kind, auth_method|variables|mcp_list}`; unconfirmed typed confirmations `fields.confirmation`.
    - NOT_DUE: `next_run_at` (daily cap), `paused_until` (6 h pause), a runner run in progress.
    - "6 runs a day" means any rolling 24 h. `chore run --due` with nothing due exits 0 with `{runs: [], why}` and starts no client.

    (FU 247)
44. **NOT_SYNCED from init** for an unreachable remote or a root mismatch `{local_root, remote_root, remedy}` (`init.ts:266, 511, 540-584, 854`). (R)
45. **PENDING_LIMIT** is reused for `proposal_reconsider` while the pending slot is full (`src/core/proposals.ts:674`). (FU 245)
46. **A Codex T6-fallback binding call** (no call id, matched by tool and time) that fits no parsed call gives `unmatched`. `unreadable` stays for calls named by id. (FU 23)

### §10 CLI
47. **The extra verbs** in 2.1 and the flags `runner enable --model/--binary` and `init --from`. Internal entry verbs (`mcp`, `hook`) don't answer `--help`. (R; FU 41)
48. **`grimoire purge proposal`:** either alias it (finding 3.9) or record `proposal purge`. (FU 255)

### §11/§12 Runtime, init, start
49. **New manifest schema fields:** `.grimoire/manifest.yml` = a comment line, `format: 1`, `entries:` with one JSON-object line per entry `{path, kind, key?, item?, hook?, marker?, hash: "sha256:…", created, client?, permission?}`. Plus `.grimoire/.gitattributes` = `* text=auto eol=lf` (`src/installer/manifest.ts:1-56`). (R)
50. **The control-channel protocol 1:**
    - Pipe `\\.\pipe\grimoire-<clone>-<nonce>`, or a socket `<clone>-<nonce>.sock` in a 0700 directory.
    - Secret at `%LOCALAPPDATA%\grimoire\control\<clone16>.secret`; HMAC-SHA256 framing as in `src/surfaces/start/control.ts:1-46`.
    - Ops `sign-in` `{ref?}` → `{url, port, version, pin, pid}` and `stop`.
    - An unknown op answers `{error:{code:"UNKNOWN_OP", message}}` (`start/run.ts:394`); a failure answers `INTERNAL` (`control.ts:243`). Both have no `retryable`/`details`. (R)
51. **`start`/`open` stdout:** `started`, `running`, `opened`. `start` watches the worktree registry every 5 s and runs upkeep for a newly pinned worktree. (FU 87; R)
52. **Codex day-folder search** (§14 Roots, superseded by spike E): the thread's UUIDv7 creation day ±1, then `archived_sessions/`, then day folders up to the call's day +1, newest first. (FU 22)
53. **The `--upgrade` skip line** reads "…or discard with `git restore`, then `npx @goksening/grimoire@<from> init --upgrade`". The upgrade record gains `token`. (FU 195, 214)
54. **Chore carriers:**
    - The Claude chore skill's description gains "When the user asked for this run, pass manual as the argument.", plus `argument-hint: manual` and a body line "This run's arguments: $ARGUMENTS".
    - The Codex skill names a second spawn message for a run the user asked for.
    - Procedure step 1 treats `manual` as the explicit request.
    - The Codex role is `.codex/agents/grimoire-chores.toml`. (FU 278, 293)

### §14 Trace capture
55. The record-replacement rule is implemented as described, plus `cut_at` and dropping late records. A side with no `end.md` whose record's `cut_at` is later than the other side's `end.at` is dropped, and the drop is counted. (FU 97)
56. A record's facts are `partial` when a cut found no window (every binding call is past the flushed end). Grimoire-chores contexts get no session record. (FU 58; R)
57. doctor gains a section `capture` with checks `capture.stats` (late-cut-drops, unreadable, unmatched) and opt-in `capture.readers` (`--readers`, newest 200 transcripts per client). (FU 178, 179)

### §16 Chores and runner
58. A compile may map pairs to an existing served page it doesn't rewrite. Those traces are added to the page's `sources` as a sources-only write, which counts against the 8-page cap (`src/knowledge/chores/compile.ts:303-308`). (FU 130)
59. **Runner storage paths** `coordination/runner/counters`, `records/runner-config/runner` and `records/runner-logs`. R6 option (a): join in the cloud setup script, plus a first `grimoire status` run by hand (`docs/runner.md`). (FU 247)

### §18 Gating
60. **"Changes ≤50% of lines"** = max(removed, added) lines over the base's line count. **Near-identical** = 2·LCS/(|a|+|b|) over normalized change lines (trimmed, whitespace-collapsed, lowercased, non-blank) (`src/knowledge/chores/propose.ts:49, 434`). (FU 159)
61. **Token origins:**
    - "commits" = messages and diffs in `<baseline>..HEAD` of the checking checkout;
    - "debriefs" = the cited traces' debriefs;
    - network URLs can't be added (hygiene), so URL origins only ever see loopback URLs. (FU 160)
62. "Delivery-off attempts shown separately" = relevant traces (that offered or read the version) opened with delivery off (`scorecards.ts:110`). (FU 107)
63. Restoring an ejected skill is refused; bringing it back takes unblock plus skill edit. A dropped accept's proposal still reads `accepted`. Restore, delete and eject need `base` (the current version shown to the human). (FU 300, 306)

### §20 Dashboard (new human-read wire shapes, also reachable by CLI)
64. **`attention`:** items `sync_failure` (auth and rejected only; network failures left out), `id_collision`, `field_conflict`, `open_attempts`, `stale_claim`, `stray_edit`, `pending_proposal`, `skill_fork {choices[{version, standing}]}`, `wiki_conflict`, `set_aside`, `flagged_page`, plus `counts` (`src/core/attention.ts:43-111`). (FU 288, 330)
65. **`activity`** `{entries[{commit, at, op, issue, attempt, person, actor{kind, client, session, context}, fields?}], cursor}`, with inputs `issue`, `limit`, `cursor`. It reads the local tip only (`src/core/activity.ts`). (FU 199, 200)
66. **`attempt_show`, `knowledge_overview` and `chore_runs`** (`{limit?, run?}`; rows carry `kept`, `where`, `unverified`, and `text` only with `run`). **`purge_list`.** (`src/core/attempt-show.ts`, `knowledge-overview.ts`, `chore-runs.ts`, `purge.ts:179-210`) (FU 311, 330)
67. **Field additions:**
    - `sync_status` gains `fix` and `position` `{state, local, remote_tip, ahead, behind}`.
    - `skill_show` gains `acknowledge`, `versions`, `last_change`, `pending_proposal`, `worktrees`, `copies`, `scorecards`, `attention`, and `restore` (a RestorePlan) when called with `{restore}`.
    - `wiki_list` gains `log` and `purged_sources`.
    - `proposal_show` key order = §20 screen order. (FU 106, 245, 299, 311, 330)
68. **Behaviours:**
    - Flagged sibling pages have no "clear flag" op: the flag clears when the trace's quarantine is lifted or the page is quarantined.
    - A refused runner preflight is held only in `start`'s memory (`GET /api/runner` `trigger`).
    - HTTP endpoints as listed in 2.3. (FU 331; R)

### §21 Upgrade, uninstall, leave
69. **leave:**
    - Typed confirmation is the word `leave`.
    - Live processes refuse with BUSY `{processes:[…]}`.
    - The purge offer applies only when leave pushes.
    - leave lists folders that upkeep moved aside and offers to stop so they can be copied out. (FU 225)
70. **uninstall:**
    - Typed confirmation is the word `uninstall`.
    - A grimoire-owned file with uncommitted or untracked drift is kept and reported; committed drift is deleted.
    - An unsafe file (invalid JSON, broken markers, symlink, not text, changed meanwhile) stops the removal before `config.yml`, with the manifest kept.
    - Containers the removal empties are pruned, including pre-existing empty ones (`removal.ts:187-195`).
    - The unknown-kind remedy names the checkout's pin when it is newer, else `@latest`.
    - When the clone stays joined, only live processes in this checkout refuse.
    - Unreachable registered worktrees count as still installed.
    - The remote commands printed are `git push <r> --delete grimoire/tracker` and `git push <r> refs/remotes/<r>/grimoire/tracker:refs/tags/grimoire-tracker-archive && …--delete`.
    - The unpushed-excerpt purge reuses `stripUnpushedText`, not `purge_trace`/`purge_session`. (FU 315, 325, 328)
71. **The frozen cross-pin contract** is pinned in `docs/cross-pin-contract.md` and `test/release/format-freeze.test.ts`. §21 should reference it, and its coordination-class row should carry items 27–31 above. (R)
