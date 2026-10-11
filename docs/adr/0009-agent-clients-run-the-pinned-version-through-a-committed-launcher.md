# Agent clients run grimoire's pinned version through a committed launcher, never through npx

Every committed entry that starts grimoire runs `node` on a small launcher that `init` writes into the dotfolder, `.grimoire/run.cjs`. That covers the MCP server entries in `.mcp.json` and `.codex/config.toml`, the hooks, the CLI form in the instruction text and the adapter doc, and the npm script. The launcher carries no version. It reads the **pinned version** from `.grimoire/config.yml` and loads exactly that release from a copy kept in the live store's machine-local part, `<git-common-dir>/grimoire/pkg/<version>/`. It never fetches. The only step that touches the network is `npx @goksening/grimoire@<pin> init`, which fills that copy on the first install, and again on each machine that joins the repo or moves to a new pin.

Clients start servers and hooks in the directory they were launched from, and neither client can name the repo root in config. So committed config doesn't run the launcher by path. It runs a fixed `node -e` bootstrap that walks up from the working directory to the nearest `.grimoire/run.cjs`. That bootstrap is the same string in every client file and every hook, and its text uses no character that sh, PowerShell or cmd would expand.

We chose this for four reasons:
- Agent shells can have the network off (Codex).
- Grimoire's `PreToolUse` hook runs before every grimoire tool call, so it can't pay npm's start-up. We measured about 26 ms for `node` and 0.5–0.8 s for a warm `npx`.
- Codex asks every user to approve a hook again whenever its command changes, so hook commands can't carry a version.
- The code an agent runs must be the release the repo's store format expects.

## Considered Options

- **`npx -y @goksening/grimoire@<version>` in every entry**, as most MCP servers ship. Rejected for three reasons:
  - Without `--offline`, npx contacts the registry on every start, even for a cached pinned version. With the registry unreachable it failed after about 70 s of retries.
  - Each start costs 0.5–0.8 s.
  - The version would sit in every committed string, hooks included.
- **A pinned devDependency.** Rejected as the mechanism: host repos without a `package.json` can't have one, and adding it means running the user's package manager and churning their lockfile. The launcher still accepts a root `node_modules` copy whose version equals the pin.
- **A global install, or an absolute path to `node` in committed config.** Rejected: charting excluded a global install, and an absolute path differs on every machine.
- **A relative launcher path in config, or a relative Codex `cwd`.** Rejected: both clients start servers in the launch directory, which may be a subdirectory, and Codex resolves a relative `cwd` against its own working directory.

## Consequences

- `node` 22 or later must be on the PATH that each agent client hands to its servers and hooks. Nothing committed can name a machine's Node, so `init` and `doctor` check it and explain the fix.
- A fresh clone, or a teammate's new pin, needs `npx @goksening/grimoire@<pin> init` on that machine before grimoire runs there. The launcher's error prints exactly that command, and CI and cloud-scheduler recipes start with it.
- The published package has no runtime dependencies, so a copy is self-contained. Each clone keeps the copies it uses, a few MB each, and upkeep prunes old ones.
- Every entry point defers to the pin. An `npx @goksening/grimoire` run at another version hands over to the pinned copy, or stops.
- Hook definitions stay byte-identical across releases, so a hook changes only with a deliberate change to the install format.
