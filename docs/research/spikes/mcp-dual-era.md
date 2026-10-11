# Spike B: one bundled MCP SDK v2 `serveStdio` server, both MCP eras

*Run on 2026-10-11 for GOK-127 (spec §22: P1, A1, T2, R7). Every item was exercised against the real clients on this machine; no item fell back to "unverifiable".*

## Verdicts

| Item | Verdict | In one line |
| -- | -- | -- |
| P1 (SDK and Claude half) | **Confirmed** | One bundled `serveStdio` server served Claude Code 2.1.296 at 2026-07-28 and a 2025-06-18 `initialize`, from both the SDK test client and the real Codex 0.162.1. Claude Code hands the model the `structuredContent` and drops the text block. A 24 KB cut arrived whole and well-formed. |
| A1 | **Confirmed** | `tools/call` with no modern `_meta` is served in every 2025-era cell, including with no handshake at all. One synthetic cell is refused: a connection already pinned to 2026-07-28 that drops the envelope gets `-32602`. The 2026-07-28 spec requires that refusal, and no client does it. The fallback was not taken. |
| T2 | **Fallback taken (low-level handler)** | The undeclared reserved key reaches the SDK's low-level `Server` `tools/call` handler raw, before any tool schema, in both eras and from real Claude Code. The high-level `McpServer.registerTool` path validates first, so it drops or rejects the key. No transport interception is needed, and the hint is kept (the T1 fallback is not triggered). |
| R7 | **Confirmed** | Cold start from spawn to the first response line is a median of 66–77 ms (p90 ≤ 83 ms) on Windows, Node 22 and 24, against a 300 ms budget. Node alone takes about 32 ms. |

**Fallbacks taken:** T2 only, through its first route, the low-level handler. Its "failing that, drop the hint" leg was not needed. P1's `initialize` shim, A1's pre-parse and R7's slim entry chunk are all not needed.

## Environment

- Windows 11 Pro 10.0.26200; AMD Ryzen 7 9700X (16 threads).
- Node 24.21.0 (installed), plus Node 22.23.3 (the official `win-x64` zip, SHA-256 checked) for R7.
- **MCP TypeScript SDK v2:** `@modelcontextprotocol/server` 2.3.1 (with `@modelcontextprotocol/core` 2.3.1 and `zod` 4.x, all bundled). The test client is `@modelcontextprotocol/client` 2.3.1. Both are `devDependencies`; the runtime dependency count stays zero (`npm run check:deps`).
- Claude Code 2.1.296, logged in. Codex CLI 0.162.1, **not** logged in. It still starts and initializes MCP servers before its model calls fail with 401, so its real handshake was captured; its `tools/call` was not.

## How to reproduce

Everything lives in `test/spikes/mcp-dual-era/`:

- `probe-server.ts`: the throwaway server. It runs `serveStdio(factory)`, and the factory builds a low-level `Server` with tools `echo` (reports what the handler saw), `big` (a result cut at 24 KB), `which` (`structuredContent` and a text block that differ) and `boom` (throws). With `GRIMOIRE_PROBE_CAPTURE_DIR` set, it appends the raw bytes of each direction (`c2s.jsonl`, `s2c.jsonl`) and one `starts.jsonl` line per process.
- `bundle-probe.mjs`: bundles the probe with the same esbuild settings `scripts/build.mjs` uses for the CLI.
- `mcp-dual-era.test.ts` (in `npm test`): drives the bundled probe over real stdio in both eras with the SDK client, replays the captured real traffic, and checks the raw-wire A1 cells. It encodes every verdict below.
- `capture-claude.mjs <dir> [--no-hook]`: runs `claude -p` against the probe, with `hint-hook.mjs` as the `PreToolUse` hook, and records everything.
- `capture-sdk-client.mjs <dir>`: records the SDK client's 2025-06-18 session.
- `measure-cold-start.mjs [--runs N] [--node <exe>]`: the R7 numbers.
- Codex handshake: `codex exec --skip-git-repo-check "say hi" < /dev/null`, with `CODEX_HOME` pointing at a throwaway folder. That folder's `config.toml` declares only `[mcp_servers.probe]` (`command` = node, `args` = the bundled probe, `env.GRIMOIRE_PROBE_CAPTURE_DIR`).

## P1: how both eras negotiated

**Claude Code 2.1.296 (2026-07-28).** The traffic is in `test/fixtures/claude-code/mcp/session-hint-hook/`.

- There is no `initialize` and no `notifications/initialized`. The first message is `server/discover` with id `"server-discover-probe-1"`, and every request carries the envelope in `_meta`:
  - `io.modelcontextprotocol/protocolVersion: "2026-07-28"`;
  - `io.modelcontextprotocol/clientInfo: {name: "claude-code", title, version: "2.1.296", …}`;
  - `io.modelcontextprotocol/clientCapabilities: {roots: {listChanged: true}, elicitation: {form: {}, url: {}}}`.
- The discover is answered in place, on the same process. The `tools/list` (id `0`) and `tools/call`s that follow pin the connection to the modern instance.
- Each `tools/call` adds `claudecode/toolUseId` (the model's `tool_use` id) and `progressToken` (equal to the request id) to the envelope keys.
- The SDK answers discover with:
  - `supportedVersions: ["2026-07-28"]`, the capabilities and `instructions`;
  - `resultType: "complete"`, `ttlMs: 0` and `cacheScope: "private"`;
  - `_meta["io.modelcontextprotocol/serverInfo"]`.

  Modern `tools/call` results also carry `resultType` and the `serverInfo` `_meta`.
- Claude Code started **one** server process per session (`starts.jsonl`).
- **Server instructions** set in the `Server` options travel in the discover result. Asked without tools, Claude Code's model quoted them verbatim. The same text reaches the 2025 era through `initialize` (asserted for both eras in the test).

**Codex 0.162.1 (2025-06-18).** The traffic is in `test/fixtures/codex/mcp/handshake/`.

- `initialize` declares:
  - `protocolVersion: "2025-06-18"`;
  - `capabilities: {experimental: {"codex/auth-change": {}}, elicitation: {form: {}, url: {}}}`;
  - `clientInfo: {name: "codex-mcp-client", title: "Codex", version: "0.162.1"}`.

  It is followed by `notifications/initialized` and then `tools/list` with `_meta: {progressToken: 0}`.
- `serveStdio` pins a legacy instance and echoes `protocolVersion: "2025-06-18"`. Codex started one process.
- The SDK client with `supportedProtocolVersions: ["2025-06-18"]` produces the same `initialize`, `notifications/initialized`, `tools/list` sequence, declaring only `elicitation: {}` (`test/fixtures/mcp-sdk-client/mcp/session-2025-06-18/`).
- An `initialize` with an unknown version (tested: `2099-01-01`) gets a counter-offer of `2025-11-25`, the SDK's newest 2025-era revision.

**One factory, both eras.**

- `tools/list` is identical in both eras (asserted).
- `serveStdio` calls the factory with `{era}` once per connection. A `server/discover` builds a modern "probe" instance first. If a 2025-era message follows, that instance is discarded and a legacy one is built, so **the factory can run twice on one connection**.

**Rendering in Claude Code: `structuredContent` plus a text block.**

- When a result has both, Claude Code 2.1.296 gives the model `JSON.stringify(structuredContent)` (compact) and drops the text block entirely.
- The probe's `which` tool returned `structuredContent {"seen_via":"structuredContent"}` and the text `{"seen_via":"text"}`. The model saw only the first, and the transcript agrees.
- The transcript's `tool_result.content` and `toolUseResult` are both the string `{"seen_via":"structuredContent"}`. `mcpMeta` holds `{_meta, structuredContent}`, and the text block is stored nowhere.
- Because grimoire's text block is the same compact JSON, the model sees exactly one copy of the result. That is acceptable, and it costs no extra tokens.

**The 24 KB cut.**

- `big` cut 1,000 requested rows to 137, with `truncated: true` and `cursor: "137"`. The JSON text is 24,482 bytes, and the whole JSON-RPC line is about 50 KB, because the payload travels twice.
- It arrived byte-identical and well-formed in both eras through the SDK client (asserted: text block = `JSON.stringify(structuredContent)`, ≤ 24 KiB).
- In Claude Code the model received all 137 rows, with no truncation and no warning, and correctly reported `truncated` and `cursor`.
- Codex's ~12k-token middle truncation is the real-Codex half (spike E).

**Errors.**

- A handler that throws (`boom`) becomes a JSON-RPC error (`-32603`, with the thrown message) in both eras, and the connection keeps serving later calls (asserted).
- The SDK does **not** turn a throw into an `isError` result, so grimoire must catch errors itself to return its `{error: {…}}` envelope.

## A1: `tools/call` without modern `_meta`

Each cell was exercised on the raw wire against the bundled probe. The cells marked † are asserted in the test.

| Connection state | `tools/call` sent | Result |
| -- | -- | -- |
| After a 2025-06-18 `initialize` † | no `_meta` | served (`era: legacy`) |
| After `initialize`, before `notifications/initialized` | no `_meta` | served |
| After `initialize` † | Codex-style `_meta` (`sessionId`, `threadId`, `callId`) | served; the handler sees the whole `_meta` |
| After `initialize` | the full 2026-07-28 envelope | served as legacy; the envelope is lifted into `ctx.mcpReq.envelope` |
| No handshake at all (first message) † | no `_meta` | served as 2025-era traffic (`protocolVersion` unknown) |
| After a `server/discover` probe † | no envelope (only `claudecode/toolUseId`) | the probe is discarded; served as legacy, and `_meta` passes through |
| Pinned to 2026-07-28 (an enveloped `tools/list` first) † | no `_meta` | **refused** with `-32602` "Request is missing the required _meta envelope for protocol revision 2026-07-28" |

The refused cell is the 2026-07-28 spec's own rule, and no client was seen doing it: Claude Code 2.1.296 stamps the envelope on every request. Accepting it would mean a raw pre-parse shim that duplicates `serveStdio`'s era state, so the fallback is **not** taken. If a client is ever seen dropping the envelope mid-connection, the shim fits in a `transport` wrapper passed to `serveStdio`. That wrapper would copy the last seen envelope into envelope-less requests.

Also seen: pipelined requests can be answered out of order (an error for id 2 came back before the result for id 1). That is valid JSON-RPC.

## T2: how the reserved key travels

1. **Hook to arguments.**
   - Claude Code runs the `PreToolUse` hook with a payload containing `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `effort`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id` and `mcp_server: {name, source}`. There is no `agent_id` on the main thread. Payloads are in `hook-input.jsonl`.
   - The hook returns `hookSpecificOutput.updatedInput` = `tool_input` plus `_grimoire: {session_id, transcript_path, tool_use_id}`, with **no** `permissionDecision`.
   - Claude Code sent exactly that object as `params.arguments`.
2. **No client-side filtering.** The probe advertised `additionalProperties: false`, but Claude Code delivered the undeclared key anyway: it does not re-validate `updatedInput` against the tool schema. Schemas can stay strict, and the key stays unadvertised.
3. **The hint matches `_meta`.** In every call, `arguments._grimoire.tool_use_id` equals `_meta["claudecode/toolUseId"]` (asserted on the fixture).
4. **Through the SDK.** `CallToolRequestParams.arguments` is a free record, so the low-level `Server` `tools/call` handler gets `request.params.arguments` untouched in both eras. It destructures the key out, then validates the rest. Another undeclared key still fails strict validation (asserted).
5. **The transcript never shows it.** Claude's transcript records the model's original `tool_use.input` (`{"text":"hello"}`), so the key cannot leak into a cut excerpt from the input side.

**Why the high-level path is out.** These are in-process results with `McpServer.registerTool`, SDK 2.3.1, and arguments `{text, _grimoire}`:

| `inputSchema` | Advertised | Handler got |
| -- | -- | -- |
| `z.object({text})` | no `additionalProperties` | `{text}`: the key is **silently stripped** |
| `z.strictObject({text})` | `additionalProperties: false` | nothing: the call is **rejected** ("Unrecognized key") |
| `z.looseObject({text})` | `additionalProperties: {}` | `{text, _grimoire}`, but only after validation and with a loosened schema |
| `fromJsonSchema` (strict) | `additionalProperties: false` | nothing: the call is rejected |
| `fromJsonSchema` (open) | no `additionalProperties` | `{text, _grimoire}`, after validation |

`registerTool` always validates before the handler runs, so "read and strip before schema validation" is only possible in the low-level handler.

## R7: cold start

The figures run from `spawn()` to the first newline on stdout, with each era's real opening line written immediately: Codex's `initialize` and Claude Code's `server/discover`, both from the fixtures. There were 30 runs per row, after one warm-up spawn, so the file cache is warm.

| Entry | Size | Node 24.21.0: median / p90 / max | Node 22.23.3: median / p90 / max |
| -- | -- | -- | -- |
| Node floor (a no-op responder) | ~0 KB | 32–33 / 36–40 / 99 ms | 32 / 36 / 39 ms |
| Probe bundle, legacy opening | 803 KB | 69 / 75 / 76 ms | 75 / 81 / 83 ms |
| Probe bundle, modern opening | 803 KB | 66 / 67 / 70 ms | 77 / 82 / 83 ms |
| Probe bundle minified, either opening | 408 KB | 65–67 / 69–76 / 85 ms | 72–78 / 79–83 / 90 ms |

- The SDK costs about 33–45 ms over Node's own start.
- Bundle composition:
  - `@modelcontextprotocol/server`: 557 KB, including its built-in AJV;
  - `zod`: 206 KB;
  - `@modelcontextprotocol/core`: 34 KB;
  - the probe: 4 KB.
- Minifying saves at most about 5 ms, so it is not worth it for R7.
- About 220 ms of the 300 ms budget remain for the bootstrap and launcher hop and for grimoire's own module evaluation before the opening is answered.

## What the MCP-server slice (GOK-142) must build

1. **Entry.** Use `serveStdio(factory)` from `@modelcontextprotocol/server/stdio` with the default `legacy: 'serve'`. Write no `initialize` shim: the SDK handles 2025-06-18 `initialize`, 2026-07-28 `server/discover` and the opening rules.
2. **A cheap factory.** It runs before the opening is answered, and possibly twice per connection (the discarded discover probe). It must do no git, store or file work. Record `era` from the factory argument as a connection fact. `clientInfo` comes from:
   - 2025 era: `server.getClientVersion()` after `initialize`;
   - 2026-07-28 era: the envelope's `io.modelcontextprotocol/clientInfo`, readable per request as `ctx.mcpReq.envelope`.

   Keep the pin and format checks lazy and per call, as the spec says.
3. **The low-level `Server`, not `McpServer.registerTool`.**
   - `setRequestHandler('tools/list')` returns the static tool list, with JSON Schemas and annotations from grimoire's op registry and no `outputSchema`.
   - `setRequestHandler('tools/call')`:
     - reads the reserved key from `request.params.arguments` and deletes it;
     - validates the rest with grimoire's own validation (the bundled SDK's `fromJsonSchema` works);
     - puts the hint and `ctx.mcpReq._meta` into the call context.
4. **`_meta` in the handler.**
   - `ctx.mcpReq._meta` holds the client keys. From Claude Code these are `claudecode/toolUseId` and `progressToken`. Codex's keys pass through the same way; spike E records their real shape.
   - The SDK has already lifted the `io.modelcontextprotocol/*` envelope keys out into `ctx.mcpReq.envelope`.
   - The hint counts only when `hint.tool_use_id === ctx.mcpReq._meta?.['claudecode/toolUseId']`.
5. **Results.**
   - Send `content: [{type: 'text', text: json}]` plus `structuredContent` (the same object), where `json` is the compact `JSON.stringify` of that object.
   - Apply the 24 KB budget to that JSON text. Claude Code shows the model only `structuredContent`, serialized the same way.
6. **Errors.**
   - Wrap the whole `tools/call` handler in a `try`. On a throw, return `isError: true` with `{error: {code, message, retryable, details}}`.
   - An uncaught throw becomes a JSON-RPC `-32603` that carries the raw message. The connection survives either way.
7. **Instructions.** Pass the shipped text as `instructions` in the `Server` options. It reaches Claude Code through discover and Codex through `initialize`.
8. **No A1 shim.** 2025-era traffic without `_meta` works out of the box. Leave the `-32602` on an envelope-less request in a pinned 2026-07-28 connection alone (see A1).
9. **Lifetime.** The SDK's stdio transport closes on stdin EOF, and the process then exits only if nothing else holds the event loop. Don't leave timers or watchers referenced, or exit on close. Keep stdout for the transport only, and log to stderr.
10. **Cold start.**
    - Answer the opening before loading tracker or git modules.
    - Keep the SDK out of other verbs' load path: use a dynamic `import()` chunk or a separate entry, since `dist/grimoire.mjs` is one file today.
    - The slim-entry fallback isn't needed at today's cost (about 70 ms).
11. **Seam-3 tests.** Reuse this spike's patterns:
    - the SDK `Client` with `supportedProtocolVersions: ['2025-06-18']` versus `versionNegotiation: {mode: {pin: '2026-07-28'}}`;
    - raw replay of `test/fixtures/{claude-code,codex}/mcp/*/c2s.jsonl` against the real server.

## Notes for other tickets

- **GOK-147 (identity evidence).**
  - The real hint round trip is in `claude-code/mcp/session-hint-hook/`: the hook input, the hook output, and the resulting `tools/call` with the key and the matching `claudecode/toolUseId`.
  - A hint only arrives when the hook ran. Calls without the hook carry `_meta` but no key (`session-no-hook/`).
  - The transcript never contains the key.
- **GOK-126 (spike A, T1).** This is incidental evidence, not a verdict: in `claude -p` with `permission_mode: "default"` and the tool allowed by `--allowedTools`, `updatedInput` without `permissionDecision` was honoured on all three calls. Plan, acceptEdits and auto modes were not tried here.
- **GOK-130 (spike E).** Codex 0.162.1 starts and initializes MCP servers without a login, so its handshake can be captured with no account (`codex/mcp/handshake/`). `tools/call` and its `_meta` still need a login.
- **GOK-172 (release).** The SDK packages are `devDependencies` and get bundled. `check:deps` stays green. The `files` allowlist needs nothing extra for the SDK.

## Fixtures added

The provenance and sanitizing notes are in each folder's README:

- `test/fixtures/claude-code/mcp/session-hint-hook/`: the 2026-07-28 handshake, `tools/call`s with `_meta` and the reserved key, and the hook input and output.
- `test/fixtures/claude-code/mcp/session-no-hook/`: a `tools/call` with `_meta` and no reserved key.
- `test/fixtures/codex/mcp/handshake/`: the real 2025-06-18 `initialize` from Codex 0.162.1.
- `test/fixtures/mcp-sdk-client/mcp/session-2025-06-18/`: a 2025-06-18 handshake, a `tools/call` with no `_meta`, and one with the reserved key.
