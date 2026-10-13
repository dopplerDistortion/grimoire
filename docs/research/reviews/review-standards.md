# grimoire v1 close-out review: STANDARDS

Reviewed at HEAD 3af2e35 (integration/grimoire-v1) against origin/main. The review was read-only: no edits and no test runs.

**Sources.** Standards: docs/contributing.md, the README maintainer section, GLOSSARY.md, ADR 0001-0012 and CLAUDE.md, plus the Fowler smell baseline. A documented standard overrides a smell.

**Labels.** HARD means a documented standard, ADR or spec is breached. JUDGEMENT means a smell or a design call. The rubric puts integrity risks at medium or higher.

**Method.** Six sub-reviewers each took one scope: tracker/sync/write path, knowledge/chores, installer/CLI/runner/hooks, GOK-160/163, GOK-169/170/172, and flakes-5/fast-check/bundle. I deduplicated their findings and re-checked every high and medium finding against the code myself (each file:line below was read at HEAD). Their raw outputs are in review-standards-parts/.

**Line numbers** are as of 3af2e35.

**Counts:** 2 high, 12 medium, 56 low (70 findings; several low items group related sub-points). Verified-fixed follow-ups are listed at the end.

---

## High

1. **[high] [HARD] src/tracker/sync.ts:386-401 with src/tracker/store.ts:529-546 and core/purge.ts: sync's push runs outside the fairness lock, so a purge can report "never pushed" while a sync pushes the pre-purge segment.** (PRIORITY follow-up, STILL OPEN.)
   - Standard: spec §3, unpushed content and the purge contract (`history.pushed` must not say "never pushed" for content the remote is receiving). ADR 0007 says purge rewrites only the unpushed part. This is a lost-update window on the secret-removal path.
   - Evidence:
     - Sync reads `local = refs.local` (sync.ts:365), may run `stripUnpushed` (:390; `rewriteUnpushed` releases the fairness lock on return, store.ts:626), then runs `net(['push', …, \`${local}:${TRACKER_BRANCH}\`])` (:393) with no lock and no sync/purge ordering.
     - A purge in that window rewrites the segment and moves the ref. `dropUnpushed` takes `remotes` from the remote-tracking refs (store.ts:534), and `pushedHolds(drop.remotes, paths)` (:545) can't see the in-flight push.
     - The old sha still descends from the remote tip, so the push lands. The next sync folds the purged content back into the local history.
     - The window is likely in practice: an automatic sync fires right after an attempt-ending write, which is when someone purges a just-ended trace.
   - Fix: put push and purge in order. Either have purge take the machine-local `sync` lease through its write (and explicit sync wait on it), or have sync record the sha it is pushing in a machine-local marker before pushing, which purge treats as pushed (or waits on, then recomputes `pushed`).

2. **[high] [HARD] src/knowledge/chores/compile.ts:186-188 (also :199-206 and the other `continue` exits): a refused Wiki Maintainer result is kept with its secrets, because the secret scan runs after the shape check and the early exits.** (PRIORITY follow-up, STILL OPEN.)
   - Standard: ADR 0005/0006 and spec §16 Failures say the secret scan runs before anything is kept. Fail-open.
   - Evidence:
     - `const shape = shapeOf(result, p); if (!shape) return { ok: false, rejection: p.rejection() };` runs before any scan.
     - `bad_slug`, `duplicate_page`, `unknown_slug`/`unserved` on update, and `unknown_pair`/`duplicate_pair` all `continue` before `pageWriteProblems` scans the text.
     - `rejection.secret` stays false, so chore-submit.ts:305 `...(rejection.secret ? {} : { problems, text: JSON.stringify(result) })` writes the full raw text to machine-local `chore-results`. core/chore-runs.ts:98-101 then serves it in the dashboard via `chore_runs {run}`.
     - propose.ts already calls `scanRaw(result, …)` before its first return.
   - Fix: run a shared `scanRaw` right after parsing and before any return in checkCompile (move it beside `Problems`). Test that a shape-invalid result and a bad-slug result, each holding a secret, keep no text. See also finding 49.

## Medium

3. **[medium] [JUDGEMENT] src/tracker/store.ts:1184-1203, src/tracker/remote.ts:189-192, src/git/run.ts:25-38: the write and sync paths parse git's translated stderr, and nothing forces the C locale.**
   - Standard: contributing.md portability ("nothing may assume POSIX paths or a POSIX shell"). The same kind of hole: Git for Windows follows the UI language.
   - Evidence:
     - `failedMove` matches `/but expected|reference already exists|unable to resolve reference/i` and `/Unable to create '([^']+\.lock)'/`. These are gettext strings.
     - With a German git, a lost compare-and-set falls through to `throw new Error('git update-ref failed…')`. That is INTERNAL, not a retried round or BUSY, under exactly the contention the write path is built for.
     - `cleanGitEnv` sets no `LC_ALL`/`LANGUAGE`. The only `LC_ALL: 'C'` in src is machine-local/process-info.ts:118.
     - The porcelain `[rejected] (fetch first|non-fast-forward)` summaries are untranslated, so that part is safe.
   - Fix: set `LC_ALL=C` and delete `LANGUAGE` in `cleanGitEnv` (at least for the gits whose stderr is parsed). Add a lost-CAS test under `LANG=de_DE.UTF-8`.

4. **[medium] [JUDGEMENT] src/tracker/sync.ts:364-370 and src/installer/init.ts:497-503, 553-563: when the remote has no tracker, sync still folds the stale remote-tracking ref, and a first install adopts it.** (OPEN follow-up from GOK-146.)
   - Standard: integrity. A remote tracker someone deleted is resurrected.
   - Evidence:
     - With listing `tracker === null`, no fetch runs, but `remoteTip = refs.remotes.get(remote) ?? null` (the stale ref) is folded into local and never deleted.
     - init runs `fetchTracker` only when `listing.tracker !== null`, then adopts `localRoot ?? remoteRoot` from the stale `refs/remotes/<r>/grimoire/tracker`.
     - Only `--new-tracker` calls `dropStaleRemoteTracker`.
   - Fix: when the listing shows no tracker, CAS-delete the remote-tracking ref (as `dropStaleRemoteTracker` does) before folding. init ignores `tips.remote` in that case.

5. **[medium] [HARD] src/knowledge/chores/admission.ts:101-107 (with capture/evidence.ts:76-86 and admission.ts:62-66): a Codex `_meta` call carrying only `callId` is admitted with no attempt check.** (Follow-up from GOK-154, STILL OPEN.)
   - Standard: ADR 0006, admission fails closed. This one fails open.
   - Evidence:
     - `mcpCallEvidence` returns `source: 'meta'` with neither `session` nor `context` when only `callId` is present.
     - `classifyCaller` then runs `const root = (session ?? context)!;` (a false non-null assertion) and returns `codex-root` keyed `codex/undefined` with `session: undefined`.
     - `checkAttemptFree` checks nothing, and no exposure mark is written (it needs `rootSession`).
     - `choreContextKey` returns null for the same call, so every later chore_read/submit/abandon is refused with NOT_ISOLATED. The orphaned run counts in `kindsInProgress`, so that chore is not due on this machine for the 60-minute lease.
   - Fix: throw NOT_ISOLATED (or fall to the unidentified/process row) when `meta` evidence has neither id. Drop the `!`. Derive `classifyCaller`'s key and `choreContextKey` from one function so they can't disagree.

6. **[medium] [JUDGEMENT] src/runner/process.ts:50-60 with src/git/run.ts:82: `runProcess` settles only on `'close'`, so a grandchild holding stdio hangs the runner with the clone-wide `runner` lock held.**
   - Standard: integrity/availability. The file header promises "a kill timeout that takes the whole process tree" (spec §16 Spawn).
   - Evidence:
     - If the child exits while a grandchild keeps its pipes open, the timeout calls `killTree(child)`, which returns at once because `child.exitCode !== null`. `'close'` never fires.
     - `runChores` keeps `locks.acquire('runner')`, and every later trigger in a long-lived `start` answers NOT_DUE.
     - On POSIX the child isn't spawned detached, so SIGKILL reaches only the direct child.
   - Fix: settle on `'exit'` plus a short drain timeout, then destroy the stdio. Spawn detached on POSIX and kill the group. On timeout, kill the recorded tree even after the direct child exits.

7. **[medium] [JUDGEMENT] src/machine-local/processes.ts:158: `ProcessRecords.read` swallows every `readdir` error, and `pruneCopies` acts on the empty answer.** (Follow-up from GOK-164, STILL OPEN.)
   - Standard: fail-open check.
   - Evidence: `const names = await readdir(this.dir).catch(() => [] as string[]);`. On EACCES, EMFILE or EBUSY, `live()` returns [], and src/installer/copies.ts:284 `for (const record of await store.processes.live()) keep(record.pin, 'running');` keeps nothing. A copy a live server runs from can then be pruned. leave checks the folder itself; copies.ts, install-checks.ts:523 and session-start.ts:167 don't.
   - Fix: treat only ENOENT/ENOTDIR as "no records" and rethrow the rest, so prune skips. Reporting callers (status, doctor) can catch locally.

8. **[medium] [JUDGEMENT] src/safe-write.ts:121-126: the safe write's byte compare and its rename are two steps, so a file a person saves in between is overwritten.**
   - Standard: lost-update window. Spec §13 asks only for "temp, re-check, rename", so this isn't HARD, but the repo already has atomic primitives for it.
   - Evidence: `const now = … readBytesIfExists(file); … if (!same) return dropped(...); await retryTransient(() => rename(temp, file));`. For `before === null`, `createFileExclusive` (machine-local/fs-atomic.ts:94) gives an EEXIST-safe `link`. For replace, installer/removal.ts:476-503 `deleteIfUnchanged` does rename-aside, compare, restore.
   - Fix: on create, `link(temp, file)` with EEXIST meaning `changed`. On replace, rename aside, compare, link, unlink, and restore on mismatch. At minimum, document the residual window.

9. **[medium] [JUDGEMENT] src/generated/reconcile.ts:191-197: a cross-volume move-aside is copy, then a delete without retry, and a half-done delete is misreported.**
   - Standard: non-atomic multi-step write, outside the advisor's "shared bounded retry at every site" rule.
   - Evidence: `await cp(from, to, …); await rm(from, { recursive: true });`. The `rm` has no `retryTransient` and no `maxRetries`. If it fails part-way (EBUSY on a file an editor holds open), the catch reports "grimoire couldn't move it aside" and returns false. By then the checkout folder is partly deleted, the full copy sits in `moved-aside/`, and no MOVED_ASIDE record is appended, so the person can't find it. This path runs whenever the worktree is on another volume than the git common dir.
   - Fix: wrap the delete in `retryTransient`. If it fails after the copy succeeded, append the record and report a partial move naming `to`.

10. **[medium] [JUDGEMENT] src/surfaces/start/run.ts:465-478 with src/runner/trigger.ts:144-150: when `start` stops mid-run, the runner child is left running unbounded, and the core closes under `runChores`.** (Follow-up from GOK-169, STILL OPEN.)
    - Standard: timers and processes need bounds. Spec §16's 15-minute kill timer lives in this process (runner/process.ts), so it dies with `start`.
    - Evidence: `await runner.stop()` races the run against a 2 s timer, then `closeServer()`, `control.close()` and `closeCore()` run while `runChores` may be inside `core.call('chore_submit')`. runChores takes no AbortSignal. The child isn't detached, but nothing kills it: it keeps billing the person's plan, its result is lost, and the machine-local run stays open until it expires.
    - Fix: give runChores an AbortSignal that `stop()` fires and that `killTree`s the child, or kill the active child after the wait and before `closeCore`.

11. **[medium] [JUDGEMENT] src/core/knowledge-overview.ts:110-125, src/core/attention.ts:166-186, src/core/chores.ts:472-486 (knowledgeFacts): three copies of the pending-proposal and knowledge summary, and they already disagree.**
    - Smell: Duplicated Code / Divergent Change.
    - Evidence:
      - Each calls `dueChoresIn`, filters and sorts pending proposal states, and computes `age_hours: Math.max(0, Math.floor((now - Date.parse(at)) / HOUR))`. attention.ts:179 writes `3_600_000` inline.
      - Each repeats the `loop: due.paused ? 'paused' : 'on'` and pickup and set-aside mapping.
      - status's `knowledgeFacts` counts `record.flags` (drafting-time risk flags), while overview and attention count `red_flags` from `flagsOf` (live, including the evidence flag). So `grimoire status` and the dashboard show different flag counts for one proposal.
    - Fix: one `pendingProposalSummaries(view, book, quarantine, now)` and one set-aside mapper in core/chores.ts, used by all three. Pick one meaning for the flag count.

12. **[medium] [JUDGEMENT] src/core/attempt-show.ts:181-190: the attempt page computes "what cites this trace" with its own copy, which disagrees with purge_trace, and it feeds the purge confirmation.**
    - Smell: Duplicated Code with a divergent copy, on a human-gate confirmation (ADR 0005).
    - Evidence: `knowledgeOf` filters proposals only by `proposal.traces.some((t) => t.trace === handle)`. `citingProposals` (core/proposals.ts:718-723), which purge_trace uses (purge.ts:122), also counts `citations` entries `trace:/issue:/debrief:/excerpt:<h>/…`. The pages filter is a verbatim copy of purge.ts `citingPages`. attempt.tsx:500 hands `shown.knowledge` to `purgeTraceDialog`, so the typed-id confirmation can say nothing cites the trace while purge_trace then answers with a non-empty `cited_by.proposals`. Proposals are also still shown without status (GOK-163 LOW, open).
    - Fix: export one `citingPages`/`citingProposals` and call it from attempt_show. Add each proposal's status via `proposalStates`.

13. **[medium] [JUDGEMENT] src/core/activity.ts:171-172 and src/core/attempt-show.ts:241, 274: history reads walk only the local tip while the view beside them is a fold of both tips.** (Follow-up from GOK-160, STILL OPEN; the same gap now also exists in attempt_show.)
    - Standard: a read that contradicts itself (ADR 0007: reads show the merge of local and fetched tips).
    - Evidence:
      - `activity` uses `tip = tips.local ?? tips.remote`. `exposureHits(root, view.tip, …)` and `outcomeHistory(root, view.tip, …)` use `view.tip`, which is documented as "the local tip of a fold" (tracker/view.ts:300), while `view.parents` holds both.
      - `outcome` (from the folded view) can be missing from `outcome_history`, breaking its own documented rule ("the last is the current one").
      - The path-limited `git log -- <file>` has no `--full-history`, so history simplification at two-parent fold commits can drop one side's verdicts.
    - Fix: log over `view.parents`, add `--full-history` to the path-limited walk, and pin the activity cursor to the parents.

14. **[medium] [JUDGEMENT] src/core/activity.ts:182-190: an update committed on a folded view is credited with the other clone's field changes.**
    - Standard: wrong attribution in the human audit trail (GLOSSARY: Actor, "as observed by grimoire").
    - Evidence: `before` is read from `${entry.commit}^`, the first parent. A write on a fold commits with the local tip first, so `^` is the pre-fold local state, and `COMPARED.filter(before[f] !== after[f])` includes fields the remote side changed. Example: Bob retitles on clone B, then Alice's label update folds it in, and the feed says "alice changed the labels, the title".
    - Fix: for multi-parent commits, compare against the folded parents' state, or record the changed fields at write time (in a trailer) and read them back.

## Low: tracker, sync, write path

15. **[low] [HARD] src/tracker/sync.ts:390: `stripUnpushed(tracker, …)` excludes only the ls-remote tip, not the tip just fetched, so it can rewrite commits the remote already holds.**
    - Standard: spec §3/§4 "pushed history is never rewritten", and SyncHost.stripUnpushed's own doc.
    - Evidence: if another clone pushes T2 between ls-remote and fetch, the fold merges T2 but the strip excludes only `^T1`. T2's text-bearing commits are rewritten, the push is non-fast-forward, and the next round folds duplicates back in.
    - Fix: pass `tracked` (the post-fetch remote-tracking tip), or exclude both.

16. **[low] [HARD] src/tracker/store.ts:1157-1159, src/git/refs.ts:131-138, 372-373: `init --new-tracker` moves the tracker ref with no compare-and-set, and merge 11e8170 gave `null` a fail-open meaning in the shared git layer.** (RefUpdater follow-up, STILL OPEN.)
    - Standard: ADR 0007 (every tracker ref move is a CAS). Primitive Obsession: `null` means "must not exist" in SyncHost.updateRef (sync.ts:101-106) and "whatever it holds" in RefUpdater.update.
    - Evidence: `createRef(…, replace)` passes `replace ? null : zeroOid(...)`. The merger widened `update(ref, next, old: string)` to `string | null`; neither parent had that, and a387bf6's `ANY_OLD` sentinel wasn't ported. A write landing between init's plan and the move is dropped from the new tracker.
    - Fix: CAS against the planned `tips.local` (zero oid when there is none), and narrow `old` back to `string`.

17. **[low] [JUDGEMENT] src/tracker/store.ts:572-575 against installer/init.ts:518: `expireReflog` expires every unreachable tracker reflog entry, which breaks init's promise that the old history stays in the reflog.**
    - Evidence: `reflog expire --expire=never --expire-unreachable=now refs/grimoire/tracker` runs after every purge or strip rewrite. After `--new-tracker`, the whole old history is unreachable, so the first purge or strip wipes it, contrary to init's confirmation text and to `UnpushedDrop.reflogExpired`'s doc ("the entries for the rewritten commits").
    - Fix: delete only the rewritten commits' entries, or reword init.

18. **[low] [JUDGEMENT] src/core/sync.ts:188-205, 417-439: a lost race is recorded and shown as "the remote rejected the push", with branch-protection advice.**
    - Evidence: backoff is correctly skipped for `lostRace`, but the failure is stored with class `rejected`. `syncSummary` and `syncFix` then blame a ruleset or hook. The undeclared `lostRace` key is dropped by `syncResult`.
    - Fix: add a `busy`/`lost_race` phrase and flag to SyncStatusRecord and SyncResult.

19. **[low] [JUDGEMENT] src/tracker/store.ts:601-631: `rewriteUnpushed` re-implements the write loop (turnstile, fairness lock, CAS retry) without its bounds, and sync strips before the no-default-branch check.** (GOK-151 item, STILL OPEN.)
    - Smell: Duplicated Code. It is also unbounded under the lock.
    - Evidence: no `writeDeadline`, so its gits get the full stall time; no deadline on the `rewriteSegment` walk; no pause between retries. The `staleLock → busy(...)` throw is copied three times (:622, :762, :798). sync.ts:390 runs before :392 `head === null`, so a remote with no default branch re-walks the whole history under the lock on every automatic sync, then returns `no-default-branch`.
    - Fix: route the rewrite through `transact`'s machinery, and move the `head === null` check before the strip.

20. **[low] [HARD] src/tracker/store.ts:469-477, 512-519: `stripUnpushed` and `stripUnpushedText` rewrite and move the tracker ref without `checkTrackerMarker`.**
    - Standard: ADR 0011 (a release writes only a tracker whose compat is in its J..K). Every `transact` round checks the marker (:745); these paths don't.
    - Evidence: an older pin's `sync` or `leave` can rewrite commits a newer pin wrote with a raised marker.
    - Fix: check the marker on the local snapshot inside `rewriteUnpushed` before planning.

21. **[low] [JUDGEMENT] src/core/sync.ts:101-103, 252-253, src/tracker/sync.ts:35-36, 52-55 (flakes-4, 3f93abc): test-only seams in the product's public types.**
    - Smell: Speculative Generality. It also cuts against contributing.md "Nothing mocks git": test/core/sync-support.ts `busyRemote` fabricates `git push --porcelain` output.
    - Evidence: `SyncRequest.network` and `pause` are documented as "Test seams", no product caller sets them, and `NetworkGit` is exported from tracker/index.ts.
    - Fix: keep the seam module-internal, or drive races with a `remote.<r>.receivepack` wrapper, as the ad3ee90 lock-contention test does.

22. **[low] [JUDGEMENT] src/machine-local/locks.ts:63-76: the fairness lock is not FIFO.** (Deferred past v1, STILL OPEN.)
    - Evidence: waiters poll with `sleep(20 + Math.random() * 40)`, so at about 160 writers one can lose for the whole 10 s budget and get BUSY. BUSY is retry-safe and correctness rests on the CAS, so this stays low. Record it as a known limit.

23. **[low] [JUDGEMENT] src/git/refs.ts:260-273: `releaseLock` removes any ref `.lock` whose content equals `next`, with no lock held, after the fairness lock is released.**
    - Evidence: fold and rewrite commits are deterministic (same tree, parents, identity and second give the same sha), so another process preparing the same `next` can have its live lock deleted when the killed git never took it. This needs a stalled git and an identical commit at the same moment.
    - Fix: use the content check only when `session.held` was never set and the lock's mtime predates the kill.

24. **[low] [JUDGEMENT] GOK-151 leftovers (all STILL OPEN):**
    - (a) src/tracker/fold.ts applies no excerpt mode. The merged mode is applied only at push (store.ts:512), so local reads and the dashboard keep unpushed text until the next push.
    - (b) src/tracker/ops.ts:47 maps `settings-set` only to `settings`, but core/settings.ts:434-435 `stripOpenAttempts` rewrites open attempts' session records in the same commit, so attempt and trace views don't refetch.
    - (c) `rewriteSegment` (store.ts:638-677) never remaps `start_commit`, so capture/bindings.ts:148-150 falls back to a full-history `git log` on other clones.
    - (d) capture/end.ts:640-644: a Codex context is searched only in its own session's revealed home, then the default home. Claude iterates every revealed root (:253-262). Spec §14 Roots says sweeps search revealed roots for both clients.
    - Fix: (a) record as a deviation or apply in fold; (b) map `settings-set` to `reload` or add an effect; (c) remap or record; (d) iterate revealed Codex roots.

25. **[low] [JUDGEMENT] src/tracker/view.ts:798-820: purging a trace leaves its earlier session purges' kept facts behind.** (GOK-152, STILL OPEN.)
    - Evidence: `purgeTrace` removes the attempt directory, the outcome and `purgeLeftovers`, never `purges/<handle>/<key>.md`. Those tombstones can hold `facts: kept`, and `droppedPaths` doesn't name them, so the unpushed segment keeps them too.
    - Also: test/surfaces/cli/cli-gate.test.ts:46 covers only the TTY-refused `purge session`; the TTY flow (typed key, reason, `with_facts`) is untested.
    - Fix: drop session tombstones with the trace and name them in the history drop. Add the TTY test.

26. **[low] [JUDGEMENT] test/core/excerpt-mode.test.ts:117 and test/core/sync-clones.test.ts:191: 120 s timeouts in the parallel main suite.** (red-excerpt follow-up STILL OPEN; lost-every-round flake PARTIAL.)
    - Evidence: both use `{ timeout: 120_000 }`. The first runs 13-18 s quiet. The second does ten real git rounds. Doubled headroom hides a regression that adds rounds, and the advisor's rule says tests over about 20 s get a fake clock or the slow project.
    - Fix: lower `PUSH_ROUNDS` through the tracker seam for the test, or set a tight bound and move it to `*.slow.test.ts`.

## Low: knowledge, chores, proposals, skills

27. **[low] [HARD] src/core/chore-submit.ts:185, 215, 400: the chore_submit idempotency fingerprint leaves out the result.** (STILL OPEN.)
    - Standard: spec §9/ADR 0003 (a reused key with different input answers IDEMPOTENCY_MISMATCH).
    - Evidence: `fingerprint: { run: run.id }` on both paths, and :185 replays `run.refused.outcome` on the key alone, so a fixed-up result sent with the same key gets the old refusal back unchecked.
    - Fix: put a hash of the canonical result JSON in the fingerprint and in `run.refused`.

28. **[low] [HARD] src/tracker/fold.ts:255-262 with tracker/wiki.ts:513: log.md bytes can differ between clones when two compiles share an `at`.** (STILL OPEN.)
    - Standard: ADR 0007 ("every clone reaches the same state whichever side folds").
    - Evidence: the fold concatenates side a's then side b's chore-run records unsorted, and renderWikiLog breaks ties by input index. Write rounds sort `byAt` (at, then id). So fold(a,b), fold(b,a) and a write round can produce different bytes.
    - Fix: sort by `byAt` in the fold, or tie-break on run id in renderWikiLog.

29. **[low] [HARD] src/knowledge/chores/compile.ts:216: a created page that no map entry names is committed with `sources: []`.**
    - Standard: spec §16 (pages keep their sources from the map; cite only served items).
    - Fix: refuse it with a reason code (for example `unsourced_page`).

30. **[low] [HARD] test/core/chore-submit.test.ts: no tests for the `hygiene` guard, `unscanned`, or the second route to the 8-write cap (sources-only writes, compile.ts:314).**
    - Standard: contributing.md (test at the seams) and GOK-159's "What to build".
    - Fix: add them, together with the test from finding 2.

31. **[low] [JUDGEMENT] src/knowledge/chores/serving.ts:541-552: an oversize item makes a page exceed PAGE_LIMIT and is logged as served with none of its text.**
    - Evidence: with `items.length === 0` and `cut === ''`, it pushes `{text: '', continues: true}`, then `i++`. The item is logged with its full hash, so a chore may cite text it never received (ADR 0006).
    - Fix: skip it without logging it as served, or trim its non-text fields. Don't mark `continues` when the cursor moves past it.

32. **[low] [HARD] src/surfaces/cli/args.ts:38: `grimoire quarantine --trace <handle> "<reason>"` answers INVALID.**
    - Evidence: positionals `['page', 'reason']`; with `--trace`, the reason fills `page`.
    - Fix: read the positionals as `[reason]` when `--trace` is given.

33. **[low] [JUDGEMENT] src/knowledge/chores/admission.ts:112: the CLI "Claude Code shell" refusal keys on client detection (`ctx.client?.name === 'claude-code'`, from `AI_AGENT`/`CLAUDE_CODE_CHILD_SESSION`), not on `CLAUDE_CODE_SESSION_ID`.**
    - Evidence: a Claude shell with an unusual `AI_AGENT` is admitted under the Codex root rule.
    - Fix: refuse whenever `CLAUDE_CODE_SESSION_ID` is set.

34. **[low] [HARD] src/core/human-ops.ts:46-50, 89: assign and reassign write start.md with no delivery-switch state.**
    - Standard: spec §3/§14 and ADR 0005 ("plus the state of the delivery switch").
    - Evidence: scorecards.ts:110 then puts delivery-off agent traces under an assigned attempt in the main group.
    - Fix: record `delivery`.

35. **[low] [HARD] src/knowledge/scorecards.ts:117 and :101: scorecard counting rules.**
    - Evidence: a lone Skill-call read (version null) or an unmatched read ('unknown') with complete facts counts as "offered, not read", the case the "read unknown" rule exists for. :101 also makes a scorecard for any ledger kind's `to`, against its doc.
    - Fix: count those reads as read_unknown, and filter :101 to the kinds that make a version current.

36. **[low] [JUDGEMENT] src/core/skills.ts:333 (also chores.ts:464, serving.ts:359, proposals.ts:352): costly whole-store re-reads on every call.**
    - Evidence: `traceFacts(view)` parses every sealed attempt's session records on each skill_show, knowledgeFacts and ledger digest (and `skill edit` pays it just to get the base text). proposal_show reruns acceptChecks on every show. skills.ts:541 has a leftover duplicate doc comment.
    - Fix: memoize per TrackerView (WeakMap, as `readSkills` does), give the editor a no-scorecard path, and delete the comment.

37. **[low] [HARD] src/core/proposals.ts:693: the purge verb is `proposal purge`, not spec §10's `purge proposal` (the sibling verbs are `purge trace` and `purge session`).**
    - Fix: rename the op to `purge_proposal`, or add an alias.

38. **[low] [HARD] src/core/proposals.ts:682-714: proposal_purge says nothing about pushed history keeping the content, or what cites the proposal.**
    - Standard: user story 68. purge_trace returns `history.note` and `cited_by`.
    - Fix: reuse `historyNote(drop)` and add `cited_by`.

39. **[low] [HARD] src/core/proposals.ts:663-680: reconsidering a proposal dismissed while stale commits a decision that changes nothing (the status reads `stale` afterwards).**
    - Standard: ADR 0003 (one commit per meaningful op).
    - Fix: refuse when the undismissed state would be stale.

40. **[low] [HARD] test/core/gate.test.ts: only the evidence red flag (:45) and the at_cap lapse (:119) are tested.**
    - Missing: acknowledging red risk flags and `token:` origins, red flags from a quarantine or an outcome flip, and lapses from a stub collision or a stricter check.

41. **[low] [HARD] src/core/skill-changes.ts:312-324: for a contested accept of a create, skill_acknowledge can't side with the reject.**
    - Evidence: `from` is null, so the only choice is the accepted version, and siding with a `suspicious` reject means a delete, which also blocks the name.
    - Fix: allow a reject-siding acknowledge that withdraws the version without blocking the name.

42. **[low] [JUDGEMENT] src/runner/bundle.ts:19-35 against src/knowledge/chores/offering.ts:38-43: the runner keeps its own copy of the chore procedure.**
    - Smell: Duplicated Code, with constants copied as magic numbers.
    - Evidence: `PROCEDURE` restates PROPOSER_RULES almost word for word and hard-codes 8 / 12,000 / 200 / 25% instead of the compile constants. Both texts say "300" while the check reads `skills.description_max` (propose.ts:412), so the instructions go wrong once the setting changes.
    - Fix: build the runner preamble from exported rule blocks and constants, and fill in the description limit from the setting.

43. **[low] [JUDGEMENT] src/knowledge/chores/compile.ts:93-177 against propose.ts:118-279 (and gate.ts:73 against propose.ts:465): the secret-scan, shape and evidence helpers are copied between compile and propose, and the copies have drifted.**
    - Smell: Duplicated Code.
    - Evidence: three `scan → Problems` variants (compile and propose treat "hygiene couldn't run" differently); `isObject`, `isString`, `UNVERIFIED_LIMIT` and the reported-client normaliser are copied; the evidence minimum is written twice.
    - Fix: one `chores/result-checks.ts`. This is also the natural home for finding 2's fix.

44. **[low] [JUDGEMENT] src/core/chores.ts:123, src/runner/bundle.ts:35, src/surfaces/dashboard/knowledge.tsx:296 (also chore-submit.ts:86-87 and seven branches in serving.ts): per-chore-kind tables and `kind === 'wiki-maintainer'` branches are spread across files.**
    - Smell: Repeated Switches / Shotgun Surgery. `KIND_NAMES` is defined three times.
    - Fix: one `CHORE_KIND_INFO: Record<ChoreKind, {name, resultNoun, op, schema}>`.

45. **[low] [JUDGEMENT] src/core/chore-submit.ts:203-276 against 387-501: submitCompile and submitProposal repeat the same idempotency, recorded, after-commit and catch scaffolding.**
    - Smell: Duplicated Code.
    - Fix: one `submitWith(check, write)`. This also gives finding 27 a single home.

## Low: installer, CLI, runner, hooks, upkeep, capture

46. **[low] [HARD] src/surfaces/start/run.ts:200, 223: INTERNAL used for expected conditions.** (GOK-155, STILL OPEN.)
    - Standard: ADR 0012 (INTERNAL is for unexpected failures only).
    - Evidence: "couldn't reach the running grimoire start … over its control channel" and "couldn't open a browser" are thrown as INTERNAL. NOT_FOUND `{start:null}` and BUSY for no free port are also outside §9's meanings.
    - Fix: use table codes with details, or add rows on GOK-123 §9 before the envelope freezes.

47. **[low] [JUDGEMENT] src/surfaces/start/run.ts:434: the runner card records an unexpected failure as `refused` and drops the stack.**
    - Standard: ADR 0012 (INTERNAL is not a refusal).
    - Evidence: `errorBodyOf(error, () => {})`, then `outcome: 'refused'`. Even with GRIMOIRE_DEBUG nothing is logged.
    - Fix: pass a debug logger, and use an outcome such as `failed` for INTERNAL.

48. **[low] [HARD] src/installer/upgrade.ts:101 and installer/init.ts:610: UPGRADE_REQUIRED from `init --upgrade` has `remedies: []`, and the compat-raise branch has `requires: null`.**
    - Standard: ADR 0011 ("UPGRADE_REQUIRED names `requires`") and spec §5's ordered remedies. Core fills them only via `completeUpgradeDetails`, which the installer never calls.
    - Fix: build the remedies with core/upgrade.ts (a variant that needs no CallContext).

49. **[low] [JUDGEMENT] src/core/chore-runs.ts:98-101: the kept refused-result text is shown without checking that the secret scan passed.**
    - Standard: ADR 0005/0006 fail-closed, as defence in depth (the writer is the real gap, finding 2).
    - Evidence: `const text = typeof value.text === 'string' ? value.text : null`; `value.rules` is never consulted.
    - Fix: show text only when `rules` is empty.

50. **[low] [HARD] src/installer/init.ts:604, 668: the upgrade can ask more than its one consent question, and a dry run gets a refusal.**
    - Standard: the code's own contract (:646 "its one question is the consent") and the AC "--yes takes only safe defaults".
    - Evidence: the 'Restore them?' question isn't gated on `upgrading`, and `if (!prompter) throw …'--yes never raises compat'` fires for `--upgrade --json` without `--yes`.
    - Fix: gate on `!upgrading`, and key the refusal on `flags.yes`.

51. **[low] [JUDGEMENT] src/surfaces/mcp/serve.ts:57-60 with upkeep/run.ts:274: a forced refresh in a long-lived process skips a worktree whose lease is held, though run.ts:113 says "A decision's refresh waits".**
    - Evidence: `leaseWaitMs` is never set, so the worktree stays on the old served set for up to 30 minutes.
    - Fix: pass a lease wait through `trigger({force})`, or re-queue held worktrees.

52. **[low] [JUDGEMENT] src/upkeep/run.ts:299 with upkeep/refresh.ts:25: a CLI skill refresh writes the shared per-worktree stamp, throttling pointer-refresh for 5 minutes.**
    - Smell: one stamp shared by two parts.
    - Fix: write the stamp only when every per-worktree part ran, or keep one stamp per part.

53. **[low] [HARD] src/installer/leave.ts:57: the installer imports from surfaces (`import { removeControlFiles } from '../surfaces/start/control'`).**
    - Standard: contributing.md layering (surfaces sit on top of the modules). This is the only such import.
    - Related: src/core/skills.ts:31 and core/skill-changes.ts:27 import `registeredWorktrees` from installer/worktrees.ts, which imports core/host. That is a core-installer cycle that GOK-170 widened (JUDGEMENT).
    - Fix: move the control-path helpers into src/machine-local, and move worktree listing below core and installer (git/ or machine-local), or inject it through OpEnv.

54. **[low] [JUDGEMENT] src/installer/leave.ts (performLeave): there is no clone-wide "leave in progress" marker, so a session started between the last liveness check and the removal can recreate pieces.** Only reported afterwards. Decide on a cross-pin marker or record the residual race on GOK-123.

55. **[low] [JUDGEMENT] src/machine-local/processes.ts:151 and surfaces/mcp/process-record.ts:39, 116: process-record hygiene.**
    - (a) `prune()` is never called, though process-record.ts says records are "pruned as such". Records of hard-killed processes accumulate.
    - (b) Records from another host always count as live (`live.get(e.file) ?? true`), so a stale record on a shared drive makes leave and uninstall refuse with no remedy naming it.
    - Fix: call `prune()` from an upkeep part, and name foreign-host records in busyText with a manual-removal remedy.

56. **[low] [JUDGEMENT] Runner rough edges (GOK-167, STILL OPEN):**
    - (a) src/runner/guard.ts:104-117: a Codex env-key-only setup is refused as "doesn't show a login". With a ChatGPT login plus an allowed `CODEX_API_KEY`, the guard reports `chatgpt` and `bills_api:false` while `codex exec` bills the key.
    - (b) src/runner/status.ts:12 `caps.last?.auth_method ?? config.auth_method` shows the previous runner's method after a kind switch.
    - (c) src/runner/run.ts:126: a throw on iteration 2 or later loses the report of runs that already succeeded.
    - (d) test/runner/support.ts:129 `codexApiError()` is never used, and the Codex failure rules (turn.failed, missing or invalid `-o`, `error`-only events, the fix-up respawn) are untested.
    - Fix: per item.

57. **[low] [HARD] src/surfaces/cli/args.ts:348: `chore run` has policy `human-read`.** Spec §7 defines human-read as ops carrying wiki, proposal or trace text. It belongs with init/start/open (refuses agent markers, needs no TTY).

58. **[low] [JUDGEMENT] GOK-171 uninstall/leave report accuracy (STILL OPEN):**
    - (a) installer/leave.ts:404, 551-553: run inside uninstall, leave still says "It never changes the host repo" and warns that the just-uninstalled checkout "still pins grimoire" (`pre.installed` is computed before removal).
    - (b) installer/uninstall.ts:376-378 lists saved stray edits, which stay in the machine-local store, as lost.
    - (c) installer/removal.ts:580-584 reports a kept dotfolder file a second time as "grimoire didn't write it".
    - (d) installer/removal.ts:186 `pruneEmpty` also drops empty containers the person had before the install.
    - (e) installer/removal.ts:401-410 finds Codex TOML and Markdown blocks by marker only, where §21 says "by the frozen bootstrap and verb text first". This one is HARD per the GOK-171 reviewer's reading of the spec; the spec isn't in the repo.
    - (f) installer/uninstall.ts:426 purges with `stripUnpushedText`, not the purge ops, contrary to the GOK-152 handoff. It is recorded as a GOK-171 clarification; confirm on GOK-123.

59. **[low] [HARD] src/surfaces/cli/args.ts:340-350: `grimoire --help` omits `start` and `open`.**
    - Standard: contributing.md and README describe the help as listing every verb, and README documents both.
    - Evidence: they are dispatched in src/surfaces/entry.ts:62 before runCli, so `RUNTIME_VERBS` never lists them.
    - Fix: add both entries.

60. **[low] [JUDGEMENT] src/generated/fast-path.ts:116-143: the 7 s hook budget is checked only between steps.** The cache-miss whole-ledger read and secret scan come before the first check, and `reconcileWorktree` runs after the last. Pass the deadline into both.

61. **[low] [JUDGEMENT] src/surfaces/hooks/session-start.ts:61, 79, 167: hook-line gaps.**
    - `strayEditsLine` (multi-edit 200-character trimming, the single-edit fallback) and `lastPriorityLine` (combining the stray-edit and refreshed-pointer lines) have no direct tests. The 'budget' skip is now tested.
    - The pin-mismatch line can fire because of another resumed session's server, since process records carry no session.
    - Fix: add unit tests, and add the client pid or session to the mcp record (additive).

62. **[low] [JUDGEMENT] src/capture/commit-facts.ts:60, 366; src/capture/reader-stats.ts:197: capture rough edges (GOK-156, STILL OPEN).**
    - (a) `-[cC]\s+\S+` misses quoted `-C "C:\My Folder"` and `-c key="a b"`. Windows paths with spaces are common, and contributing.md says nothing may assume POSIX.
    - (b) The `.zst` probe destroys only the decompressor, leaking the raw read stream's fd, with no error listener on it.
    - (c) The co-author regex `^(claude|codex)\b|@anthropic\.com>` flags humans named Claude or anyone at anthropic.com as agents.
    - (d) Codex creation lines are tested only negatively (test/client-contract/commit-facts.test.ts:53).
    - Fix: per item (accept quoted values; use `stream.pipeline`; match the exact client trailers; add a positive fixture).

63. **[low] [HARD] test/surfaces/cli/support.ts:141-144: the pty helper's own 60 s timeout orphans the wrapper's grimoire child.** (Advisor LEAK item, PARTIAL.)
    - Standard: contributing.md ("a test that leaves a process … fails, and the process tree is killed").
    - Evidence: `setTimeout(() => { child.kill(); reject(...) }, 60_000)` kills only conhost/python. The wrapper's `spawnSync` child has no pid file, so test/harness/children.ts can't see it. Tests using this helper run with 120-480 s vitest timeouts, so this timer is the one that fires.
    - Fix: kill the tree (`taskkill /T /F`; on POSIX, a detached group), or have the wrapper write a `trackPidFile`.

64. **[low] [JUDGEMENT] retry routing is PARTIAL (advisor rule: the shared bounded retry at every machine-local and safe-write site).**
    - Every machine-local and safe-write.ts rename and unlink does go through `retryTransient`.
    - Outside it:
      - src/generated/reconcile.ts:196 (finding 9).
      - installer/upgrade.ts:190 `rm(head)` with the failure swallowed.
      - Best-effort `rmdir().catch(() => {})` at reconcile.ts:365-366, leave.ts:769 and removal.ts:513, :598.
      - installer/copies.ts:202, :230 and leave.ts:778 use Node's `rm` maxRetries instead, a second mechanism that doesn't cover EACCES.
    - Related, in fs-atomic.ts:84 and :97-102: EPERM is both a transient Windows code and a "no hard links" signal, so a persistent EPERM on Windows falls back to the non-atomic `open('wx')` path.
    - Related, in fs-atomic.ts:30-35: `RetryOptions.budgetMs` is documented as the caller's operation budget, but only tests pass it.
    - Fix: route the rest through `retryTransient` (or document that `rm` maxRetries counts as the retry), treat EPERM as "no hard links" only off Windows, and reword or plumb `budgetMs`.

65. **[low] [JUDGEMENT] src/capture/end.ts:212-218 with :520-526: a context cut for the first time (every non-calling context) whose facts scan overruns the budget gets `budget` or partial facts depending on which of two timers for the same deadline fires first.**
    - Evidence: the keep-before-scan step is guarded by `this.latest !== null`.
    - Standard: spec §14 (an overtaken scan leaves facts `partial`).
    - Fix: drop the `latest !== null` guard.

66. **[low] [JUDGEMENT] src/surfaces/hooks/run-hook.ts:22-33: the generic hook dispatcher carries a session-start-only test knob, `HookOptions.fastPathBudgetMs` (fast-check).**
    - It is inert in production (entry.ts:38 passes no options), but it is spread into `sessionStart(…)`, which hides excess keys, and most tests run with `Infinity`.
    - Smell: Speculative Generality.
    - Fix: type it as `Pick<SessionStartContext, 'fastPathBudgetMs'>`, or have tests call `sessionStart` directly.

## Low: cross-cutting duplication, dashboard (GOK-160/163/169/170), release (GOK-172), glossary

67. **[low] [JUDGEMENT] src/capture/bindings.ts:96-118, src/core/activity.ts:37-91, src/core/attempt-show.ts:130-143: commit-trailer, actor and log-record parsing is copied, and the copies have drifted. A hand-rolled `cat-file --batch` sits inside an op module.** (GOK-169 follow-up, STILL OPEN; I diffed them.)
    - Smell: Duplicated Code / Divergent Change, against contributing.md, which puts git readers in src/git ("one long-lived `cat-file --batch` reader per repo").
    - Evidence:
      - `trailersOf` is byte-identical in bindings.ts:97 and activity.ts:43 (`trimEnd`, untrimmed values), while `commitTrailers` (tracker/ops.ts:63, used by events.ts and trigger.ts) uses `trim` and trims values.
      - `actorOf` is copied too; activity's copy drops `nonce`.
      - The `RECORD`/`FIELD` `%H%ae%cI%B` log format is copied from `readBindings`.
      - activity.ts:67-91 `readBlobs` spawns a one-shot `cat-file --batch` per call, and attempt-show imports it from activity.
      - attempt-show `exposureHits` re-implements `readBindings`' grep without its `^start_commit` bound, so every attempt-page load walks the whole history.
    - Fix: use `commitTrailers` everywhere; put one actor parser and one log-record reader in src/tracker; read blobs through the tracker's ObjectReader; build exposure hits from `readBindings(root, record, view.parents)`.

68. **[low] [JUDGEMENT] src/tracker/ops.ts:18-49, src/runner/trigger.ts:28-38, src/surfaces/dashboard/attention.tsx:573-613, issue.tsx:491-504, issue.tsx/attempt.tsx ENDINGS: op names are hand-mapped in four unsynchronised places, and the feed mislabels commits.**
    - Smell: Repeated Switches / Shotgun Surgery. ops.ts says "Every op a write commits must be listed", and test/core/commits.test.ts checks only that table.
    - Evidence (I verified these):
      - `TRIGGER_OPS` is a second hand-kept op set.
      - attention.tsx `VERBS` labels every `purge` "purged a trace of", but proposal_purge (proposals.ts:705) and purge_session (purge.ts:146) also commit `op: 'purge'`.
      - A lapse is written inside the `op: 'accept'` transact (proposals.ts:474-488), so the feed says "accepted a proposal" for a lapse. That also contradicts ops.ts's header ("A knowledge op commits under the ledger kind it records").
      - `VERBS` has dead `lapse` and `proposal-purge` keys and lacks `discard`.
      - The issue timeline has its own nested ternary over ops, and `ENDINGS` is duplicated with different wording.
    - Fix: one op table carrying effect, trigger flag and verb (or a dashboard table checked against `isKnownOp` in a test); commit lapses under `lapse`; tell purge targets apart by trailer.

69. **[low] [JUDGEMENT] Dashboard (GOK-160/163/169/170) smaller items. Each is verified by the sub-reviewer; the summary is mine.**
    - (a) src/core/body-diff.ts:22-84, 152-166 is a second LCS line diff and patch applier beside knowledge/line-diff.ts and core/patch.ts (different append rule). ui.tsx:311-315 re-parses `shownDiff` text. The `REPLACE`/`APPEND` constants exist only to dodge the commits.test regex. (Duplicated Code)
    - (b) issue.tsx:124-133 derives the state chip client-side (blocker count copied from derive.ts:196-199, and wrong when `show` trims blockers under its budget), contradicting ui.tsx:3-4 "Nothing here derives state". `list` already returns `open_blocker_count`.
    - (c) issue.tsx:366-371: the Resolve dialog hard-codes resolvable fields and silently swaps the person's "theirs" pick for `kept`. No browser test covers Resolve from the issue page or Attention (GOK-163 LOW, open).
    - (d) core/attention.ts:246-250: `skillStrays` and `knowledgeItems` failures are swallowed (`.catch(() => …[])`), so a defect shows "Nothing needs you" while a proposal is pending. attention.tsx:62 refetches all knowledge items on every live event (GOK-170 LOW, open).
    - (e) Page helpers are duplicated (`act` twice with different signatures, `str` twice, the load/NOT_FOUND/toast pattern), attention.tsx imports dialogs from the issue page, and the id regexes are copied in markdown.tsx:10-11 and start/server.ts:75-76.
    - (f) data.ts:85-88 caps the issue timeline at 200 writes and ignores the cursor; issue.tsx:79 hides activity failures.
    - (g) body-editor.tsx:59, 147 recomputes the full LCS (up to a 4M-cell array) on every keystroke.
    - (h) issues.tsx:58-66 fires about 11 `list` reads per live change.
    - (i) knowledge.tsx:235-258 has a second copy of the `knowledge.pickup` row (settings.tsx exports `SettingRow`). attention.tsx:103-125 and :150-410 hold two switches over every item kind (exhaustive under tsc).
    - (j) trigger.ts:63-72 and start/events.ts:281-294 hold two copies of "commits between tips" (`git log --max-count=LARGE_JUMP+1 … --not …`), polled every 2 s and 1 s in the same process.
    - (k) Test gaps: activity issue-filtered paging (the substring grep can return a short page with a non-null cursor), cursor reuse with another issue, fold attribution (finding 14). issues.test.ts still spawns one `start` per test (~150 s).
    - (l) README.md:113 misstates NOT_SYNCED as "couldn't be fetched or pushed". The code raises it for a missing, foreign or shallow tracker (tracker/store.ts:232-258); a failed fetch or push is a `sync` result with `reason: 'failed'` (HARD: README accuracy).
    - (m) scripts/build.mjs:150-153: `build:cli` alone rewrites THIRD_PARTY_LICENSES.md without preact. prepack runs the full build, so the published tarball is correct.

70. **[low] [HARD] GLOSSARY _Avoid_ terms in user-facing text and identifiers.**
    - docs/adr/0008:5 "An abandoned release recovers a dead claim" (Stale claim).
    - README.md:50, 52: heading "Generated skills and `git stash --all`" and "generated files nobody commits" ("Generated skill" and "Generated files" are avoid-terms for Evolved skill and Generated output).
    - Dashboard: issue.tsx:774-781 "Take it myself / Take {id} yourself" (Claim) and "with you as the worker" ("worker" is an avoid-term under Assignee); attempt.tsx:369 "Sessions (n)" over session records.
    - knowledge.tsx:128 "Backlog" tile (avoid-term under Pending slot, with a different meaning here; downgrade if spec §20 names it so).
    - "maintenance chore" in shipped chore text: offering.ts:15, 70 and the chores.ts:192 tool descriptions ("maintenance" is an avoid-term for Upkeep and Knowledge chore). Shipped text may change in any release, so it is cheap to fix.
    - installer/texts.ts:75-81 (the seeded issue-tracker doc) uses "ticket" for issue. Check whether the skill templates need those exact labels.
    - "shim" for `.grimoire/run.cjs` in doctor ids (`install.shim`, `shim-missing`, `shim-drift`, install-checks.ts:219-227) and README:36 ("Shim" is an avoid-term under Pointer file).
    - Fix: rename, or, where the spec names the term (shell shim, Backlog), add it to GLOSSARY so the two agree.

---

## Verified fixed (follow-ups no longer applicable)

- GOK-154 integrity trio:
  - Unidentified-caller fail-open: admission.ts:157 treats a null person as possibly holding every attempt, and a seen-here read error throws NOT_ISOLATED (:162-167).
  - chore_start atomicity: `withStartLock` plus `withContextLock` (core/index.ts:454); the exposure mark is written before the run and undone on failure (chores.ts:242-253).
  - Run-record RMW: `updateRun` goes through `records.update`, and read, submit and abandon share `withRunLock`.
- purge_trace `cited_by.proposals` is no longer []: purge.ts:122 `citingProposals(view, handle)`. The remaining divergence is finding 12.
- GOK-140 blocked_by bare vs `~hash4`: core/update.ts:26-52, 168-192 compare by the record each id names.
- Hung git in shallowTips: one-shot gits have a stall watchdog bounded by the write deadline (git/run.ts:196-207), and a memoized 128-commit walk replaces the per-tip rev-list.
- Exhausted lost race no longer backs off (core/sync.ts:193-203); the wording issue is finding 18.
- flakes-2/red-excerpt question, "can a genuine rejection burn the whole deadline?":
  - No. Hook or protected-branch `[remote rejected]`, auth failures and D/F conflicts fail at once. A `moved` or `contended` rejection against an unmoved remote fails as `rejected` with backoff after 3 pushes (`UNMOVED_REJECTIONS`).
  - Residuals, all low: a pushurl/fetch-URL mismatch where the fetch remote really is busy retries all 10 rounds every time; a first-round `moved` is marked lost-race unconfirmed when the deadline leaves no time for a listing; the locale caveat in finding 3 fails toward refusal.
- "dead claim" in core attempts.ts: no avoid-term claim words remain in src/ (only GLOSSARY and ADR 0008, finding 70).
- GOK-153 fast path writing without the lease: fast-path.ts:127 takes the worktree lease and re-reads the served set under it.
- GOK-164: the NUL byte in leave.ts is gone; the excerpt reminder now shows whenever there is a local tracker ref (leave.ts:461).
- GOK-145 dedupes done: one `cliContext`, one `openGitEditor`, one `errorBodyOf` used by every surface. control.ts:243's inline INTERNAL is on the internal control channel and acceptable.
- flakes-5 product fixes read correctly:
  - A finished cut is never replaced by a shorter one (end.ts:498-503); the remaining first-cut case is finding 65.
  - Slot generations use exclusive create, so nothing is renamed over an open file.
  - Take, renew and release races resolve to one winner, and a late renew can't revive a released lock.
  - `writeFileAtomic`'s temp cleanup is retried.
- The settings.test "Sync now … just now" flake is fixed (the test waits for `.sync-last`).
- Core does not import src/runner (GET /api/runner serves the card).
- README verbs match the code: `run.cjs pin`, `runner enable|disable`, `chore run --due`, `doctor --fix/--readers`, `sync status`, and runner caps of 6 per 24 h with a 6 h pause.

## Zero runtime dependencies and bundle hygiene: clean

- package.json has only `devDependencies`.
- scripts/check-deps.mjs fails on any of the five runtime fields, even an empty one.
- scripts/build.mjs bundles only src/surfaces/cli/main.ts and src/surfaces/launch.ts (plus the Vite dashboard), with no sourcemaps, and fails on any non-builtin external.
- dist/ is fresh: built 10:39, after HEAD's 10:28 commit.
- Grepping dist/ for harness, vitest, fake-exe, `test/`, `__test` and `sourceMappingURL` finds nothing. "spike" and "seam" appear only in kept source comments: one grimoire comment ("spike E") and the MCP SDK's own comments.
- `npm pack --dry-run --json --ignore-scripts` lists 86 files (602 kB packed, 2.44 MB unpacked): package.json, README.md, LICENSE and dist/** only, with no `.map` files.
- THIRD_PARTY_LICENSES lists @modelcontextprotocol/core and /server, zod and preact.
- The bundle isn't minified, so source comments ship (not a finding). The `build:cli`-only notices gap is item 69(m).
