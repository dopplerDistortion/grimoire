# Claude Code MCP wire traffic (2026-07-28 era)

Real stdio traffic between Claude Code and spike B's probe server
(`test/spikes/mcp-dual-era/probe-server.ts`). Findings:
`docs/research/spikes/mcp-dual-era.md`.

Each session folder holds:

- `c2s.jsonl`: the bytes Claude Code wrote to the server's stdin, exactly as
  received (newline-delimited JSON, LF only).
- `s2c.jsonl`: the bytes the probe server wrote back (produced by the probe,
  not by Claude Code; kept so the exchange reads end to end; requests and
  responses pair by `id`).
- `starts.jsonl`: one line per server process Claude Code started (`pid`, `at`).

## Provenance

- Client: Claude Code 2.1.296, headless (`claude -p … --output-format
  stream-json --verbose`), model alias `haiku`, permission mode `default`, the
  probe's tools allowed with `--allowedTools`, `--strict-mcp-config`.
- Server: the probe bundled by esbuild (as `scripts/build.mjs` bundles the CLI),
  `@modelcontextprotocol/server` 2.3.1, run with Node 24.21.0.
- OS: Windows 11 Pro 10.0.26200. Captured 2026-10-11.
- Reproduce: `node test/spikes/mcp-dual-era/capture-claude.mjs <new-dir>`
  (add `--no-hook` for the second session).

## Sessions

- `session-hint-hook/`: three `tools/call`s (`echo`, `big`, `which`) with a
  `PreToolUse` hook (`test/spikes/mcp-dual-era/hint-hook.mjs`) that adds the
  reserved key `_grimoire` through `updatedInput`, with no
  `permissionDecision`. Also holds the hook's real input (`hook-input.jsonl`,
  one payload per call, as Claude Code sent it on stdin) and the output it
  returned (`hook-output.jsonl`).
- `session-no-hook/`: one `tools/call` (`echo`) with no hook: `_meta` but no
  reserved key.

## Sanitizing

The Windows user name was replaced by `USER` everywhere it appeared (in
`transcript_path`, the transcript folder slug and `cwd`). Nothing else changed:
session ids, tool-use ids, prompt ids and temp-folder names are the real ones.
