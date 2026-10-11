# Claude Code fixtures

Real Claude Code artifacts, by kind (`hook-payloads/`, `hook-outputs/`,
`meta/`, `transcripts/` and others). Each kind folder's README has one section
per spike that added files, with its provenance and sanitizing. Spike A's
shared provenance and sanitizing are below, so its folder sections don't repeat
them.

## Spike A (GOK-126): provenance and sanitizing

Spike A captured the files listed in the "Spike A (GOK-126)" sections of
`hook-payloads/`, `hook-outputs/`, `meta/` and `transcripts/`. Findings,
verdicts and the exact probe setup are in
`docs/research/spikes/claude-hooks-transcripts.md`, and
`test/spikes/claude-hooks-transcripts.test.ts` encodes what the spike verified
against these files.

**Provenance**

- **Client:** Claude Code 2.1.296, native Windows build (`claude.exe`), model
  `claude-sonnet-5-5`, logged in with a claude.ai subscription.
- **OS:** Windows 11 Pro 10.0.26200. Hooks and the probe MCP server ran on Node 24.21.0.
- **Captured:** 2026-10-11, in headless sessions (`claude -p`). `/clear` and
  `/compact` were sent as user messages over `--input-format stream-json`. The
  fork used `--resume <id> --fork-session`.
- **Probe repo:** `%TEMP%\grimoire-spike-a\proj`, a throwaway git repo with:
  - a `.mcp.json` server named `grimoire` (a probe server that echoes the
    argument keys it received), started through a probe bootstrap as
    `node -e <bootstrap> mcp`;
  - exec-form `PreToolUse` (matcher `mcp__grimoire__.*`) and `SessionStart`
    hooks in `.claude/settings.json`, running
    `node -e <bootstrap> -- --from ${CLAUDE_PROJECT_DIR} hook <event>`;
  - a probe launcher in `.git/grimoire/`. Its `PreToolUse` handler returned
    `updatedInput` with the reserved key `_grimoire_hint` and no
    `permissionDecision`. Its `SessionStart` handler printed one line.
  - The synced claude.ai plugins were turned off with `--settings`, so only
    built-in tools and the probe server appear.

**Sanitizing** (one script, the same way in every spike A file)

- The Windows user name became `user` in every spelling: `C:\Users\user`
  (JSON-escaped in the files), `C:/Users/user`, `/c/Users/user`, and the
  project slug `C--Users-user-…`.
- The account e-mail became `user@example.com`. The account organization UUID
  became `00000000-0000-0000-0000-000000000000`. The per-account `atis` value
  became zeros. These are the same placeholders spike C (GOK-128) used.
- In `prompt_snapshot` and `skill_listing` attachments (Claude Code's own system
  prompt, tool list and skill list), every string over 200 characters was cut
  to its first 80 characters plus `[sanitized: N characters elided]`. Anywhere
  else, a string over 4,000 characters kept its first 1,500 and last 500
  characters around the same marker.
- Nothing else changed. Ids, uuids, timestamps, field order and line endings
  (LF) are as Claude Code wrote them. Every unmodified Claude Code 2.1.296 line
  round-trips through `JSON.stringify` byte for byte, which is how edited lines
  were re-serialized.
