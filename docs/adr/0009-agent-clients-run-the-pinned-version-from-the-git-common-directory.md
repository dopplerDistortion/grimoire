# Agent clients run grimoire's pinned version from the git common directory, never through npx or the working tree

Every agent-client entry that starts grimoire runs the same frozen `node -e` bootstrap: the MCP server entries in `.mcp.json` and `.codex/config.toml`, and every hook. The bootstrap walks up from its start directory to the first ancestor that holds `.git`, and never crosses it. It finds the git common directory without spawning git, and runs `<git-common-dir>/grimoire/launcher.cjs`. That launcher is written only by `init`. It reads the checkout's **pinned version** from `.grimoire/config.yml` as data, accepts only a strict version number, and loads exactly that release from a copy at `<git-common-dir>/grimoire/pkg/<version>/`, and only once this machine has joined the repo through `init`, which shows the excerpt disclosure. It never fetches.

The only networked step is `npx @goksening/grimoire@<pin> init`. It fills the copy on the first install, and again on each machine that joins the repo or moves to a new pin.

A committed `.grimoire/run.cjs` gives shells the same release: humans, scripts, and an agent's CLI fallback, run from the repo root. It runs inside whatever sandbox its caller already has, so client entries never use it.

We chose this for five reasons:
- **Agent shells may have no network**, as in Codex.
- **Every call pays the hook's start-up.** Grimoire's Claude Code `PreToolUse` hook runs before every grimoire tool call, so it can't pay npm's start-up. We measured about 26 ms for `node`, against 0.5–0.8 s for a warm `npx`.
- **Hook commands can't carry a version.** Codex asks every user to approve a hook again whenever its command changes.
- **Agents must run the release the store expects.** The code an agent runs must be the one the repo's store format expects.
- **Clients run grimoire outside their sandbox.** MCP servers and hooks run outside a client's sandbox. Codex lets a sandboxed agent write the working tree but not `.git/`. Code that client entries load must therefore live where the agent can't write it.

## Considered Options

- **`npx -y @goksening/grimoire@<version>` in every entry**, as most MCP servers ship. Rejected for three reasons:
  - Without `--offline`, npx contacts the registry on every start, even for a cached pinned version. With the registry unreachable it failed after about 70 s of retries.
  - Each start costs 0.5–0.8 s.
  - The version would sit in every committed string, hooks included.
- **A launcher in the working tree (`.grimoire/run.cjs`) for client entries.** Rejected for two reasons:
  - A sandboxed Codex agent could rewrite it, and the unsandboxed server or hook would then run that code.
  - Claude Code runs hooks in its current directory, which follows every `cd`. A walk-up from there could reach another repo's launcher.
- **A relative launcher path, or a relative Codex `cwd`.** Rejected: both clients start servers in the launch directory, which may be a subdirectory, and Codex resolves a relative `cwd` against its own working directory.
- **A pinned devDependency.** Rejected for three reasons:
  - Host repos without a `package.json` can't have one.
  - Adding one means running the user's package manager and churning their lockfile.
  - `node_modules` is writable from the sandbox.

  `init --from-node-modules` may still copy a matching one into the store.
- **A global install, or an absolute path to `node` in committed config.** Rejected: charting excluded a global install, and an absolute path differs on every machine.

## Consequences

- **`node` 22 or later must be on the PATH** that each agent client hands to its servers and hooks. Nothing committed can name a machine's Node, so `init` and `doctor` check it and explain the fix.
- **The pin belongs to a checkout**, because `config.yml` travels with branches. Worktrees of one clone may run different pins against one store, so copies are pruned only when no worktree pins them and no live process uses them.
- **A fresh clone needs a join.** A fresh clone, or a teammate's new pin, needs `npx @goksening/grimoire@<pin> init` on that machine before grimoire runs there. Until then:
  - the session-start hook tells the agent to ask for it;
  - the server reports it as its startup error;
  - CI and cloud-scheduler recipes run it before any agent step.
- **The published package has no runtime dependencies,** so a copy is self-contained.
- **Hook definitions stay identical across releases.** A hook changes only with a deliberate change to the install format.
- **Claude Code hooks pass `--from ${CLAUDE_PROJECT_DIR}`,** so they don't follow the session's working directory.
- **The boundary has two accepted residuals.** Claude Code's optional Bash sandbox leaves most of `.git/` writable, so there the launcher and the copies rely on Claude's own permission checks. A session launched inside a directory an agent created can meet a planted `.git`.

_Amended by ADR 0011 and the Lifecycle decision (GOK-122):_
- _An older format is migrated by any `init` a human runs at the release that needs it, joins included, not only by `init --upgrade`._
- _The launcher only moves forward: `init` replaces it only with a newer one, or one that fails its self-check._
- _The bootstrap, the entry verbs and the launcher↔package contract belong to a frozen cross-pin contract, because Codex runs the main checkout's entries in every linked worktree, whatever that worktree pins._
- _`install_format` bumps happen only in major releases._
- _`node .grimoire/run.cjs pin` prints the pin without loading a copy, so CI recipes follow it._
