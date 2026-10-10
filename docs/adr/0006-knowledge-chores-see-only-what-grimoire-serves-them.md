# Knowledge chores see only what grimoire serves them, in contexts grimoire can identify

A knowledge chore reads the wiki and untrusted trace text, so two things must hold. Its context must hold no open attempt (ADR 0002), and everything it cites must be something grimoire actually gave it (ADR 0005).

**Grimoire serves every input and writes every output.** Four tools carry a chore run: `chore_start`, `chore_read`, `chore_submit` and `chore_abandon`. Grimoire serves the inputs through them and records every item it serves on the chore run. A chore may cite only served items; nothing it reads from disk counts. Grimoire's own code writes every output: pattern pages, the index and log it derives from them, and skill proposals.

**So a chore context needs no tools beyond the chore tools, and gets none wherever the client allows it:**
- **Claude Code:** the shipped `grimoire-chores` skill forks into a `grimoire-chores` subagent whose `tools` allowlist holds only the chore tools.
- **Codex:** the skill spawns a `grimoire-chores` role with a fresh context and the shell disabled. A Codex role can't narrow MCP tools.
- **The opt-in runner:** grimoire spawns the user's own `claude -p` or `codex exec` with no tools, no MCP servers and no hooks. It runs in an empty temporary directory outside any git repo, with the whole served bundle on stdin.

**`chore_start` admits a context only when grimoire can tell that it holds no open attempt.** The server alone can't tell callers apart (ADR 0003), so it uses two signals: `agent_id` and `agent_type` from grimoire's own PreToolUse hook in Claude Code, and the per-call `_meta` thread and session ids in Codex. It admits:
- in Claude Code, only the chore subagent;
- in Codex, any subagent thread, or the root thread of a session tied to no open attempt;
- an unidentified caller, only when its person holds no open attempt in this host repo on this machine.

**Wiki exposure.** A chore that runs in a main context marks its session. If the session is unknown, it marks the server process instead. Any attempt that session or process opens later is flagged wiki-exposed. Every chore result also ends with a summary line that grimoire's code composes from counts and ids, so no wiki text travels back into a context that may hold an attempt.

## Considered Options

- **Let chores read `.grimoire/` with the agent's own file tools, and run the runner over the checkout.** Rejected for two reasons:
  - Citations could name items grimoire never served. ADR 0005's evidence check can't verify those on another clone.
  - A context that has a shell and reads untrusted trace text is one injected command away from running it, and that context is unsandboxed on native Windows.
- **Trust the model to isolate itself,** with instructions only and no server-side check. Rejected: nothing would catch a chore run in the main context during an attempt, and the wiki-exposed flag would silently miss it.
- **Refuse unidentified callers outright.** Rejected: generic MCP clients would lose in-session chores entirely. Charging the exposure to the server process over-flags at worst, and the flag only discounts.
- **Run the runner inside the host repo, suppressing project settings with flags.** Rejected: Claude Code and Codex suppress project layers differently and only partly, and Codex has no flag that drops all MCP servers. An empty directory outside git loads no project layer in either client.
- **Let cloud schedulers that start from a fresh clone run the Skill Proposer.** Rejected: every fresh clone sees an empty pending slot, so the one-pending-proposal bound wouldn't hold. Runs with the `scheduled` origin are compile-only, and local schedulers are the recommended recipes.

## Consequences

- The design rests on four client details that need a spike before anything is built:
  - whether a forked skill's hooks report its `agent_type`;
  - whether the chore subagent needs `ToolSearch`, or always-loaded chore tools;
  - whether `--json-schema` works with `--tools ""`;
  - whether a saved ChatGPT login survives `codex exec --ignore-user-config`.
- The Codex chore role still sees the user's other MCP servers. With the shell off, grimoire's admission check is the enforcement there.
- Every input costs a tool round-trip under the result budget of about 24 KB, so a compile batch is read in several pages.
- A chore run's lease expires after an hour without a chore call. This differs from claims (ADR 0004): chores are cheap to repeat, and duplicate runs merge by union.

_Amended by ADR 0008: a marked session or process flags every attempt it opens or later binds to, not only the ones it opens. Every binding write checks the marks._
