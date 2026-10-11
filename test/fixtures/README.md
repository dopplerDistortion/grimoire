# Client-contract fixtures

Fixtures for the client-contract seam (seam 2): what the client readers and
evidence parsers are tested against, and what core-operation tests reuse to
drive capture end to end.

## The rule: real, sanitized artifacts only

Every file here is a **real artifact captured from a real agent client**
(Claude Code or Codex), **sanitized**. Never hand-write or "simplify" a client
format: a reader tested against an invented format proves nothing about the
real one.

- **Real.** Copy the artifact from an actual session or hook invocation: a
  transcript (`.jsonl`, `.jsonl.zst`, archived), a hook payload as the client
  sent it on stdin, or a `tools/call` request's `_meta`.
- **Sanitized.** Replace secrets, tokens, user names, e-mail addresses, host
  names and home-directory paths with consistent placeholders (the same value
  everywhere it appears), and shorten long tool output. Change nothing else:
  keep the structure, field order, encoding, line endings and the quirks.
- **Traceable.** Record each fixture's provenance (client and version, OS,
  capture date, what sanitizing changed) in a `README.md` in its folder.
- **Every bug fixed in a reader adds a fixture** that reproduces it.

Files here are stored byte for byte (`.gitattributes`: `-text`), so line
endings are never converted on checkout.

## Layout

`<client>/<kind>/<name>`, for example:

- `claude-code/transcripts/…`, `codex/transcripts/…`
- `claude-code/hook-payloads/…`, `codex/hook-payloads/…`
- `claude-code/meta/…`, `codex/meta/…` (`_meta` shapes, per MCP era)
- `claude-code/mcp/<session>/…`, `codex/mcp/<session>/…` (raw MCP stdio
  traffic: `c2s.jsonl` as the client sent it, `s2c.jsonl` as the server
  answered; the `_meta` shapes on real requests live here too)
- `mcp-sdk-client/mcp/<session>/…` (the MCP TypeScript SDK's own client, for
  the generic-client cases no agent client produces)

## Loading

```ts
import { fixturePath, readFixture, readFixtureBytes, readFixtureJson } from '#harness';

const transcript = fixturePath('codex/transcripts/unified-exec.jsonl'); // absolute path
const payload = readFixtureJson('claude-code/hook-payloads/pre-tool-use.json');
```

Paths are relative to this folder, with forward slashes. A missing fixture,
or a path outside this folder, throws.
