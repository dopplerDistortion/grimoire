# Codex fixtures

Real Codex CLI artifacts, by kind (`mcp/`, `meta/`, `transcripts/`,
`hook-payloads/`, `hook-trust/`, `exec-json/` and `model-input/`). Each kind
folder's README has one section per spike that added files. Spike E's shared
provenance and sanitizing are below, so its folder sections don't repeat them.

## Spike E (GOK-130): provenance and sanitizing

Findings, verdicts and the probe kit are in
`docs/research/spikes/codex-mcp-hooks-transcripts.md` and
`test/spikes/codex-mcp-hooks-transcripts/`. The verdicts are encoded against
these files in `test/spikes/codex-mcp-hooks-transcripts.test.ts`.

**Captured under a scripted model.** Codex was not logged in, so every model
turn came from a local stand-in for the OpenAI Responses API
(`test/spikes/codex-mcp-hooks-transcripts/fake-responses.mjs`). It was
configured as a custom provider (`wire_api = "responses"`, model slug
`gpt-5.5`) in a throwaway `CODEX_HOME`.

- **Written by Codex:** the rollouts (`transcripts/`, the `.zst` included), the
  `tools/call` lines and the rest of `c2s.jsonl` (`meta/`, `mcp/`), the hook
  payloads, the `codex exec --json` streams, and
  `hook-trust/user-config-hooks-state.toml` (the `[hooks.state]` tables Codex
  wrote into the user's `config.toml` on the spike's `config/batchWrite`,
  copied out of that file). Their bytes are Codex's, apart from the
  sanitizing below.
- **Written by Codex, re-serialized by spike code:** the `hooks/list` responses
  (`hook-trust/hooks-list-*.json`, written by `hooks-rpc.mjs` as
  `JSON.stringify` of the parsed message) and the model-input excerpts
  (`model-input/`, items of the request body the stand-in parsed and logged).
  The content is Codex's; the byte layout is Node's.
- **Written by spike code:** each `mcp/*/s2c.jsonl` and `starts.jsonl` (the
  probe server's replies and its own start log), and the hook-trust inputs
  `project-config*.toml` (by `hooks/mkrepo.mjs`, or edited from its output by
  hand).
- **Scripted:** only the model's choices. That covers which tool to call with
  which arguments, the `call_<n>_<m>` call ids, and the assistant texts
  (`done`, `SUMMARY: …`, `scenario A done`, `scripted reply`). They follow a
  `PLAN: [...]` in the user prompt, and say nothing about what happened.
- **What a scripted model can't produce:** no `reasoning` items, and local
  rather than remote compaction.

**Provenance**

- **Client:** Codex CLI 0.162.1, native Windows build (`@openai/codex` +
  `@openai/codex-win32-x64`), not logged in.
- **OS:** Windows 11 Pro 10.0, build 26200. MCP servers and hooks ran on Node 24.21.0.
- **Captured:** 2026-10-11, in two passes.
- **First pass:** run folders under `%TEMP%\gok130\runs\<run>\` (each with its
  own `CODEX_HOME` and, unless a repo was named, a `work\` repo) and repos under
  `%TEMP%\gok130\repos\`, each trusted as a project. P7 ran in a plain temp
  folder outside any repo.
- **Fix pass** (after review): the same layout under `C:\gok130\`, with `TEMP`
  pointed there too: `transcripts/compaction-legacy/`, `subagent-legacy-root/`
  and `archived-zstd/`, `mcp/two-turns/`, `exec-json/read-only-*.jsonl`,
  `model-input/read-only-shell-blocked.jsonl` and
  `hook-trust/*mixed-groups*`. These paths hold no user name.
- **Drivers:** `codex exec` (non-interactive), or `codex app-server` over stdio
  (legacy history mode, two turns in one thread, archive, compress, hook listing
  and trust).
- **MCP server:** spike B's bundled probe (`test/spikes/mcp-dual-era/probe-server.ts`,
  `@modelcontextprotocol/server` 2.3.1), declared as `[mcp_servers.probe]`.

**Sanitizing** (`test/spikes/codex-mcp-hooks-transcripts/sanitize.mjs`)

- The Windows user name became `USER`, everywhere and in every escaping. The
  sanitizer refuses a file with any leftover: the name, its first five
  characters (PowerShell shortens long paths with `...`), or a `Users\<name>`
  segment whose name isn't `USER`. A test checks every file here, `.zst`
  decoded, for such a segment.
- Nothing else changed: ids, hashes, timestamps, temp-folder names, the time
  zone, field order and line endings are as Codex wrote them. (The first pass
  had also replaced the time zone with `Etc/UTC`; the fixtures were re-staged
  from the raw captures without that.)
- The machine's time zone is UTC+3 (`Europe/Istanbul` in `<environment_context>`
  and `world_state`). Rollout file names and session folders use that local
  time; each line's `timestamp` is UTC.
- The fix-pass files needed no replacing, so they are Codex's bytes unchanged.
  That includes the `.zst`: it is Codex's own zstd frame.
