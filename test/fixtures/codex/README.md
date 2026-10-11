# Codex fixtures

Real Codex CLI artifacts, by kind (`mcp/`, `meta/`, `transcripts/`,
`hook-payloads/`, `hook-trust/` and `exec-json/`). Each kind folder's README
has one section per spike that added files. Spike E's shared provenance and
sanitizing are below, so its folder sections don't repeat them.

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

- **Real:** every byte of these files was written by the real Codex binary (or
  by the app-server answering an RPC). That includes the MCP client and its
  `_meta`, the hooks and their trust, the rollouts, and archiving and
  compression.
- **Scripted:** only the model's choices. That covers which tool to call with
  which arguments, the `call_<n>_<m>` call ids, and the assistant texts
  (`done`, `SUMMARY: …`, `scenario A done`). They follow a `PLAN: [...]` in the
  user prompt.
- **What a scripted model can't produce:** no `reasoning` items, and local
  rather than remote compaction.

**Provenance**

- **Client:** Codex CLI 0.162.1, native Windows build (`@openai/codex` +
  `@openai/codex-win32-x64`), not logged in.
- **OS:** Windows 11 Pro 10.0.26200. MCP servers and hooks ran on Node 24.21.0.
- **Captured:** 2026-10-11.
- **Repos:** throwaway git repos under `%TEMP%\gok130\repos\`, each trusted as
  a project in the run's `config.toml`.
- **Drivers:** `codex exec` (non-interactive), or `codex app-server` over stdio
  (legacy history mode, two turns in one thread, archive, compress, hook listing
  and trust).
- **MCP server:** spike B's bundled probe (`test/spikes/mcp-dual-era/probe-server.ts`,
  `@modelcontextprotocol/server` 2.3.1), declared as `[mcp_servers.probe]`.

**Sanitizing** (`test/spikes/codex-mcp-hooks-transcripts/sanitize.mjs`)

- The Windows user name became `USER`, everywhere and in every escaping.
- The machine's IANA time zone, in `<environment_context>`, became `Etc/UTC`.
- Nothing else changed: ids, hashes, timestamps, temp-folder names, field order
  and line endings are as Codex wrote them.
- The one `.zst` file was decoded, sanitized, and re-encoded at zstd level 3
  (Codex's level). Its bytes are therefore Node's zstd frame, not Codex's
  original one.
- Before sanitizing, Codex's own frame was checked to decode with Node's
  `zlib.zstdDecompressSync` to the identical pre-archive rollout.

## Spike F (GOK-131): provenance and sanitizing

Findings, verdicts and the probe kit are in
`docs/research/spikes/codex-skills-role-exec.md` and
`test/spikes/codex-skills-role-exec/`. The verdicts are encoded against these
files in `test/spikes/codex-skills-role-exec.test.ts`. Same client, OS and date
as spike E, also **captured under a scripted model** (the kit's own stand-in,
`scripted-responses.mjs`), except `exec-json/runner/not-logged-in.jsonl`, which
had no stand-in at all. Spike F's files sit in their own subfolders
(`exec-json/runner/`, `transcripts/skill-stub-read/`, `transcripts/skill-roots/`,
`transcripts/chore-role/`, `mcp/chore-role/`), each with a README giving its
run, provenance and sanitizing: the user name became `USER` and the time zone
`Etc/UTC`, with the package name `@goksening/grimoire` kept.
