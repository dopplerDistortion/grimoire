# Prior art: how do existing agent-native local issue trackers work?

*Ticket GOK-109 · researched 2026-10-11 · primary sources: first-party repos (shallow clones read at the commits below), docs, changelogs, release pages, npm registry. Fact-checked on 2026-10-11 against fresh clones, the npm registry, release pages and vendor docs; see "Verification notes" at the end.*

## Question

What can grimoire take from existing agent-native and local-first issue trackers, and what should it avoid? The tools covered are beads (steveyegge/beads), Backlog.md, git-bug, Taskmaster (task-master-ai) and other notable 2025-2026 entrants. For each one, this document covers:

- storage format and behaviour under git merges
- ID generation and collisions across branches and clones
- concurrency
- the agent interface (MCP, CLI, HTTP) and how agents learn the tool exists
- install and runtime footprint
- dashboard and UI
- relations: sub-issues, blocking, labels, assignee, comments
- memory and knowledge features, compared with WikiSkill

It ends with a steal/avoid list for grimoire's open decisions: storage and IDs, agent interface, what `start` runs, and the dashboard.

## Versions examined

| Tool | Version / date checked | Repo state read | Lang / licence | GitHub stars (2026-10-11) |
|---|---|---|---|---|
| beads (`bd`) | 1.3.1 (npm publish 2026-10-01 00:24 UTC); 1.3.2-rc.2 tag exists ([releases](https://github.com/gastownhall/beads/releases)); npm `@beads/bd` 1.3.1 | `main` @ 76d5bf6, 2026-10-10 | Go / MIT | ~27.8k |
| Backlog.md | 1.53.0 (2026-09-24) ([releases](https://github.com/MrLesk/Backlog.md/releases)) | `main` @ 419ea1e, 2026-10-07 | TypeScript on Bun / MIT | ~7.0k (unverified) |
| git-bug | 0.11.0 (22 Sep 2026) ([release](https://github.com/git-bug/git-bug/releases/tag/v0.11.0)) | `trunk` @ ed5b08a, 2026-10-06 (trunk has since moved to d57831d, 2026-10-10) | Go / GPLv3 ([LICENSE](https://github.com/git-bug/git-bug/blob/trunk/LICENSE)) | ~10.7k (unverified) |
| Taskmaster (`task-master-ai`) | 0.43.1 (2026-03-31); `rc` tag 1.0.0-rc.1 (2026-02-18) ([npm registry](https://registry.npmjs.org/task-master-ai)) | `main` @ c0c98d3, 2026-04-23 | JS/TS / MIT + Commons Clause ([README](https://github.com/eyaltoledano/claude-task-master/blob/main/README.md)) | ~28.2k |

Star counts for beads and Taskmaster were re-read from the GitHub repo pages on 2026-10-11. The GitHub REST API was rate-limited during fact-checking, so the other star counts are carried over unverified. `github.com/steveyegge/beads` returns a 301 to `gastownhall/beads`. The Go module path is still `github.com/steveyegge/beads`.

---

## 1. beads (`bd`)

beads describes itself as a "Distributed graph issue tracker for AI agents, powered by Dolt" ([README](https://github.com/gastownhall/beads/blob/main/README.md)). It is the most influential tool in this space. Its storage history is also the most useful lesson for grimoire.

### Storage

**Current design (Dolt, the default since 0.50.0).**
- Issue data lives in a Dolt database (a version-controlled SQL engine):
  - embedded mode (the default) keeps it in `.beads/embeddeddolt/` with a single writer;
  - server mode (`bd init --server`) uses an external `dolt sql-server` in `.beads/dolt/` and supports multiple concurrent writers.

  Both database directories are gitignored, along with the server-mode `.pid`, `.log` and `.port` files. Only `metadata.json` and `config.yaml` are tracked. `bd init` writes a `.beads/.gitignore` to enforce this ([architecture](https://github.com/gastownhall/beads/blob/main/docs/architecture/index.md)).
- Cross-machine sync is `bd dolt push` / `bd dolt pull` to `refs/dolt/data` on your git remote, "separate from source branches". **Fresh clones have to run `bd bootstrap`** to clone that Dolt history ([sync concepts](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md)).
- `.beads/issues.jsonl` is "an export for viewers and interchange, not the source of truth or a backup" ([README](https://github.com/gastownhall/beads/blob/main/README.md)). JSONL import is upsert-only, so it "cannot infer that records absent from an export were deleted" ([sync concepts](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md)). Auto-export is optional, and non-interactive init leaves it at its default, which is disabled ([`bd init`](https://github.com/gastownhall/beads/blob/main/docs/cli-reference/init.md)).
- Merges: Dolt does cell-level merge, and "Concurrent changes merge automatically at the field level" ([architecture](https://github.com/gastownhall/beads/blob/main/docs/architecture/index.md)). beads' own rationale: "Unlike plain SQLite (binary merge conflicts) or JSONL (slow queries), Dolt gives you both fast SQL queries and proper merge semantics" (same page).

**Earlier design (2025 to Feb 2026; v0.40.0 docs).** This is the design grimoire's constraints most resemble.
- A gitignored SQLite cache (`.beads/beads.db`) sat in front of a git-tracked `.beads/issues.jsonl`, described as "Git-tracked source of truth / One JSON line per entity / Merge-friendly: additions rarely conflict" ([v0.40.0 ARCHITECTURE](https://github.com/gastownhall/beads/blob/v0.40.0/docs/ARCHITECTURE.md)).
- Writes went to SQLite, marked rows dirty, then exported to JSONL after a 5-second debounce.
- After a `git pull`, the first command auto-imported the JSONL by comparing content hashes.
- A per-workspace daemon (Unix socket, or named pipes on Windows) batched the exports.
- Merges needed a custom field-level three-way JSONL merge driver, registered with `git config merge.beads.driver "bd merge %A %O %A %B"` plus a `.gitattributes` line, `.beads/issues.jsonl merge=beads` ([v0.40.0 GIT_INTEGRATION](https://github.com/gastownhall/beads/blob/v0.40.0/docs/GIT_INTEGRATION.md)).
- Deletions needed tombstones with a 30-day TTL, or deleted issues would "resurrect" on import ([v0.40.0 DELETIONS](https://github.com/gastownhall/beads/blob/v0.40.0/docs/DELETIONS.md)).

**The teardown** ([CHANGELOG](https://github.com/gastownhall/beads/blob/main/CHANGELOG.md)).
- **0.50.0 (2026-02-14):** Dolt became the default for new `bd init` projects, and beads "Removed daemon/RPC subsystem … (~19,663 lines)" and "Removed JSONL sync layer … (~7,634 lines)".
- **0.51.0 (2026-02-16):** an 8-phase "Dolt-native cleanup" removed the 3-way merge engine, the tombstone/soft-delete system and the JSONL sync layer, and listed "Remove SQLite backend entirely" as one phase.
- **0.52.0:** deleted the JSONL sync-branch pipeline (about 11,000 more lines).
- **0.58.0 (2026-03-02):** "Beads Classic SQLite backend … removed. Dolt is the only backend."
- In total, well over 27k lines were removed.

**Community reaction.** Third-party forks and rewrites cite this complexity. These are their opinions, not beads' own statements:
- tk exists "without the need for keeping a SQLite file in sync or a rogue background daemon mangling your changes" ([ticket README](https://github.com/wedow/ticket/blob/master/README.md)).
- beads_rust (`br`) deliberately "freezes the 'classic beads' architecture" of SQLite plus JSONL ([beads_rust README](https://github.com/Dicklesworthstone/beads_rust/blob/main/README.md)).

### IDs

- IDs are hash-based with a prefix (`bd-a1b2`), "generated from issue title, creation timestamp, random salt" ([hash IDs](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/hash-ids.md)). The v0.40 docs instead said they were "derived from random UUIDs" ([v0.40.0 ARCHITECTURE](https://github.com/gastownhall/beads/blob/v0.40.0/docs/ARCHITECTURE.md)).
- Length adapts to database size: 4 characters for 0-500 issues, 5 for 501-1,500, then 6. The alphabet is lowercase alphanumeric, so N = 36^length. The thresholds come from birthday-paradox math, P ≈ 1 − e^(−n²/2N): about 7% at 500 issues with 4 characters and about 2% at 1,500 with 5 ([adaptive IDs](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/adaptive-ids.md)).
- When an ID clashes at create time, beads retries at base length, base+1 and base+2, with 10 nonces per length (30 attempts). A collision found on import gets a disambiguator ([hash IDs](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/hash-ids.md)).
- Hierarchical child IDs (`bd-a3f8.1`, up to 3 levels) "auto-increment" (same page).
  - *Inference, not verified:* a per-parent counter can reintroduce collisions when two branches add children to the same parent at the same time.
- Partial IDs are accepted for reads and most writes. `bd comment` deliberately requires the full ID, because "an abbreviation that happens to be a leading-prefix match for the wrong issue would silently write the comment there" (same page).

### Concurrency

- Embedded mode is single-writer. Server mode allows multiple concurrent writers ([README](https://github.com/gastownhall/beads/blob/main/README.md)).
- `bd update <id> --claim` atomically claims an issue ("sets assignee to you, status to in_progress"), and `bd ready --claim` claims the next ready item ([coordination](https://github.com/gastownhall/beads/blob/main/docs/multi-agent/coordination.md)).
- **Leases are already released** (CHANGELOG 1.2.x section). A claim stamps `lease_expires_at` (default TTL 5 minutes). `bd heartbeat <id>` extends the lease. `bd reclaim --older-than <dur>` returns expired claims to ready, and later releases added replica-aware reclaim and `--any-replica`. The lease fields are listed in the [architecture](https://github.com/gastownhall/beads/blob/main/docs/architecture/index.md) doc.
- **Unreleased** (CHANGELOG `[Unreleased]`): an `--if-revision` optimistic-concurrency guard on the lifecycle verbs (a stale revision exits with code 13), and `bd reclaim` exposed over `bd serve` as `POST /v0/beads/issues:reclaim`.
- The docs warn about race conditions when several clones sync at once ([architecture](https://github.com/gastownhall/beads/blob/main/docs/architecture/index.md)).

### Agent interface

The CLI with `--json` comes first.

**How agents are told.** `bd init` "creates or updates `AGENTS.md` by default" and "installs the project Claude Code, Codex, and Cursor integrations unless you pass `--skip-agents` or `--stealth`" ([README](https://github.com/gastownhall/beads/blob/main/README.md)). Managed sections carry versioned markers (`# --- BEGIN BEADS INTEGRATION vX.Y.Z ---`) ([doctor/git.go](https://github.com/gastownhall/beads/blob/main/cmd/bd/doctor/git.go)).

**Claude Code.** `bd setup claude` installs a SessionStart hook that runs `bd prime --hook-json`, and adds a minimal CLAUDE.md section (skipped if CLAUDE.md is a symlink) ([Claude Code integration](https://github.com/gastownhall/beads/blob/main/docs/integrations/claude-code.md)):
- "SessionStart also fires after context compaction, so the same hook refreshes context automatically." This matches Claude Code's hook docs, where SessionStart matchers are `startup`, `resume`, `clear`, `compact` (and `fork`), and plain stdout and `additionalContext` are added to context ([Claude Code hooks](https://code.claude.com/docs/en/hooks)).
- `bd prime` injects "~1-2k tokens", whereas "MCP tool schemas can add 10-50k tokens to every request".
- On skills, the same page says "Beads doesn't ship or require Claude Skills … Skills are also Claude-specific".

**Codex.** `bd setup codex` writes four things ([Codex integration](https://github.com/gastownhall/beads/blob/main/docs/integrations/codex.md)):
- `.agents/skills/beads/`
- a managed `AGENTS.md` section
- `.codex/config.toml` with `[features].hooks = true`
- `.codex/hooks.json` with SessionStart, PreCompact, PostCompact and UserPromptSubmit hooks. "`PreCompact` alone does not inject context because Codex ignores plain stdout from compact hooks"; instead, a post-compact marker triggers a refresh on the first prompt after compaction.

The beads docs say Codex 0.129.0+ is needed for these hooks; this was not checked against Codex's own release notes. **Current Codex docs** ([Codex hooks](https://learn.chatgpt.com/docs/hooks)) add three points:
- "Hooks are enabled by default"; `[features] hooks` is only needed to *disable* them.
- "Before a non-managed hook can run, Codex requires you to review and trust the exact hook definition", which you do via `/hooks`.
- "Project-local hooks load only when the project's `.codex/` layer is trusted."

So hooks written by `init` do not take effect silently.

**MCP.** `beads-mcp` is a separate Python package (`uv tool install beads-mcp`).
- It is meant "only where the CLI is unavailable, such as Claude Desktop".
- Tools: `ready`, `list`, `show`, `create`, `claim`, `update`, `close`/`reopen`, `dep`, `comment`/`comments`, `note`, `blocked`, `stats`/`context`, `admin`, `discover_tools`/`get_tool_info`. "There is no MCP sync tool" ([MCP server](https://github.com/gastownhall/beads/blob/main/docs/integrations/mcp-server.md)).
- It cuts context with lazy schema discovery and minimal list models ([CONTEXT_ENGINEERING](https://github.com/gastownhall/beads/blob/main/integrations/beads-mcp/CONTEXT_ENGINEERING.md)).

**HTTP.** `bd serve` / `bd connect` is an HTTP backend with a versioned wire format (`/v0/...`, `wire_revision`) ([README](https://github.com/gastownhall/beads/blob/main/README.md)).

### Install, runtime and footprint

- Install with `brew install beads` (recommended), `npm install -g @beads/bd`, the install script, `go install`, Windows `install.ps1` (`irm … | iex`), or the AUR. **winget is not a documented install path**: the only mention is an old CHANGELOG entry about preparing a manifest. On Windows, `go install` builds a server-mode-only binary ([installation](https://github.com/gastownhall/beads/blob/main/docs/getting-started/installation.md)). The README warns "don't clone this repo into your project".
- There has been no daemon since 0.59.0 (2026-03-05): "the bd daemon has been fully removed; bd is now purely CLI-driven" ([CHANGELOG](https://github.com/gastownhall/beads/blob/main/CHANGELOG.md)). Server mode adds `.pid`, `.log` and `.port` runtime files.
- Footprint in the host repo: `.beads/`, AGENTS.md and CLAUDE.md sections, `.claude/settings.json` hooks, `.codex/*`, `.agents/skills/beads`, and git hooks. The pre-commit hook refreshes the JSONL export when `export.auto=true` ([sync concepts](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md)).
- `--stealth` uses `.git/info/exclude` so nothing gets committed ([`bd init`](https://github.com/gastownhall/beads/blob/main/docs/cli-reference/init.md)).

### Dashboard

- There is no first-party web UI. The community-tools page lists many community UIs, for example `npx beads-ui start` and "Bead Me Up, Scotty", which has "live updates via SSE that react the moment `.beads/` changes" and "human-vs-agent attribution" ([community tools](https://github.com/gastownhall/beads/blob/main/docs/community-tools.md)). Most of them read and write through the `bd` CLI.
- **Events journal.** An ordered, cursor-resumable feed of committed mutations ("The spirit is a binlog"), written in the same transaction as the mutation. It is **off by default** and local to one clone ([events journal](https://github.com/gastownhall/beads/blob/main/docs/reference/events-journal.md)).
  - It shipped in **1.2.x**: the CHANGELOG lists "A durable events journal, and `bd events` to read it" under 1.2.1 (2026-08-11). 1.3.0 added actor attribution.
  - `bd events tail --follow` polls once a second.

### Relations

- **Dependency types:** `blocks`, `parent-child`, `related` and `discovered-from`. `bd ready` lists work with no open blockers ([architecture](https://github.com/gastownhall/beads/blob/main/docs/architecture/index.md), [dependencies](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/dependencies.md)).
- **Graph links:** `relates-to`, `duplicates`, `supersedes` and `replies-to` ([README](https://github.com/gastownhall/beads/blob/main/README.md)).
- **Also supported:** labels ([labels](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/labels.md)), assignee, comments, close reason, and a `--session` on close (or the `CLAUDE_SESSION_ID` env var).
- **Statuses:** `open`, `in_progress`, `blocked`, `deferred`, `closed`, `pinned`, `hooked`, extendable through `status.custom`.
- **Other:** typed issues including `epic`, `decision` and `gate`; cross-repo `external:` dependencies; gates (`await_type`, `await_id`, `timeout`); a free-form `metadata` field.

### Memory and knowledge (compared with WikiSkill)

- **Memories.** `bd remember "insight"` stores project facts, and `bd prime` injects them at session start ([remember](https://github.com/gastownhall/beads/blob/main/docs/cli-reference/remember.md)).
  - Budgets: `prime.max-memories` and `prime.max-memory-chars` cap what gets injected, both 0 (unlimited) by default. `memories.budget-chars` caps the whole corpus, and `bd remember` refuses a write that would cross it unless you pass `--force` ([configuration](https://github.com/gastownhall/beads/blob/main/docs/reference/configuration.md)).
  - These are flat facts, not pattern pages.
- **Semantic compaction ("memory decay").** Closed issues get summarized, and "original content is discarded" ([admin compact](https://github.com/gastownhall/beads/blob/main/docs/cli-reference/admin.md)).
  - Modes: "Analyze: Export candidates for agent review (no API key needed)", "Apply: Accept agent-provided summary (no API key needed)", and "Auto: AI-powered compaction (requires ANTHROPIC_API_KEY or ai.api_key, legacy)".
  - The analyze/apply split is a direct precedent for grimoire's "no own API key" rule.
  - Destroying originals is the opposite of WikiSkill's immutable raw traces.
- **Wisps.** Ephemeral execution-trace issues. They are "excluded from federation push by default, so execution traces never enter shared history" ([architecture](https://github.com/gastownhall/beads/blob/main/docs/architecture/index.md)).

---

## 2. Backlog.md

"Markdown‑native Task Manager & Kanban visualizer for any Git repository" ([README](https://github.com/MrLesk/Backlog.md/blob/main/README.md)). It is the closest existing match to grimoire's plain-files-in-repo constraint.

### Storage

- One `.md` file per task in `backlog/tasks/`, named like `back-200 - Title.md` ([dogfood tasks](https://github.com/MrLesk/Backlog.md/tree/main/backlog/tasks)).
- YAML frontmatter fields ([serializer](https://github.com/MrLesk/Backlog.md/blob/main/src/markdown/serializer.ts)):
  - `id`, `title`, `status`, `type`, `priority`, `assignee[]`, `reporter`, `labels[]`, `milestone`, `project`
  - `created_date`, `updated_date`
  - `dependencies[]`, `references`, `modified_files`, `parent_task_id`, `ordinal`
- The body is split into sections by HTML comment markers: description, `<!-- AC:BEGIN/END -->` (acceptance criteria), Definition of Done, plan, notes, final summary and `<!-- COMMENTS:BEGIN/END -->`. Inside the comments block, standalone `---` lines are reserved as comment delimiters ([structured-sections](https://github.com/MrLesk/Backlog.md/blob/main/src/markdown/structured-sections.ts), [CLI reference](https://github.com/MrLesk/Backlog.md/blob/main/CLI-INSTRUCTIONS.md)).
- Sibling folders: `drafts/`, `completed/`, `archive/`, `docs/`, `decisions/`, `milestones/`, plus `config.yml`. The folder can be `backlog/`, `.backlog/` or a custom path ([README](https://github.com/MrLesk/Backlog.md/blob/main/README.md)).
- Everything is plain committed files. There is no database or cache.
- Derived data is computed at read time and never stored. `dependencyGraph` "is derived from the whole visible corpus at read time and never stored in the Markdown file", and `isReady` is "derived from the whole visible corpus at read time and never stored" ([CLI reference](https://github.com/MrLesk/Backlog.md/blob/main/CLI-INSTRUCTIONS.md)).
- `autoCommit` defaults to `false` ([ADVANCED-CONFIG](https://github.com/MrLesk/Backlog.md/blob/main/ADVANCED-CONFIG.md)).
- Git merges (inference, not verified): different tasks never conflict because they live in different files. Concurrent edits to the same task, including two branches appending comments inside the same `COMMENTS` block, produce ordinary textual conflicts.

### IDs

- IDs are sequential and prefixed: `TASK-1` by default. The prefix is set with `backlog init --task-prefix` (stored as `task_prefix` in `config.yml`), and `zeroPaddedIds` pads the numbers ([README](https://github.com/MrLesk/Backlog.md/blob/main/README.md), [ADVANCED-CONFIG](https://github.com/MrLesk/Backlog.md/blob/main/ADVANCED-CONFIG.md)). Subtasks are dotted (`BACK-14.1`).
- `generateNextId` collects IDs from active and completed tasks across:
  - local branches;
  - remote branches, when `remoteOperations` is on (the default);
  - git worktrees.

  Only branches active within `activeBranchDays` count (default 30; the project's own config uses 10). The source says archived IDs are excluded and "can be reused" ([backlog.ts](https://github.com/MrLesk/Backlog.md/blob/main/src/core/backlog.ts)).
- Unpushed parallel work can still collide. There is a duplicate-repair module ([duplicate-task-repair.ts](https://github.com/MrLesk/Backlog.md/blob/main/src/core/duplicate-task-repair.ts)), and the docs point to `backlog doctor` for repairs. Dependency readiness lists "fail closed: an unknown or ambiguous dependency blocks instead of being treated as satisfied" ([CLI reference](https://github.com/MrLesk/Backlog.md/blob/main/CLI-INSTRUCTIONS.md)).

### Concurrency

Locks use `proper-lockfile` ([operations.ts](https://github.com/MrLesk/Backlog.md/blob/main/src/file-system/operations.ts)):

- **Create lock.** It lives at `<git-common-dir>/backlog.md/locks`, so every worktree of the repo on that machine shares it. Without git it falls back to `<backlog>/.locks`. The timeout is 30 s and stale detection is 10 s.
- **Per-task edit lock.** It "fails fast instead of waiting: on contention the caller (human or agent) decides whether to retry", with zero retries.
- `USE_GLOBAL_TASK_ID_LOCK=false` bypasses both locks.

### Agent interface

**How agents are told.** The default ("recommended") setup is CLI instructions. `init` writes a marker-delimited block (`<!-- BACKLOG.MD GUIDELINES START/END -->`) into AGENTS.md or CLAUDE.md. The block tells the agent to run `backlog instructions overview` "at the beginning of each conversation". The block also points to topic guides (`task-creation`, `task-execution`, `task-finalization`) ([AGENTS.md](https://github.com/MrLesk/Backlog.md/blob/main/AGENTS.md), [README](https://github.com/MrLesk/Backlog.md/blob/main/README.md)). `backlog agents --update-instructions` refreshes CLAUDE.md, AGENTS.md, GEMINI.md and `.github/copilot-instructions.md` ([CLI reference](https://github.com/MrLesk/Backlog.md/blob/main/CLI-INSTRUCTIONS.md)).

**MCP** is optional ([README](https://github.com/MrLesk/Backlog.md/blob/main/README.md), [MCP README](https://github.com/MrLesk/Backlog.md/blob/main/src/mcp/README.md)):
- It is stdio-only: `backlog mcp start`, registered with `claude mcp add backlog --scope user -- backlog mcp start` or `codex mcp add backlog -- backlog mcp start`.
- Tools: `task_create/list/search/edit/view/archive/complete`, `milestone_*`, `document_*`, `definition_of_done_defaults_*`.
- Resources: `backlog://workflow/overview`, `backlog://workflow/task-creation`, `backlog://workflow/task-execution`, `backlog://workflow/task-finalization` and `backlog://init-required`.
- One user-scope server "finds the active project from your client's MCP roots, and re-resolves when you switch workspace or worktree". `BACKLOG_CWD` pins it to one project.
- **Caveat:** MCP Roots is deprecated in the current MCP spec (2026-07-28). See section 7.B.

**Scripting.** Read commands have "stable, versioned JSON" output. `task list --json --watch` streams full replacement lists ([README](https://github.com/MrLesk/Backlog.md/blob/main/README.md)). `onStatusChange` runs a shell hook; the documented example launches `claude` ([ADVANCED-CONFIG](https://github.com/MrLesk/Backlog.md/blob/main/ADVANCED-CONFIG.md)).

### Install, runtime and footprint

- Install with `npm i -g backlog.md`, Bun, Homebrew or Nix, or run without installing via `npx backlog.md …` ([README](https://github.com/MrLesk/Backlog.md/blob/main/README.md)).
- The npm package is a launcher (`scripts/cli.cjs`) plus platform-specific compiled binaries pulled in as `optionalDependencies` (darwin, linux and windows, each in x64 and arm64) ([package.json](https://github.com/MrLesk/Backlog.md/blob/main/package.json)).
- No daemon: "no server, no account, no telemetry".
- Footprint: the backlog folder and config, an optional AGENTS.md/CLAUDE.md block, and optional MCP config.

### Dashboard

- `backlog browser` serves a local Kanban. "The server listens on `127.0.0.1` and is not reachable from other devices"; the default port is 6420 ([README](https://github.com/MrLesk/Backlog.md/blob/main/README.md), [ADVANCED-CONFIG](https://github.com/MrLesk/Backlog.md/blob/main/ADVANCED-CONFIG.md)).
- Features: drag-and-drop, editing forms, an acceptance-criteria editor, and "Real-time updates across all views".
- Live updates come from `fs.watch` watchers feeding a Bun WebSocket push ([server](https://github.com/MrLesk/Backlog.md/blob/main/src/server/index.ts), [content-store](https://github.com/MrLesk/Backlog.md/blob/main/src/core/content-store.ts)).
- There is also a terminal UI (`backlog board`) and a Markdown board export.

### Relations

- Dependencies are stored in one direction only (`task.dependencies`). Dependents are the derived reverse ([CLI reference](https://github.com/MrLesk/Backlog.md/blob/main/CLI-INSTRUCTIONS.md)).
- Also: parent/subtasks, labels, multiple assignees (`defaultAssignee`), milestones, priority and due dates.
- Comments are "append-only discussion entries with optional author labels" (same page).
- `complete` keeps "its record and dependency links"; `archive` "removes incoming dependencies and task references".

### Memory and knowledge

- `docs/` and `decisions/` (ADR-style) entities are searchable alongside tasks.
- Each task carries implementation notes and a final summary, which form a durable record of the work.
- There is no automated distillation.
- The optional Groma.md integration keeps an architecture map in Open Knowledge Format 0.2 ([README](https://github.com/MrLesk/Backlog.md/blob/main/README.md)).

---

## 3. git-bug

"Fully integrated in git … doesn't pollute your project: no files are added in your project" ([README](https://github.com/git-bug/git-bug/blob/trunk/README.md)).

### Storage

- Each entity is a chain of git commits whose trees hold the `ops` (a JSON `OperationPack`), optional media, and Lamport-clock entries. The chain is stored under `refs/<namespace>/<id>` ([data model](https://github.com/git-bug/git-bug/blob/trunk/doc/design/data-model.md)). For bugs the namespace is `bugs` ([bug.go](https://github.com/git-bug/git-bug/blob/trunk/entities/bug/bug.go)).
- The model is an operation-based CRDT. State is "compiled" by replaying operations in order.
- Under concurrent edits, `git bug pull` merges the DAGs and orders operations deterministically by Lamport clock. Commits that break the clock rules are rejected.
- Cache and search index live in `.git/git-bug` and can be rebuilt. The v0.11.0 notes say that to downgrade you should "remove `.git/git-bug` and let the older version rebuild" ([v0.11.0](https://github.com/git-bug/git-bug/releases/tag/v0.11.0)).
- Sync uses `git bug push/pull` ([README](https://github.com/git-bug/git-bug/blob/trunk/README.md)). The default fetch refspec only covers `refs/heads/*` ([git book: refspec](https://git-scm.com/book/en/v2/Git-Internals-The-Refspec)), so a plain clone does not bring issues along.

### IDs

- An operation's ID is `hash(json(op))`, and each operation includes a random nonce. An entity's ID derives from its first operation. IDs are shown truncated to 7 characters, as git does ([data model](https://github.com/git-bug/git-bug/blob/trunk/doc/design/data-model.md)).
- There is no coordination and no cross-clone collision by construction.

### Concurrency

- The cache layer locks the repository "for its own usage, by writing a lock file" ([architecture](https://github.com/git-bug/git-bug/blob/trunk/doc/design/architecture.md)).
- v0.11.0 made entity commits atomic, "via a compare-and-swap on the ref" ([v0.11.0](https://github.com/git-bug/git-bug/releases/tag/v0.11.0)).

### Agent interface, install and UI

- Interfaces: the CLI, and a GraphQL API served by the web UI. New in v0.11.0 are subscriptions (`bugEvents`, `identityEvents`, `allEvents`) "to react to changes without polling" ([README](https://github.com/git-bug/git-bug/blob/trunk/README.md), [v0.11.0](https://github.com/git-bug/git-bug/releases/tag/v0.11.0)).
- No MCP and no agent integration: none appears in the repo README or the v0.11.0 notes.
- Bridges to GitHub, GitLab, Jira and Launchpad.
- It ships as a single Go binary: release archives, Homebrew (macOS), Nix, AUR, and on Windows either scoop or a zip ([INSTALLATION](https://github.com/git-bug/git-bug/blob/trunk/INSTALLATION.md)). Since 0.11.0, "`go install` no longer gives you a web UI".
- `git bug webui` runs a local HTTP server embedded in the binary. It was rewritten from scratch in v0.11.0. "Filters live in the URL", and it "doubles as a code browser". There is also a terminal UI, `git bug termui`.

### Relations and memory

- Supported: comments (including editing), labels, status and title.
- **Assignee ❌, Milestone ❌.** Boards are only partly implemented ([feature matrix](https://github.com/git-bug/git-bug/blob/trunk/doc/feature-matrix.md)). The matrix lists no dependencies or sub-issues.
- No memory features.
- The licence is GPLv3, so grimoire can read the code but must not copy it.

---

## 4. Taskmaster (`task-master-ai`)

"A task management system for AI-driven development" ([README](https://github.com/eyaltoledano/claude-task-master/blob/main/README.md)). It is built around generating tasks from a PRD with LLM calls.

### Storage

- One JSON file, `.taskmaster/tasks/tasks.json`, in a "tagged" format: `{ "master": { "tasks": [...] }, "feature-branch": { "tasks": [...] } }` ([task structure](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/task-structure.md)).
- Next to it: `.taskmaster/config.json` (model choices), `.taskmaster/state.json` (the current tag), and docs, reports and templates folders ([configuration](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/configuration.md)).
- An alternative `ApiStorage` adapter is backed by the Hamster cloud ([api-storage.ts](https://github.com/eyaltoledano/claude-task-master/blob/main/packages/tm-core/src/modules/storage/adapters/api-storage.ts)).
- **Under git merges:** "you might encounter merge conflicts in your tasks.json file if multiple team members create tasks on different branches". The documented fix is to ask the agent to renumber your tasks with `move` ([advanced tasks](https://github.com/eyaltoledano/claude-task-master/blob/main/apps/docs/best-practices/advanced-tasks.mdx)).

### IDs

Sequential integers within each tag. Subtasks use `taskId.subtaskId`. IDs collide across branches, as the docs' own example shows: "My teammates created tasks 10-15 while I created tasks 10-12".

### Concurrency

0.42.0 fixed a "race condition when multiple Claude Code windows write to tasks.json simultaneously" ([CHANGELOG](https://github.com/eyaltoledano/claude-task-master/blob/main/CHANGELOG.md)). The fix:
- added cross-process file locking;
- cleans up stale locks after a 10-second timeout;
- adopted a `modifyJson` atomic read-modify-write pattern.

### Agent interface and LLM use

**MCP is the "Recommended" option:** `npx -y task-master-ai` over stdio.
- "By default, all 36 tools are loaded (~21,000 tokens)".
- `TASK_MASTER_TOOLS=core`/`lean` (7 tools, ~5,000 tokens) or `standard` (15 tools, ~10,000 tokens) trims the set.
- API keys go in the MCP config's `env` block or in a project `.env` ([README](https://github.com/eyaltoledano/claude-task-master/blob/main/README.md)).

**Other surfaces:** a CLI (`task-master`), editor rule profiles, a Claude Code plugin ([CLAUDE_CODE_PLUGIN](https://github.com/eyaltoledano/claude-task-master/blob/main/CLAUDE_CODE_PLUGIN.md)), and an MCPB bundle for Claude Desktop (0.43.0).

**LLM calls.** AI commands (`parse-prd`, `expand`, `analyze-complexity`, `research`) need a provider:
- an API key;
- or the `claude-code` provider, which uses the Claude Code CLI's OAuth ([Claude Code integration](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/claude-code-integration.md));
- or the Codex CLI;
- or an `mcp` provider that uses MCP **sampling** when the client advertises it ([MCP provider](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/mcp-provider.md)). Sampling is now deprecated in the MCP spec (see 7.B).

**Loop.** `task-master loop` "Spawns `claude -p <prompt>` as a fresh subprocess" for each iteration, appends to a progress file (`.taskmaster/loop-progress.txt`), and stops on `<loop-complete>` or `<loop-blocked>` markers ([loop](https://github.com/eyaltoledano/claude-task-master/blob/main/apps/docs/capabilities/loop.mdx)).

### UI, relations and memory

- **UI.** A VS Code extension provides a Kanban board with "Auto-refresh - Automatic polling for task changes" ([extension README](https://github.com/eyaltoledano/claude-task-master/blob/main/apps/extension/README.md)). There is no standalone web dashboard in the repo.
- **Relations:**
  - `dependencies[]`, nested `subtasks`, `priority`, and statuses ([task structure](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/task-structure.md));
  - optional `tags` and `assignee` fields in the tm-core `Task` type ([types](https://github.com/eyaltoledano/claude-task-master/blob/main/packages/tm-core/src/common/types/index.ts));
  - no comments, and no labels or assignee in the documented file format.
- **Knowledge.** The `research` command and complexity reports; nothing comparable to WikiSkill.
- **Project status.** The last release is 0.43.1 (2026-03-31), and the `rc` dist-tag has stayed at 1.0.0-rc.1 since 2026-02-18 ([npm registry](https://registry.npmjs.org/task-master-ai)).

---

## 5. Other notable 2025-2026 entrants

- **kata** (wesm; 0.18.0, active) ([README](https://github.com/wesm/kata/blob/main/README.md)): bets the opposite way from grimoire.
  - Storage: "Issue state lives in SQLite under `KATA_HOME`; your repo commits only a small, secret-free `.kata.toml`". "The browser app is served by the daemon", and the CLI autostarts a local daemon. An optional remote daemon (Postgres via `KATA_DSN`) or federation handles team sync.
  - IDs: each issue has a ULID `uid`, and the short ID comes from "the lowercased suffix of that ULID and extends it if needed to avoid collisions" ([concepts](https://github.com/wesm/kata/blob/main/docs/guide/concepts.md)).
  - Relations: parent, blocks, related; plus labels, owner, comments, `--idempotency-key` on create, and evidence-bearing closes.
  - Agents: `kata init --with-agents` writes a managed briefing into AGENTS.md/CLAUDE.md; `--with-codex-hooks` writes `.codex/hooks.json`.
  - MCP over stdio or Streamable HTTP (`kata mcp serve`). "The initial catalog contains 16 read-only section loaders"; each loader reveals its tools with a `notifications/tools/list_changed` notification, "instead of placing all 74 tools in the model context at startup" ([MCP reference](https://github.com/wesm/kata/blob/main/docs/reference/mcp.md)).
- **beans** (hmans; last commit 2026-04-06) ([README](https://github.com/hmans/beans/blob/main/README.md)):
  - Storage: Markdown files with frontmatter in `.beans/`, committed. IDs are a prefix plus a NanoID suffix whose length is configurable (`id_length: 4` in the project's [.beans.yml](https://github.com/hmans/beans/blob/main/.beans.yml)).
  - Fields: `parent`, **both** `blocking` and `blocked_by`, `tags`, and a fractional-index `order`. There is no assignee or comments field ([bean.go](https://github.com/hmans/beans/blob/main/pkg/bean/bean.go)).
  - `beans prime` runs from Claude Code SessionStart and PreCompact hooks. A GraphQL query engine lets agents fetch only what they need. Completed beans are archived and "serve as project memory".
  - The web UI binary (`beans-serve`) spawns the `claude` CLI for agent sessions ([claude.go](https://github.com/hmans/beans/blob/main/internal/agent/claude.go)).
- **ticket / `tk`** (wedow) ([README](https://github.com/wedow/ticket/blob/master/README.md)): a single bash script that needs coreutils, plus `jq` for `query`.
  - Storage: `.tickets/*.md` with YAML frontmatter.
  - IDs: a directory-initials prefix plus 4 random `[a-z0-9]` characters from `/dev/urandom` ([script](https://github.com/wedow/ticket/blob/master/ticket)).
  - Commands: `dep`, `link`, `ready`/`blocked`, `--parent`, `--tags`, `-a` (assignee), `add-note`, `migrate-beads`.
  - Agents learn about it from one line in CLAUDE.md/AGENTS.md.
- **beads_rust (`br`)** ([README](https://github.com/Dicklesworthstone/beads_rust/blob/main/README.md)): keeps classic beads alive (SQLite plus JSONL, conformance checked against bd v0.46.0). It "never commits, pushes, pulls, installs hooks, or runs as a background service".
- **trekker** (obsfx) ([README](https://github.com/obsfx/trekker/blob/main/README.md)): runs on Bun with `bun:sqlite` (`.trekker/trekker.db`). A Claude Code plugin adds "26 MCP tools", 13 slash commands, 7 skills and 5 hooks, and "Blocks internal TaskCreate/TodoWrite". The dashboard is a separate npm package (`@obsfx/trekker-dashboard`).
- **Vibe Kanban** (BloopAI; about 28k stars, unverified): `npx vibe-kanban` gives a Kanban board plus per-issue agent workspaces for more than ten agent CLIs ([README](https://github.com/BloopAI/vibe-kanban/blob/main/README.md)).
  - On 2026-04-10 the team announced "Vibe Kanban is sunsetting. The project will continue as open source and community maintained" ([announcement](https://www.vibekanban.com/blog/shutdown)).
  - The hosted services, including cloud kanban issues, comments, projects and organisations, stayed up for 30 days and then went away. "Local workspaces will continue to function."
  - `npx vibe-kanban` is still the documented install, and npm `vibe-kanban` 0.1.45 was published on 2026-09-19.
- **Claude Code's built-in Tasks** ([Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)):
  - 2.1.16 "Added new task management system, including new capabilities like dependency tracking".
  - 2.1.233: the TaskCreate/Get/Update/List tools and TodoWrite are "no longer available on Opus 4.8, Sonnet 5, Fable 5, Mythos 5, and newer models". `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` brings them back.
  - 2.1.268 narrowed them further, to Claude 3.x, Opus 4.0–4.7, Sonnet 4.0–4.6 and Haiku 4.5.
  - Grimoire should not lean on these tools.
- **Adjacent format, not a tracker: Open Knowledge Format 0.2** ([SPEC](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md)). It is a bundle of Markdown "concept" files with YAML frontmatter, with reserved optional `index.md` ("Directory listing for progressive disclosure") and `log.md` ("Chronological history of updates"). Optional frontmatter covers:
  - provenance (`sources`)
  - trust (`generated` with `by`/`at`, `verified`, and `human:<id>` actors)
  - lifecycle (`status: draft|stable|deprecated`, `stale_after`)

  It maps closely onto WikiSkill's `wiki/` with `index.md` and `logs.md`. Note that OKF says `log.md` and WikiSkill says `logs.md`.

---

## 6. Comparison

| | beads 1.3 | Backlog.md 1.53 | git-bug 0.11 | Taskmaster 0.43 | kata 0.18 | beans / tk |
|---|---|---|---|---|---|---|
| Source of truth | Dolt DB (`refs/dolt/data`; `bd bootstrap` on fresh clones) | `.md` per task | git objects in `refs/bugs/*` | `tasks.json` | SQLite in `KATA_HOME` | `.md` per issue |
| On code branches? | No (JSONL export optional) | Yes | No | Yes | No (`.kata.toml` only) | Yes |
| ID scheme | hash, base36, 4-6 chars adaptive | sequential `PREFIX-n` | hash of first op | sequential int per tag | ULID + short suffix | prefix + 4-char random suffix (configurable in beans) |
| Cross-branch collisions | none (hash) | possible → `doctor` | none | yes → manual renumber | n/a (central DB) | rare (random) |
| Concurrency | single writer or server mode; `--claim`; leases + `reclaim` (released); `--if-revision` (unreleased) | create lock in git common dir + fail-fast per-task lock | repo lock + CAS on ref | cross-process file lock | daemon, claim flow | none / none |
| Agent interface | CLI + `bd prime` hooks; Python MCP sidecar; HTTP (`bd serve`) | CLI instructions (default) + stdio MCP | CLI + GraphQL | MCP (36 tools) + CLI | CLI + MCP (stdio/HTTP, progressive) | CLI + `prime` hook / CLI |
| Daemon | none since 0.59 | none | none (webui on demand) | none | yes (autostarted) | none |
| First-party UI | none (events journal for 3rd-party) | `backlog browser` (WS live) + TUI | `webui` (GraphQL subs) + TUI | VS Code ext. (polling) | `kata ui` + TUI | TUI + web (beans) / none |
| Labels / sub / blocking / assignee / comments | ✅ / ✅ / ✅ / ✅ / ✅ | ✅ / ✅ / ✅ / ✅ / ✅ | ✅ / ❌ / ❌ / ❌ / ✅ | (type field) / ✅ / ✅ / (type field) / ❌ | ✅ / ✅ / ✅ / ✅ / ✅ | tags / ✅ / ✅ / ❌(beans), ✅(tk) / ❌, notes(tk) |
| Memory | `remember`/`prime`, lossy compaction, wisps | docs/, decisions/ | none | research, reports | semantic search, evidence closes | archived beans |

---

## 7. Steal / avoid, mapped to grimoire's open decisions

### A. Storage and IDs

**Steal**
1. **One Markdown file per issue with YAML frontmatter** under `.grimoire/` (Backlog.md, beans, tk). Diffs are readable, agents can grep the files, and different issues never conflict in a git merge.
2. **Random short IDs, never sequential.** Use a prefix plus a short base36 or NanoID suffix (tk, beans), sized with beads' birthday-math adaptive length (4 → 5 → 6 base36 characters at 500 / 1,500 issues). Check for collisions against the local files at create time, and lengthen the ID on a clash (kata's approach, and beads' base/+1/+2 retry).
   - Note: the local check cannot see issues created concurrently on other branches. Those collisions only surface at merge time, so `doctor` (item 5) must catch them. The risk per pair of branches is roughly k₁·k₂/36^len.
3. **Files are the only source of truth; derived data is never committed.** Build the index in memory, as Backlog.md does. Any cache must be gitignored and disposable, like git-bug's `.git/git-bug`. Then git handles deletions natively and you don't need beads-style tombstones.
4. **Store each relation in one direction.** The child stores `parent`; the blocked issue stores `blocked_by`. Work out `children`, `blocks` and readiness when reading, and treat unknown or ambiguous IDs as blocking (Backlog.md).
5. **A `doctor` command** to find duplicate IDs, dangling references and cycles after merges (Backlog.md `doctor`, beads `doctor`).
6. **Fractional-index ordering strings** for manual ranking without rewriting siblings (beans `order`). Backlog.md uses a numeric `ordinal`.
7. *Inference:* make comments **append-only and one file each** (in the spirit of git-bug's operation packs), so two branches commenting on the same issue never conflict. Backlog.md's inline comments block cannot guarantee that.

**Avoid**
- Sequential IDs: Taskmaster's renumbering, and Backlog.md's cross-branch scans plus duplicate repair.
- Single-file stores (`tasks.json`, the old `issues.jsonl`), where every concurrent create touches the same file.
- Anything that needs a **git merge driver**. The driver is registered through per-clone `git config`, which can't be committed (beads v0.40).
- A dual DB-plus-export design with debounced sync, auto-import, tombstones and a daemon. beads removed about 27k lines of it in 0.50.0 alone, and more in 0.51.0–0.52.0.
- Custom refs or Dolt: they break the "committed in `.grimoire/`" constraint. The default refspec doesn't fetch them, and beads needs an extra `bd bootstrap` on fresh clones.
- Lossy compaction of records.

**Decision to make explicitly.** With files on branches, issue state is branch-scoped. For example, a `close` on a feature branch is invisible on main until the merge. Backlog.md mitigates this by reading the other branches and worktrees, at a performance cost. Choose between "tracker writes go to the default branch" and "the dashboard shows per-branch state".

### B. Agent interface

**Steal**
- **The CLI as the base contract**, with stable, versioned `--json` output and `--watch` (beads, Backlog.md, kata). Make `npm run grimoire` / `npx grimoire` the path skills call.
- **Inject context instead of relying on discovery.** Add a `grimoire prime` / `instructions` command (about 1-2k tokens) and topic guides read before lifecycle actions (Backlog.md).
  - Claude Code: wire `prime` to the SessionStart hook. Its `compact` matcher covers re-injection after compaction, and plain stdout or `additionalContext` reaches the model.
  - Codex: wire it to SessionStart, and recover after compaction with PostCompact plus UserPromptSubmit, as beads does. PreCompact and PostCompact stdout is ignored.
  - **Codex trust:** Codex project hooks run only after the user trusts the project's `.codex/` layer and reviews/trusts each non-managed hook via `/hooks`. Hooks are on by default, so `[features].hooks = true` is unnecessary. Grimoire's `init` must tell the user to approve the hooks, and `prime` must also be reachable from the AGENTS.md pointer.
- **Pointer files as managed, versioned, marker-delimited blocks** (`BEGIN … vX`), recorded in the manifest, so they can be updated idempotently (Backlog.md, beads).
  - Claude Code reads AGENTS.md only in a project with no CLAUDE.md (2.1.277; extended in 2.1.281 to Bedrock, Vertex, Foundry and gateways; switchable under "Project instructions" in `/config`) ([CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)). So write a CLAUDE.md block too, or an `@AGENTS.md` import.
  - Codex repo skills live in `.agents/skills`, from cwd up to the repo root; user skills in `$HOME/.agents/skills` ([Codex skills docs](https://learn.chatgpt.com/docs/build-skills)).
- **MCP that is small and typed.**
  - Aim for roughly 8-10 tools, with workflow guides as MCP resources (Backlog.md).
  - Both first-class clients now defer large MCP tool lists themselves:
    - Claude Code since 2.1.7, when tool descriptions exceed 10% of the context window (MCPSearch);
    - Codex since rust-v0.142.2: "MCP tools now use tool search by default when supported" ([release](https://github.com/openai/codex/releases/tag/rust-v0.142.2)).
  - So a small static tool list is enough. kata-style per-session progressive loaders via `tools/list_changed` fit poorly with the current MCP spec. MCP 2026-07-28 says list endpoints "no longer vary per-connection" on Streamable HTTP, and moves change notifications to opt-in `subscriptions/listen` ([MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)).
  - **Resolve the project from the stdio server's cwd or an explicit project-scoped config/env, not from MCP Roots.** Roots (and Sampling and Logging) are deprecated in MCP 2026-07-28 (SEP-2577), which recommends passing directories via tool parameters, resource URIs or server configuration. Claude Code 2.1.292 negotiates 2026-07-28 with stdio servers by default.
- **Agent-safety affordances:**
  - idempotency keys on create (kata), which protect `/to-tickets` reruns;
  - full IDs required for comment writes (beads);
  - atomic `claim` with a lease (beads);
  - a close reason and evidence (kata, beads);
  - fail-closed readiness (Backlog.md).
- **LLM work without a key:**
  - beads' **analyze/apply** split for the Wiki Maintainer and Skill Proposer: grimoire exports candidates, the agent's skill writes the page, and grimoire applies it behind a gate;
  - headless spawning of agents already installed, either `claude -p` (Taskmaster `loop`) or `codex exec`. `codex exec` reuses saved CLI auth by default, and offers `--json` JSONL events, `--output-schema`, and a read-only sandbox by default with `--sandbox workspace-write` to allow edits ([Codex non-interactive docs](https://learn.chatgpt.com/docs/non-interactive-mode)).

**Avoid**
- Large default tool sets (Taskmaster: 36 tools, about 21k tokens). Client-side tool search in both Claude Code and Codex softens the cost but doesn't remove it.
- API keys in MCP config `env` blocks or `.env` (Taskmaster).
- A second-runtime MCP sidecar (beads-mcp is Python).
- Depending on MCP **sampling**. Sampling is deprecated in the current MCP spec (2026-07-28, SEP-2577), and no Claude Code changelog entry mentions sampling support.
- Depending on MCP **Roots** for project discovery (deprecated, as above).
- Depending on Claude Code's built-in Task tools, which are off by default on current models.

### C. What `start` runs

- **Evidence:**
  - beads removed its daemon in 0.59.0: "bd is now purely CLI-driven".
  - Backlog.md has no daemon. `backlog browser` is a foreground server, and MCP is a stdio process each client spawns.
  - git-bug serves `webui` on demand.
  - kata autostarts a local daemon.
  - Vibe Kanban's `npx vibe-kanban` (server, UI and agent workspaces in one command) survives as a community-maintained local app; only its hosted cloud features were shut down.
- **Recommendation:**
  - `start` is a foreground process: a 127.0.0.1 dashboard server, a filesystem watcher, and optionally the knowledge-layer jobs, which call agent CLIs headlessly.
  - `grimoire mcp` is a separate stdio process that the client launches and that does not depend on `start`.
  - The CLI, MCP and dashboard all share one core library that writes the files under locks. Follow Backlog.md's lock layout: the create lock in the git common dir (shared across worktrees) and fail-fast per-issue locks.
  - Add a beads-style revision/content-hash guard so the dashboard and agents don't silently overwrite each other (beads' `--if-revision` is still unreleased, so this is a design idea, not proven practice).
- **Windows (Node 24):**
  - Prefer pure JS. `node:sqlite` was unflagged in v22.13.0/v23.4.0 but "still experimental", and only became a release candidate (Stability 1.2) in v25.7.0 ([Node docs](https://nodejs.org/api/sqlite.html)). On Node 22/24 it is experimental, so an in-memory index is the safer choice.
  - Backlog.md's tests check that CRLF line endings are preserved. That is a reminder to decide on line-ending handling in `.grimoire/`.

### D. Dashboard

**Steal**
- Bind only to 127.0.0.1 (Backlog.md).
- A Kanban board plus an issue detail editor.
- Push updates over WebSocket or SSE, triggered by watching the files (Backlog.md WS; "Scotty" SSE on `.beads/` changes).
- Filters stored in the URL (git-bug 0.11).
- Attribution of human versus agent edits, and "waiting on you" / attention lanes (beads community UIs, kata `work.attention`).
- Optionally, show issue state from other branches and worktrees (Backlog.md).

**Avoid**
- Having no first-party UI. beads ended up with many community UIs that each re-wrap the CLI.
- A separately installed dashboard package (trekker).
- Polling-only refresh (Taskmaster's VS Code extension; even beads' `bd events tail --follow` polls once a second).
- UI writes that bypass the core's validation and write path.

### E. Knowledge layer (WikiSkill)

- No tracker distils traces into pattern pages or proposes skills. beads' flat `remember`/`prime` memories are the nearest thing, and its compaction destroys raw records, which conflicts with WikiSkill's immutable traces.
- Worth borrowing:
  - budget-capped injection at prime time (beads `prime.max-memories` / `prime.max-memory-chars`);
  - analyze/apply for LLM steps;
  - evidence-bearing closes, final summaries and implementation notes as raw-trace inputs (kata, Backlog.md);
  - OKF 0.2's `index.md`/`log.md` conventions and its provenance, trust and lifecycle frontmatter for wiki pages.
- beads keeps execution traces out of shared history ("wisps"). Grimoire commits raw traces, so plan for their size and retention.

## 8. Minimal v1 set (synthesis, not sourced)

**Data model:** this is the consensus across beads, kata, Backlog.md and tk, cut to what `/to-tickets`, `/triage` and `/wayfinder` need.
- One issue file, `.grimoire/issues/<id>.md`, with frontmatter:
  - `id`, `title`, `status` (open | in_progress | closed), `close_reason`
  - `labels[]`, `parent`, `blocked_by[]`, `assignee`
  - `created_at`, `updated_at`
- A Markdown body.
- Comments as append-only files, one per comment, under the issue.
- Derived only, never stored: `children`, `blocks`, `ready`, `blocked`.

**Commands and tools** (the CLI and MCP share one core):

| Command / tool | What it covers |
|---|---|
| `create` | parent, labels, `blocked_by`, idempotency key |
| `show` | one issue |
| `list` / `ready` | filters |
| `update` | labels ±, assignee, status, parent, block/unblock |
| `claim` | atomic assignee + in_progress |
| `comment` | full ID required |
| `close` | reason |
| `prime` / `instructions` | agent context |
| `doctor` | duplicates, dangling references, cycles |

## Unverified or inferred

- **beads child IDs:** that per-parent auto-increment can collide across branches is an inference.
- **Backlog.md comments:** that same-task comment appends conflict across branches is an inference from the inline comments block.
- **Popularity numbers:** beads (27.8k) and Taskmaster (28.2k) were re-checked on GitHub. Backlog.md, git-bug and Vibe Kanban counts were not, because the GitHub API was rate-limited.
- **Codex hook minimum version (0.129.0):** this comes from the beads docs only, not Codex's release notes.
- **Codex tool-search release year:** the release page shows "25 Jun" with no year. The year (2026) comes from third-party changelog mirrors.
- **Claude Code project-hook trust:** whether Claude Code also gates project `.claude/settings.json` hooks behind workspace trust was not checked.

## Sources

- beads:
  - [README](https://github.com/gastownhall/beads/blob/main/README.md)
  - [architecture](https://github.com/gastownhall/beads/blob/main/docs/architecture/index.md)
  - [sync concepts](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md)
  - [hash IDs](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/hash-ids.md)
  - [adaptive IDs](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/adaptive-ids.md)
  - [dependencies](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/dependencies.md)
  - [labels](https://github.com/gastownhall/beads/blob/main/docs/core-concepts/labels.md)
  - [coordination](https://github.com/gastownhall/beads/blob/main/docs/multi-agent/coordination.md)
  - [MCP server](https://github.com/gastownhall/beads/blob/main/docs/integrations/mcp-server.md)
  - [beads-mcp context engineering](https://github.com/gastownhall/beads/blob/main/integrations/beads-mcp/CONTEXT_ENGINEERING.md)
  - [Claude Code](https://github.com/gastownhall/beads/blob/main/docs/integrations/claude-code.md)
  - [Codex](https://github.com/gastownhall/beads/blob/main/docs/integrations/codex.md)
  - [installation](https://github.com/gastownhall/beads/blob/main/docs/getting-started/installation.md)
  - [bd init](https://github.com/gastownhall/beads/blob/main/docs/cli-reference/init.md)
  - [bd admin](https://github.com/gastownhall/beads/blob/main/docs/cli-reference/admin.md)
  - [bd remember](https://github.com/gastownhall/beads/blob/main/docs/cli-reference/remember.md)
  - [configuration](https://github.com/gastownhall/beads/blob/main/docs/reference/configuration.md)
  - [events journal](https://github.com/gastownhall/beads/blob/main/docs/reference/events-journal.md)
  - [community tools](https://github.com/gastownhall/beads/blob/main/docs/community-tools.md)
  - [CHANGELOG](https://github.com/gastownhall/beads/blob/main/CHANGELOG.md)
  - [releases](https://github.com/gastownhall/beads/releases)
  - [doctor/git.go](https://github.com/gastownhall/beads/blob/main/cmd/bd/doctor/git.go)
  - [v0.40.0 ARCHITECTURE](https://github.com/gastownhall/beads/blob/v0.40.0/docs/ARCHITECTURE.md)
  - [v0.40.0 GIT_INTEGRATION](https://github.com/gastownhall/beads/blob/v0.40.0/docs/GIT_INTEGRATION.md)
  - [v0.40.0 DELETIONS](https://github.com/gastownhall/beads/blob/v0.40.0/docs/DELETIONS.md)
- Backlog.md:
  - [README](https://github.com/MrLesk/Backlog.md/blob/main/README.md)
  - [CLI-INSTRUCTIONS](https://github.com/MrLesk/Backlog.md/blob/main/CLI-INSTRUCTIONS.md)
  - [ADVANCED-CONFIG](https://github.com/MrLesk/Backlog.md/blob/main/ADVANCED-CONFIG.md)
  - [package.json](https://github.com/MrLesk/Backlog.md/blob/main/package.json)
  - [src/core/backlog.ts](https://github.com/MrLesk/Backlog.md/blob/main/src/core/backlog.ts)
  - [src/file-system/operations.ts](https://github.com/MrLesk/Backlog.md/blob/main/src/file-system/operations.ts)
  - [duplicate-task-repair.ts](https://github.com/MrLesk/Backlog.md/blob/main/src/core/duplicate-task-repair.ts)
  - [src/mcp/README.md](https://github.com/MrLesk/Backlog.md/blob/main/src/mcp/README.md)
  - [src/server/index.ts](https://github.com/MrLesk/Backlog.md/blob/main/src/server/index.ts)
  - [content-store.ts](https://github.com/MrLesk/Backlog.md/blob/main/src/core/content-store.ts)
  - [structured-sections.ts](https://github.com/MrLesk/Backlog.md/blob/main/src/markdown/structured-sections.ts)
  - [serializer.ts](https://github.com/MrLesk/Backlog.md/blob/main/src/markdown/serializer.ts)
  - [AGENTS.md](https://github.com/MrLesk/Backlog.md/blob/main/AGENTS.md)
  - [backlog/tasks](https://github.com/MrLesk/Backlog.md/tree/main/backlog/tasks)
  - [releases](https://github.com/MrLesk/Backlog.md/releases)
- git-bug:
  - [README](https://github.com/git-bug/git-bug/blob/trunk/README.md)
  - [data model](https://github.com/git-bug/git-bug/blob/trunk/doc/design/data-model.md)
  - [architecture](https://github.com/git-bug/git-bug/blob/trunk/doc/design/architecture.md)
  - [feature matrix](https://github.com/git-bug/git-bug/blob/trunk/doc/feature-matrix.md)
  - [INSTALLATION](https://github.com/git-bug/git-bug/blob/trunk/INSTALLATION.md)
  - [bug.go](https://github.com/git-bug/git-bug/blob/trunk/entities/bug/bug.go)
  - [v0.11.0 release](https://github.com/git-bug/git-bug/releases/tag/v0.11.0)
- Taskmaster:
  - [README](https://github.com/eyaltoledano/claude-task-master/blob/main/README.md)
  - [task-structure](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/task-structure.md)
  - [configuration](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/configuration.md)
  - [advanced-tasks](https://github.com/eyaltoledano/claude-task-master/blob/main/apps/docs/best-practices/advanced-tasks.mdx)
  - [CHANGELOG](https://github.com/eyaltoledano/claude-task-master/blob/main/CHANGELOG.md)
  - [tm-core types](https://github.com/eyaltoledano/claude-task-master/blob/main/packages/tm-core/src/common/types/index.ts)
  - [api-storage.ts](https://github.com/eyaltoledano/claude-task-master/blob/main/packages/tm-core/src/modules/storage/adapters/api-storage.ts)
  - [mcp-provider](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/mcp-provider.md)
  - [claude-code-integration](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/claude-code-integration.md)
  - [loop](https://github.com/eyaltoledano/claude-task-master/blob/main/apps/docs/capabilities/loop.mdx)
  - [extension README](https://github.com/eyaltoledano/claude-task-master/blob/main/apps/extension/README.md)
  - [CLAUDE_CODE_PLUGIN](https://github.com/eyaltoledano/claude-task-master/blob/main/CLAUDE_CODE_PLUGIN.md)
  - [npm registry](https://registry.npmjs.org/task-master-ai)
- Other trackers:
  - kata [README](https://github.com/wesm/kata/blob/main/README.md), [MCP](https://github.com/wesm/kata/blob/main/docs/reference/mcp.md), [concepts](https://github.com/wesm/kata/blob/main/docs/guide/concepts.md)
  - beans [README](https://github.com/hmans/beans/blob/main/README.md), [.beans.yml](https://github.com/hmans/beans/blob/main/.beans.yml), [bean.go](https://github.com/hmans/beans/blob/main/pkg/bean/bean.go), [claude.go](https://github.com/hmans/beans/blob/main/internal/agent/claude.go)
  - ticket [README](https://github.com/wedow/ticket/blob/master/README.md), [script](https://github.com/wedow/ticket/blob/master/ticket)
  - [beads_rust README](https://github.com/Dicklesworthstone/beads_rust/blob/main/README.md)
  - [trekker README](https://github.com/obsfx/trekker/blob/main/README.md)
  - Vibe Kanban [README](https://github.com/BloopAI/vibe-kanban/blob/main/README.md), [shutdown announcement](https://www.vibekanban.com/blog/shutdown), [npm](https://registry.npmjs.org/vibe-kanban)
- Platform docs and formats:
  - [Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
  - [Claude Code hooks](https://code.claude.com/docs/en/hooks)
  - [Codex skills](https://learn.chatgpt.com/docs/build-skills) (developers.openai.com/codex/skills 308-redirects here)
  - [Codex hooks](https://learn.chatgpt.com/docs/hooks)
  - [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) (developers.openai.com/codex/noninteractive 308-redirects here)
  - [Codex rust-v0.142.2 release](https://github.com/openai/codex/releases/tag/rust-v0.142.2)
  - [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog), [MCP versioning](https://modelcontextprotocol.io/specification/versioning)
  - [Node.js node:sqlite](https://nodejs.org/api/sqlite.html)
  - [Git refspec](https://git-scm.com/book/en/v2/Git-Internals-The-Refspec)
  - [Open Knowledge Format 0.2 SPEC](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md)
- Repo metadata: GitHub repo pages and `git ls-remote --tags`, 2026-10-11. The GitHub REST API was rate-limited.

## Verification notes

**Method.** I made fresh shallow clones on 2026-10-11 of these repos and grepped them directly:
- gastownhall/beads @ 76d5bf6, plus the v0.40.0 tag
- MrLesk/Backlog.md @ 419ea1e
- git-bug/git-bug @ d57831d
- eyaltoledano/claude-task-master @ c0c98d3
- wesm/kata @ c3c84db
- hmans/beans @ 99260bf
- wedow/ticket @ 194b71a
- BloopAI/vibe-kanban @ d5cbb53
- obsfx/trekker, Dicklesworthstone/beads_rust
- GoogleCloudPlatform/open-knowledge-format @ ad30107
- anthropics/claude-code CHANGELOG @ 2301018

I also queried the npm registry (task-master-ai, @beads/bd, backlog.md, vibe-kanban), listed release tags with `git ls-remote`, and fetched these pages: the git-bug v0.11.0 release, Codex rust-v0.142.2, the Vibe Kanban blog, Node sqlite docs, Codex skills / hooks / non-interactive docs, Claude Code hooks docs, the MCP 2026-07-28 changelog and versioning page, and the TS SDK v2 client docs.

**Confirmed as written:**
- beads storage modes and paths; `refs/dolt/data`; the JSONL export wording.
- beads 0.50.0 line counts (19,663 / 7,634); daemon removal in 0.59.0; SQLite backend removal listed in 0.58.0.
- beads adaptive-ID thresholds and the birthday formula; the `bd comment` full-ID rule.
- beads Claude Code hook (`bd prime --hook-json`, ~1-2k vs 10-50k tokens); Codex setup files and hook lifecycle; beads-mcp tool list and the "no sync tool" note.
- beads compaction modes; memory budget keys; wisps.
- Backlog.md:
  - frontmatter and section markers;
  - `generateNextId` (activeBranchDays default 30, worktrees, archived IDs reusable);
  - lock locations and timeouts (30 s / 10 s, git-common-dir path, fail-fast per-task lock, `USE_GLOBAL_TASK_ID_LOCK`);
  - stdio-only MCP, the `claude mcp add` / `codex mcp add` commands, MCP roots, `BACKLOG_CWD`;
  - 127.0.0.1:6420 with WebSocket + `fs.watch`; optionalDependencies platform binaries; `autoCommit` false;
  - fail-closed readiness; CRLF tests.
- git-bug: `refs/bugs`, nonce and `hash(json(op))`, 7-char display, GPLv3, no assignee/milestone, the v0.11.0 CAS / subscriptions / URL filters / `go install` without web UI / downgrade note.
- Taskmaster: 36 tools / ~21k tokens, the core/standard sizes, the 0.42.0 lock fix, the merge-conflict and renumber docs, `loop` spawning `claude -p`, sampling-based MCP provider, MIT + Commons Clause, 0.43.1 on 2026-03-31, rc 1.0.0-rc.1 on 2026-02-18.
- kata: 0.18.0, `KATA_HOME` / `.kata.toml`, ULID short IDs, 16 loaders / 74 tools.
- beans: NanoID with `id_length: 4`, both `blocking` and `blocked_by`, SessionStart/PreCompact prime, `beans-serve` spawning `claude`.
- tk: 4 random `[a-z0-9]` characters from `/dev/urandom`.
- trekker: 26 MCP tools, blocks TaskCreate/TodoWrite, separate dashboard package.
- beads_rust: the quoted "never commits…" text.
- Claude Code CHANGELOG: 2.1.7 MCP tool search (10% threshold), 2.1.16, 2.1.233, 2.1.277; no "sampling" mention anywhere.
- node:sqlite version history; OKF 0.2 reserved files and fields; Codex `.agents/skills`.

**Corrected:**
1. beads events journal shipped in 1.2.x (CHANGELOG 1.2.1, 2026-08-11), not 1.3.0. 1.3.0 added actor attribution, and `--follow` polls once a second.
2. beads leases and `bd reclaim` are already released (1.2.x). Only `--if-revision` (and reclaim over `bd serve`) is unreleased.
3. The beads teardown was larger than "roughly 27k lines": 0.51.0 removed the merge engine, tombstones and SQLite phases, and 0.52.0 removed about 11k more lines.
4. beads winget is not a documented install path. On Windows, `go install` builds a server-mode-only binary.
5. Added the beads `bd bootstrap` requirement for fresh clones.
6. Codex hooks are enabled by default, and project and non-managed hooks require trust and review via `/hooks`. This affects grimoire's pointer-file and hook plan.
7. Codex now defers MCP tools by default (rust-v0.142.2), which resolves a previously unverified item.
8. MCP spec 2026-07-28 (current) deprecates Roots, Sampling and Logging and removes per-connection sessions. This changes the recommendation to resolve the project from MCP roots, and weakens kata-style progressive loaders.
9. Vibe Kanban: `npx vibe-kanban` is not gone. Only the hosted cloud features were shut down, and npm 0.1.45 shipped on 2026-09-19.
10. Claude Code todo tools were further restricted in 2.1.268. AGENTS.md support was extended in 2.1.281.
11. git-bug also installs via scoop on Windows.
12. Minor wording fixes: Backlog.md prefix config (`--task-prefix` / `task_prefix`) and the full frontmatter list; Backlog.md MCP resource list; Taskmaster token counts; the beads `CLAUDE_SESSION_ID` attribution is a `--session` flag on close.

**Still unverified:** see the "Unverified or inferred" section above.
