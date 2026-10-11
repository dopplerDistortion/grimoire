# Codex hook trust

What Codex's hook listing and trust store say about a project's hooks.

## Spike E (GOK-130)

Captured under a scripted model, though no model turn was involved. Shared
provenance and sanitizing are in `../README.md`.

**How the files were made.**
- `hooks/list` responses came from `codex app-server` over stdio. They are not
  Codex's bytes: `test/spikes/codex-mcp-hooks-transcripts/hooks/hooks-rpc.mjs`
  parsed each response and wrote it back with `JSON.stringify`, plus a newline.
  Content and key order are Codex's.
- Trust was written the way the TUI's `/hooks` screen does it:
  `config/batchWrite` on `hooks.state` with `trusted_hash = currentHash`.

**The repo.**
- `repos\h2`, whose committed `.codex/config.toml` is `project-config.toml`:
  grimoire's group last, inside marker comments, running the bootstrap
  stand-in with `timeout = 10`.
- A clone of it, `repos\h2-clone`.
- A linked worktree of it, `repos\h2-wt`.

| File | What it shows |
| -- | -- |
| `project-config.toml` | The input: the project config the listings were taken from (written by the spike's `mkrepo.mjs`, not by Codex). |
| `project-config-group-inserted.toml`, `project-config-timeout-changed.toml` | The two edited inputs, edited by hand from `project-config.toml`. |
| `project-config-mixed-groups.toml` | Fix pass, repo `C:\gok130\repos\p4m` (`mkrepo.mjs --dashdash --mixed-before`): a `[[hooks.PreToolUse]]` group (matcher `Bash`), a `[[hooks.SessionStart]]` group with two handlers, then grimoire's group. |
| `hooks-list-mixed-groups.json` | Its listing for a fresh user: keys `…:pre_tool_use:0:0`, `…:session_start:0:0`, `…:session_start:0:1` and grimoire's `…:session_start:1:0`. The group index counts only that event's groups, the last number is the handler index, and `displayOrder` (0–3) is just a global count. Grimoire's hash differs from the other listings because this command has `--`. |
| `hooks-list-untrusted.json` | A fresh `CODEX_HOME` (a new user): key `<abs path>\.codex\config.toml:session_start:0:0`, `trustStatus: "untrusted"`, `currentHash: sha256:907a8003…`. |
| `hooks-list-trusted.json` | The same, after the trust write: `"trusted"`. |
| `user-config-hooks-state.toml` | The `[hooks.state]` table Codex wrote into that user's `config.toml`. |
| `hooks-list-group-inserted.json` | Another group inserted before grimoire's. Grimoire's unchanged hook is now `…:1:0` (same hash, `"untrusted"`). The new group sits at `…:0:0` and shows `"modified"`. |
| `hooks-list-timeout-changed.json` | `timeout` 10 → 11 at the same position: same key, new hash, `"modified"`. |
| `hooks-list-second-clone.json` | The clone: same hash, a key under the clone's path, `"untrusted"`. |
| `hooks-list-linked-worktree.json` | Listed with the worktree as `cwd`: the hook's `key` and `sourcePath` are the **main checkout's** file, `"trusted"`. |
