# Spike D: Claude headless runner, cloud setup and Windows named pipe

*Spike for GOK-129 (spec §22 items C3, P6, R6, R5). Run on 2026-10-11 on Windows 11 Pro 10.0.26200, Node 24.21.0, Claude Code 2.1.296 (native `claude.exe` at `~/.local/bin/claude.exe`), logged in with a claude.ai Max subscription, from a non-elevated user token.*

> **Fallbacks taken.**
> - **R6 is unverifiable here, so its fallback applies.** This headless session has no Claude Code on the web or Routines environment, and setting up an environment's setup script takes a person in the claude.ai UI. The documentation evidence below also shows the fallback, as worded, needs a decision in GOK-167.
> - **R5 takes its fallback.** Node can create a named pipe and use it for request/response, but the pipe's DACL is not user-only: it grants Everyone and Anonymous read access, and Node has no way to narrow it. The control channel authenticates with a per-user secret file under `%LOCALAPPDATA%`.
>
> C3 and P6 are confirmed as the spec states them.

## Verdicts

| Item | Verdict | Decision for downstream |
| -- | -- | -- |
| C3 | **Confirmed.** `--json-schema` works with `--tools ""`, and stdin is the whole prompt. | Keep the spec's flag set unchanged. Treat a run as failed when the exit code is not 0, or `is_error` is true, or `subtype` is not `success`, or `structured_output` is missing. The served bundle must never start with `/`. |
| P6 | **Confirmed.** `authMethod` is stable, and all six values the spec names were observed. | Implement the guard as specified. Parse the stdout JSON even when the exit code is 1. |
| R6 | **Unverifiable, so the fallback applies.** | GOK-167 has to pick the per-session join step (see R6). |
| R5 | **Fallback taken.** | GOK-155: use a named pipe as the transport, authenticate every request with the `%LOCALAPPDATA%` secret, and never pass `readableAll`/`writableAll`. |

## C3: `claude -p --json-schema` with `--tools ""` and the bundle on stdin

### The flag set that worked

This is the spec's §16 invocation, unchanged:

```
<abs>\claude.exe -p --output-format json --json-schema <schema JSON> --setting-sources user
  --strict-mcp-config --settings {"disableAllHooks":true} --tools "" --permission-mode dontAsk
  --permission-prompts none --max-turns 3 --no-session-persistence
  --append-system-prompt-file <procedure.md> [--model <model>]
```

How it was spawned: `child_process.spawn(<absolute claude.exe>, args, { cwd: <fresh mkdtemp dir outside any repo>, windowsHide: true, shell: false })`. The bundle was written to stdin, then stdin was closed. There was no positional prompt. Env: `CLAUDE_CODE_SIMPLE` removed and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` set.

Details confirmed along the way:

- **Argument passing on Windows.** Node's argv quoting carries every argument through intact: the empty `--tools ""` element, the inline JSON of `--settings` and `--json-schema`, and the absolute path of `--append-system-prompt-file`. The stream-json `init` event shows `"tools": ["StructuredOutput"]`, `"mcp_servers": []` and `"permissionMode": "dontAsk"`. The model obeyed the procedure file: every answer began with its required `PROC-OK:` prefix.
- **Hidden flags.** `--append-system-prompt-file` and `--max-turns` are missing from `claude --help`, but both are accepted. An unknown option fails fast instead (`error: unknown option '--bogus-flag'`, exit 1, about 110 ms).
- **`--json-schema` takes inline JSON only.** A file path fails with `Error: --json-schema is not valid JSON: JSON Parse error: Unexpected identifier "C"` (exit 1), and so does malformed JSON. Both fail before any API call. The schema therefore counts toward Windows' 32,767-character command-line limit, so pass it minified.
- **Stdin is the whole prompt.** A 221,558-byte bundle (2,500 lines between a begin token and an end token) came back with both tokens and the exact line count. The cache-creation input was 197,194 tokens, so the whole bundle reached the model.
- **The model can't skip the structured answer.** A bundle telling it not to call any tool and to reply in plain text still ended in a `StructuredOutput` call: subtype `success`, `num_turns` 3.
- **Turn accounting.** A success reports `num_turns: 2`, and the final `StructuredOutput` call counts. `--max-turns 1` still succeeds when the first answer validates. An answer that fails the schema is fed back to the model to retry. With `--max-turns 3`, a schema no value can satisfy ends as `error_max_turns` after `num_turns: 4`, which takes about 8 s.
- **Nothing persists.** No `~/.claude/projects/` entry appeared for any `grimoire-runner-*` cwd, and every temp cwd was still empty afterwards.
- **User plugins still load.** With `--setting-sources user`, the `init` event still lists the user's plugins and their skills. With no `Skill` tool the model cannot invoke them. `apiKeySource` is `"none"` under the subscription login.
- **Plan limits.** The stream-json run emitted a `rate_limit_event` with `five_hour` and `seven_day` utilization windows. That is direct evidence that runner runs draw on the plan's shared limits, which is the warning `runner enable` prints.
- **Parent session env.** A child spawned with a parent Claude Code session's env (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_*`, …) also succeeded. Nothing requires stripping those variables, but stripping them keeps the child off the parent's messaging socket. If the runner strips them, the billing guard must see the same env.
- **Timing.** Wall times were 3.3 to 4.5 s per small run (Haiku 5.5 or the default Opus 5.5), and 4.5 s for the 221 KB bundle.

### The output shape (`--output-format json`)

There is one JSON line on stdout, then `\n`. Fields seen: `type` (`"result"`), `subtype`, `is_error`, `num_turns`, `result`, `structured_output`, `errors`, `api_error_status`, `stop_reason`, `terminal_reason`, `session_id`, `uuid`, `duration_ms`, `duration_api_ms`, `total_cost_usd`, `usage`, `modelUsage`, `permission_denials`, plus a few timing and fast-mode fields. Fixtures are in `test/fixtures/claude-code/print-json/`.

| Case | Exit | `subtype` | `is_error` | `structured_output` | `result` | Fixture |
| -- | -- | -- | -- | -- | -- | -- |
| Valid answer | 0 | `success` | false | the answer object | the same JSON as text | `success-structured-output.json` |
| Answer never satisfies the schema | 1 | `error_max_turns` | true | absent | absent; `errors: ["Reached maximum number of turns (3)"]`, `terminal_reason: "max_turns"` | `error-max-turns.json` |
| API error (a fake `ANTHROPIC_API_KEY`) | 1 | **`success`** | true | absent | `"Invalid API key · Fix external API key"`, `api_error_status: 401` | `api-error-invalid-key.json` |
| Not logged in (`CLAUDE_CODE_SIMPLE=1`) | 1 | **`success`** | true | absent | `"Not logged in · Please run /login"` | (not kept) |
| Stdin starts with `/cost` | 0 | `success` | false | absent | the command's output; `num_turns: 0`, the model never ran | `success-local-command.json` (run with `--disable-slash-commands`, so its `result` reads `"/cost isn't available in this environment."`) |

What this means for failure detection:

- The spec's rule ("the subtype isn't `success`, or `structured_output` is missing") catches every case observed, because every failure also lacked `structured_output`.
- API and auth errors report `subtype: "success"`, though. To make that explicit, also treat `is_error: true` and a non-zero exit code as failures.
- Read the answer only from `structured_output`. On errors, `result` is error text.

**The bundle must never start with `/`.** A prompt that starts with a slash command runs the command, not the model. Without `--disable-slash-commands`, `/cost` printed the user's plan usage. With it, the command is still parsed as a command (`"/cost isn't available in this environment."`). Start the served bundle with a fixed plain-text header line.

## P6: `claude auth status` under the child's env

Each case below ran `claude auth status` (JSON is its default output) from a fresh temp cwd, with the runner child's env plus one change.

| Env change | `authMethod` | `apiProvider` | `apiKeySource` | `loggedIn` | Exit |
| -- | -- | -- | -- | -- | -- |
| none (5 runs) | `claude.ai` every time | `firstParty` | — | true | 0 |
| parent Claude session env left in | `claude.ai` | `firstParty` | — | true | 0 |
| `ANTHROPIC_API_KEY` (fake) | `api_key` | `firstParty` | `ANTHROPIC_API_KEY` | true | 0 |
| `apiKeyHelper` in the config dir's `settings.json` | `api_key_helper` | `firstParty` | `apiKeyHelper` | true | 0 |
| `CLAUDE_CODE_OAUTH_TOKEN` (fake) | `oauth_token` | `firstParty` | — | true | 0 |
| `ANTHROPIC_AUTH_TOKEN` (fake) | `oauth_token` | `firstParty` | — | true | 0 |
| `CLAUDE_CODE_USE_BEDROCK=1` | `third_party` | `bedrock` | — | true | 0 |
| `CLAUDE_CODE_USE_VERTEX=1` | `third_party` | `vertex` | — | true | 0 |
| `CLAUDE_CODE_USE_FOUNDRY=1` | `third_party` | `foundry` | — | true | 0 |
| `CLAUDE_CODE_SIMPLE=1` | `none` | `firstParty` | — | false | 1 |
| `CLAUDE_CONFIG_DIR=<empty dir>` (not logged in) | `none` | `firstParty` | — | false | 1 |

- **Stable and cheap.** Each call took 117 to 160 ms. That is fast enough to run before every run, and suggests no network round trip.
- **Fake credentials are not validated.** `auth status` only reports which credential source is in force.
- **An env key outranks the subscription login.** This holds in `auth status` and in the actual `-p` child. With a fake `ANTHROPIC_API_KEY`, the child printed "claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login" and failed with a 401. The guard is needed.
- **`CLAUDE_CODE_SIMPLE=1` (bare mode) means `none`.** The runner must remove it, as the spec says.
- **Decision.**
  - Run `claude auth status --json` (pass the flag explicitly) with the child's exact env and cwd.
  - Parse stdout whatever the exit code; `none` exits 1.
  - Accept `claude.ai`. Accept `api_key`, `api_key_helper`, `oauth_token` and `third_party` only with `allow_api_billing`. Always refuse `none`.
  - Refuse anything else, including unparseable output, and report the preflight as failed (the P6 fallback rule).
  - `ANTHROPIC_AUTH_TOKEN` has no value of its own: it shows as `oauth_token`.
- **Risk.** Earlier research (`docs/research/keyless-llm.md`) quotes Anthropic saying `--bare` will become the default for `-p`. If that happens, `auth status` (which is not a `-p` call) can still say `claude.ai` while every `-p` child fails with "Not logged in · Please run /login", as observed under `CLAUDE_CODE_SIMPLE=1`. The failure rule above catches that. The runner should show it in `status` as a preflight-class failure.
- Fixtures: `test/fixtures/claude-code/auth-status/`.

## R6: a cloud setup script carries no agent markers, and its writes persist

**Unverifiable here, so the fallback applies.** Verifying it means creating or editing a Claude Code on the web environment, its setup script and a Routine, in the claude.ai UI under the person's account. No such environment can be reached from this headless session.

Evidence gathered instead, which GOK-167's recipe has to account for:

- **Documentation** ([Configure cloud environments](https://code.claude.com/docs/en/cloud-environments), fetched 2026-10-11):
  - "A setup script is a Bash script that runs when a new cloud session starts, before Claude Code launches." Scripts run as root on Ubuntu 24.04 and must exit 0.
  - "The setup script runs the first time you start a session in an environment. When setup completes within roughly five minutes, Anthropic snapshots the filesystem and reuses that snapshot as the starting point for later sessions. New sessions … skip the setup script step."
  - The script reruns only when the script or the allowed hosts change, or after a cache expiry of about seven days.
  - SessionStart hooks run "after Claude Code launches, on every session including resumed". The session VM's env carries `CLAUDE_CODE_REMOTE=true`.
  - The docs don't say whether the repository clone, and so `<git-common-dir>/grimoire/`, is part of the snapshot or re-cloned for each session.
- **Local evidence on agent markers.** Claude Code 2.1.296 sets two of grimoire's agent markers (§7) in the processes it starts:
  - A SessionStart hook process saw `AI_AGENT=claude-code_2-1-296_harness` and `CLAUDE_CODE_CHILD_SESSION=1`, plus `CLAUDECODE`, `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PROJECT_DIR`. This was a throwaway repo's `.claude/settings.json` hook, run by `claude -p`.
  - The Bash tool sees `AI_AGENT=claude-code_2-1-296_agent` and `CLAUDE_CODE_CHILD_SESSION=1`.
  - So inside a cloud session, the hooks and the routine prompt can't run the human-only `init` join: they get `HUMAN_ONLY`. The setup script runs before Claude Code launches, so it is plausibly marker-free, but that is unverified.

**What this means for the fallback.** The fallback says "the join runs as the first step of each session's setup". Under environment caching, the setup script does not run for each session. A SessionStart hook does run for each session, but it carries agent markers. So GOK-167 must choose:

- **(a) Recommended for v1.** Document the join in the setup script, written to be idempotent. Add a first-run check that the person does by hand: `grimoire status` in a cloud session shows the clone joined. If the snapshot drops `<git-common-dir>/grimoire/`, editing the setup script forces a rebuild, and the recipe says so.
- **(b)** Let grimoire's own `hook session-start` (an entry verb, not human-only) do the cloud join when `CLAUDE_CODE_REMOTE=true` and the clone is not set up. That is a spec change.

The routine prompt is never an option: its shell carries markers.

## R5: a user-only Windows named pipe from Node

### What Node creates

`net.createServer().listen('\\\\.\\pipe\\grimoire-spike-<hex>')` works, and so does a request/response exchange from a separate Node process:

- `{"op":"sign-in"}` got back `{"ok":true,"code":…}`.
- `{"op":"stop"}` got back `{"ok":true,"stopping":true}`, then the server closed.
- A later connect got `ENOENT`.
- A second `listen` on the same name gets `EADDRINUSE` (libuv sets `FILE_FLAG_FIRST_PIPE_INSTANCE`).

### The ACL evidence

The pipe's security descriptor was read by opening it with `READ_CONTROL` and calling `GetKernelObjectSecurity`, from PowerShell 5.1 (`pipe-sddl.ps1`). `<user>` is the logged-in user's SID.

- **Defaults** (`listen(path)`):

  ```
  O:<user>G:<user's primary group>D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)(A;;FR;;;WD)(A;;FR;;;AN)
  ```

- **`listen({ path, readableAll: true, writableAll: true })`:**

  ```
  D:(A;;0x12019f;;;WD)(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)(A;;FR;;;AN)
  ```

Reading the default DACL:

- LocalSystem (`SY`), Administrators (`BA`) and the user get full control.
- **Everyone (`WD`) and Anonymous (`AN`) get `FR`** (`FILE_GENERIC_READ`), so the pipe is not user-only. `FR` has no `FILE_WRITE_DATA` and no `FILE_CREATE_PIPE_INSTANCE`. Another account can open the pipe read-only, but it cannot send a request, and it cannot create a squatting instance while `start` holds the name.
- Node's only ACL knobs, `readableAll` and `writableAll`, widen access: they add Everyone read/write (`0x12019f`).
- Node has no API to narrow the DACL, and a native addon is ruled out because the package must stay dependency-free.
- This could not be tested from a second account on this machine. The verdict rests on the DACL itself.

### The fallback, exercised

`probe-secret.mjs` tried the fallback end to end:

1. It wrote a 32-byte random secret to `%LOCALAPPDATA%\grimoire-spike-<hex>\control.secret` with `flag: 'wx'`.
2. It required that secret, compared with `timingSafeEqual`, on every pipe request.

Node ignores `mode: 0o600` on Windows. The file's ACL is inherited from `%LOCALAPPDATA%`, and `icacls` shows SYSTEM, Administrators and the user with full control, all inherited, and nobody else. That matches the principals that can already write to the pipe.

Results:

- The right secret got a sign-in code.
- A wrong secret got `BAD_SECRET`, for both `sign-in` and `stop`.
- `stop` with the secret closed the server.

### Decision for GOK-155 (control channel)

- Transport on Windows: a named pipe from `net.createServer().listen(<pipe path>)`. Never pass `readableAll` or `writableAll`.
- Every control request (sign-in code, `stop`) must carry proof of a per-user secret. The secret lives in a file under `%LOCALAPPDATA%` and is written fresh by each `start` before it listens.
  - Prefer a challenge-response (an HMAC of a server nonce) over sending the secret itself. Then a client that reaches a squatted pipe while `start` is down never discloses it.
  - The server writes nothing on a connection until a request has been verified.
  - Uninstall already lists "the named-pipe fallback secret" (§21).
- Put the live `start` lock's nonce in the pipe name. `open` and a second `start` should connect only while the lock is live.
- Unix (a socket in a 0700 directory) was not exercised on this Windows machine.
- Node 22 (the floor) was not tested, only Node 24. The pipe-creation path in libuv is long-standing, but a Windows CI test that the secret is required would catch a regression.

## Reproduce

The throwaway scripts are in [`claude-runner-ipc/`](claude-runner-ipc/). Copy them to a scratch directory outside any git repo, then:

```sh
node make-inputs.mjs                                   # inputs/ (procedure, schemas, bundles) and out/
node mkcfg.mjs c3-f '{}'                               # the exact spec flags, default model
node probe-claude.mjs c3-f out/c3-f.cfg.json           # writes out/c3-f.record.json and out/c3-f.stdout.txt
node mkcfg.mjs c3-c '{"model":"haiku","stdin":"bundle-large.txt"}'
node mkcfg.mjs c3-g '{"model":"haiku","schemaFile":"schema-unsat.json"}'
node mkcfg.mjs c3-b '{"model":"haiku","format":"stream-json","verbose":true}'   # the init event
node mkcfg.mjs c3-k '{"model":"haiku","set":{"ANTHROPIC_API_KEY":"sk-ant-api03-FAKEFAKEFAKE"}}'
node mkcfg.mjs c3-j '{"model":"haiku","stdin":"bundle-slash.txt","extra":["--disable-slash-commands"]}'
node probe-auth.mjs out                                # P6 table, writes out/p6-auth.json
node probe-pipe.mjs                                    # R5 defaults
node probe-pipe.mjs --readable-writable-all            # R5 widened
node probe-secret.mjs                                  # R5 fallback
```

Run each `mkcfg.mjs` case through `probe-claude.mjs` as shown for `c3-f`. `CLAUDE_BIN` overrides the binary, which defaults to `~/.local/bin/claude.exe`. `dump-env.mjs` is the SessionStart hook command used for the R6 marker check: point a throwaway repo's `.claude/settings.json` at it and run `claude -p` there with hooks enabled.
