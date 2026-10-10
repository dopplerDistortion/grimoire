# Trace capture binds contexts by attempt handle and cuts their transcripts lazily, with no session-end hooks

ADR 0001 gives each trace excerpts cut from the transcripts of the agent work behind it, on the machine where that work ran. Grimoire has no daemon, and its MCP server can't tell which session called (ADR 0003). Both clients' session-end hooks get one to three seconds, and neither documents what happens on a crash. So capture never waits for a session to end. Grimoire observes every binding call, and cuts transcripts at two points: in the call that ends the attempt, and in sweeps its own processes run.

**Binding is by handle.** A context binds to an attempt only through a write that carries the attempt's handle: the claim, the ending call, or an `update` or `comment` that names it. An abandoned release recovers a dead claim and binds nothing. Every other write on the issue is activity. A matching person is not enough, because a developer's parallel sessions share one git identity, and ADR 0004 tells them apart only by handle.

**Each excerpt comes from the context that did the work.** That is the context that made the binding calls, so a subagent's own transcript is cut when a subagent did the work. This amends ADR 0001's "one excerpt per session" and Traces' "main session only".

**Identity is observed, never claimed.**
- In Claude Code, grimoire's own `PreToolUse` hook puts the session, transcript path, tool-use id and subagent ids into a reserved key. A hint counts only when its tool-use id matches the client's own per-call `_meta`. If a call carries no `_meta`, it counts once the cut finds that id in the transcript.
- Codex's per-call `_meta` names the session, the thread and the call.
- Without either, the spawn environment and the tool-use id are joined to the transcript at cut time.
- Every binding write leaves a machine-local seen-here row in the live store (ADR 0007), so sweeps find Codex sessions and Claude sessions without the hook too. The row is only a hint, and a binding without one is found by an id search.

**Ending an attempt.** The ending call validates first. It then cuts, within 10 seconds, before its tracker commit. Finally, one tracker commit ends the attempt and seals its trace. A replay never cuts again.

**Pending capture records.** Until the attempt ends, each bound context's latest cut waits with the open attempt on the tracker branch (ADR 0007), so an end on another clone still includes it. The record holds the facts (skill reads with their versions, commits with their creation evidence, and statuses) and, by default, the excerpt text. A record cut before the end is still admitted if it syncs later. A cut made after the end is dropped. So that a record admitted late completes the trace without editing anything sealed, the attempt's end record keeps only attempt-level facts, and per-context entries are read from the records themselves.

**Sweeps.** Sweeps run at every `grimoire mcp` start and dashboard start, and every 30 minutes inside long-lived processes. They cut contexts that have been idle for 30 minutes. A later cut replaces a record only if it reaches further into the transcript.

**Reading.** Grimoire reads the raw JSONL with its own tolerant reader for each client. It checks every cut against the calls it knows the context made. When the check fails, the context gets a status that says why, never a wrong excerpt. Redaction scans each kept step whole before anything is trimmed.

**One setting, three values:**
- `excerpts` (the default);
- `facts`: no excerpt text is committed, but skill reads and commits are still recorded, because ADR 0005's scorecards can't be backfilled;
- `none`: grimoire never opens a transcript. Only `skill_read` events and commit trailers count.

## Considered Options

- **Cut in a `SessionEnd` or `Stop` hook.** Rejected for three reasons:
  - the budgets are 1.5 s in Claude Code and 1–3 s in Codex, which has no `mcp_tool` handler there;
  - neither client documents what happens on a crash;
  - a cold Node start can use the whole budget on Windows.
- **A watcher or daemon tailing transcripts.** Rejected: grimoire has no daemon, and agents never need `start` (ADR 0003).
- **Reading through vendor APIs**, such as the Claude Agent SDK's session reader or the Codex app server. Rejected for v1, for three reasons:
  - each one is Claude-only or needs the client binary;
  - they are heavy;
  - they are still tied to client versions.

  The format check makes drift visible instead.
- **The server's spawn-env session id alone.** Rejected: it is stale after `/clear`, wrong after `--continue` and shared by subagents, and Codex servers don't get one.
- **An `mcp_tool` hook for the hint.** Rejected: it needs a listed tool that the model could also call, and it pairs with the real call only through undocumented `_meta`.
- **Binding on any call about the issue, or on any write by the attempt's person.** Rejected: an orchestrator that reads ten issues would land in ten traces, and a developer's other sessions, with their commits, would land in attempts they don't hold.
- **Pending excerpt text only, or pending state kept machine-local.** Rejected: an end on another clone, or the `facts` setting, would lose skill-read versions and commit attribution for good.
- **Counting any commit hash a bound context printed.** Rejected: `git log`, `pull`, `branch -v` and `worktree list` print the same person's commits from other worktrees.

## Consequences

- **Undocumented foundations.** Codex capture rests on its undocumented `_meta` (`sessionId`, `threadId`, `callId`). Claude's fallback without the hook rests on an undocumented `_meta` tool-use id. Both clients' transcript formats are internal. A drift shows up as `unreadable` or `unmatched` statuses and in `grimoire doctor`, never as a wrong excerpt.
- **Spikes needed before building:**
  - `updatedInput` without a permission decision, in every Claude Code permission mode;
  - the reserved key reaching the handler through the MCP SDK;
  - `/clear` starting a new transcript file;
  - Codex subagent threads writing their own transcripts;
  - detecting a fork's copied history;
  - `_meta.callId` being present in every Codex that sends `sessionId`.
- **Commit timing.** Excerpt text is committed and synced while the attempt is still open, not only when the trace is sealed. Purge covers those pending records, but pushed history keeps them, and `init` says so.
- **Accepted losses:**
  - a context that worked without ever passing the handle;
  - a session on a machine where no grimoire process runs within the client's retention (30 days by default in Claude Code);
  - a cut made after the attempt has already ended on another clone.
- **Changes to other decisions:**
  - ADR 0001: one excerpt per bound context, not per session, and a three-valued setting.
  - ADR 0004: `update` and `comment` gain an optional `attempt`.
  - ADR 0005: skill versions are identified and matched on normalized text, and the offered record is the version matching the opening checkout's text.
  - ADR 0006: wiki exposure is checked at every binding write, not only at the claim.
  - ADR 0007: the actor and attempt trailers carry the capture evidence and the named handle. The end record keeps only attempt-level facts. A single session record can be purged with its own tombstone.
