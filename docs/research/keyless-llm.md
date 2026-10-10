# Keyless LLM: what are the ways to run knowledge-layer LLM work without grimoire holding an API key?

*Research for GOK-110. Checked against primary sources on 2026-10-11. Versions seen that day: Claude Code 2.1.296 (the installed `claude.exe --version` on this machine, and the top of the CHANGELOG), `@anthropic-ai/claude-agent-sdk` 0.3.296, and `@openai/codex` plus `@openai/codex-sdk` 0.162.1 ([npm registry](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)). "(unverified)" marks claims I could not confirm in a primary source. Items marked [added] are new facts that could change a decision. Items marked [corrected] differ from the previous draft.*

## Question

Grimoire never holds its own LLM API key. Its knowledge layer still needs LLM work:

- **Wiki Maintainer:** compile raw traces into pattern pages.
- **Skill Proposer:** propose one atomic `SKILL.md` change.

The question is which mechanisms a local Node process can use today to get that work done through agents already on the machine. The process is grimoire, running on Node 22+ on Windows 11 with Claude Code and Codex installed. For each mechanism this document covers:

- whether it runs unattended or on a schedule
- what it costs the user
- what file and tool access the LLM gets
- how it fails
- how Node invokes it

---

## Answer in brief

1. **In-session delegation is the only path that works with every client and needs no extra auth or spawning.** Grimoire queues "knowledge chores". A connected agent (Claude Code, Codex, or any MCP client) does them in its own session and submits the results back through grimoire's tools. The catch is that it is not unattended: it runs only when an agent session is active and the agent picks the chore up.
2. **Headless agent CLIs (`claude -p`, `codex exec`) are the practical unattended path, but both are opt-in and fragile.** Both reuse the user's existing login and both support schema-constrained output.
   - **Claude:** subscription metering and a policy gray zone. Anthropic's own docs call `claude -p` "the Agent SDK via the CLI". [added] Anthropic also says `--bare` "will become the default for `-p` in a future release", and bare mode never reads the subscription login.
   - **Both:** a recursion hazard (the child run loads grimoire's own MCP server and hooks) and Windows spawning quirks.
3. **MCP sampling is effectively dead for this purpose.** The spec deprecated it, together with Roots and Logging, as of `2026-07-28`. It can only happen inside a client request, and neither Claude Code nor Codex implements it.
4. **Local models through Ollama are a clean optional add-on**, with real quality and hardware costs.
5. **Agent-native schedulers** can turn in-session delegation into scheduled runs without grimoire holding any credential: Claude Routines (cloud), Claude Desktop local scheduled tasks, ChatGPT/Codex desktop-app scheduled tasks, and `/loop` (session-scoped).

---

## 1. Headless agent CLIs

### 1a. Claude Code: `claude -p` and the Agent SDK

**Invocation and output**

- `claude -p "<prompt>"` runs non-interactively. It exits 0 on success and non-zero on failure. An invalid flag is reported on stderr before the run starts. Failures inside the run, such as missing authentication, are printed as the result on stdout ([headless](https://code.claude.com/docs/en/headless)).
- `--output-format` accepts `text`, `json` or `stream-json`. The JSON result includes `result`, `session_id`, usage, `total_cost_usd` and a per-model cost breakdown. Both cost figures are client-side estimates ([headless](https://code.claude.com/docs/en/headless)).
- `--json-schema '<schema>'` with `--output-format json` puts schema-validated output in `structured_output`. Since v2.1.205 an invalid schema is a hard error (`Error: --json-schema is not a valid JSON Schema`). The `format` keyword is accepted as an annotation but not enforced ([headless](https://code.claude.com/docs/en/headless); [CLI reference](https://code.claude.com/docs/en/cli-reference)).
- Stdin is read, so content can be piped in. Piped stdin is capped at 10 MB, and going over the cap exits non-zero ([headless](https://code.claude.com/docs/en/headless)).
- Run limits and prompt flags ([CLI reference](https://code.claude.com/docs/en/cli-reference)):
  - `--max-turns` stops a run with an error after N turns.
  - `--max-budget-usd` stops at an estimated spend, and spend can pass the cap.
  - `--no-session-persistence` keeps the run out of saved sessions.
  - `--system-prompt-file` replaces the system prompt; `--append-system-prompt-file` adds to it.
- [added] **`--bare` is on track to become the default.** The headless page says: "`--bare` is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release." Bare mode never reads OAuth credentials. If the default flips, a keyless `claude -p` runner breaks: the auth failure arrives as a result on stdout. No opt-out flag is documented today (unverified whether one will exist). `CLAUDE_CODE_SIMPLE=1` in the environment is equivalent to `--bare`, so grimoire must strip it from the child's environment ([headless](https://code.claude.com/docs/en/headless); [env vars](https://code.claude.com/docs/en/env-vars)).

**Tool permissions (what the LLM can touch)**

- `--tools "Read,Grep,Glob"` limits which built-in tools exist, and `""` disables all of them. The flag does not affect MCP tools; to deny those, use `--disallowedTools "mcp__*"` ([CLI reference](https://code.claude.com/docs/en/cli-reference)).
- `--allowedTools` auto-approves tools using permission-rule syntax. Path-scoped edit rules look like `Edit(.grimoire/wiki/**)`. File permission checks only consult `Edit(...)` and `Read(...)` rules. A `Write(...)` path rule is accepted but never consulted, and Claude warns about it at startup ([permissions](https://code.claude.com/docs/en/permissions)).
- `--permission-mode dontAsk` denies every call that would prompt. File reads in the working directories, the read-only command set, and calls covered by allow rules still run ([headless](https://code.claude.com/docs/en/headless)).
- `--permission-prompts none` (v2.1.259+) denies unresolved prompts and tells Claude nobody can approve and not to retry. It also removes `AskUserQuestion` ([headless](https://code.claude.com/docs/en/headless)).
- Always pass an explicit mode. Without one, a `-p` run starts in the built-in starting mode, which "can be `auto`" ([headless](https://code.claude.com/docs/en/headless)).
- [added] **`--restricted` (v2.1.248+)** is designed for a harness driving `claude` on a shared machine ([CLI reference](https://code.claude.com/docs/en/cli-reference)). It:
  - removes the built-in tools that run commands or code, and WebFetch
  - confines the file tools to the working directories
  - loads only managed settings and `--settings`
  - refuses `bypassPermissions`

  This is a closer fit for a read-only grimoire runner than assembling separate flags. Whether it still uses the subscription login is not stated (unverified; test it).
- **cwd and sandbox:** Claude works in the spawn cwd, and `--add-dir` grants more directories. "On native Windows, Claude Code runs commands unsandboxed"; the sandbox needs WSL2 ([sandboxing](https://code.claude.com/docs/en/sandboxing); [setup](https://code.claude.com/docs/en/setup)). On the target machine, permission rules and tool restriction are therefore the only containment.

**Auth reuse**

- Without `--bare`, `claude -p` uses the normal credential order. Subscription OAuth from `/login` is **item 7, the last**: "the default for Claude Pro, Max, Team, and Enterprise users" ([authentication](https://code.claude.com/docs/en/authentication)).
- **`--bare` never reads OAuth credentials, the keychain or `CLAUDE_CODE_OAUTH_TOKEN`.** It needs `ANTHROPIC_API_KEY` or an `apiKeyHelper`, so it is unusable for keyless grimoire ([headless](https://code.claude.com/docs/en/headless); [authentication](https://code.claude.com/docs/en/authentication)).
- [corrected/broadened] **Billing trap.** Every credential source ranked above `/login` silently takes over:
  1. cloud-provider variables (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`)
  2. `ANTHROPIC_AUTH_TOKEN`
  3. `ANTHROPIC_API_KEY`: "In non-interactive mode (`-p`), the key is always used when present."
  4. `apiKeyHelper`
  5. `CLAUDE_CODE_OAUTH_TOKEN`
  6. Anthropic profiles and federation credentials

  ([authentication](https://code.claude.com/docs/en/authentication); [support](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan))
- [added] **Preflight without spending usage:** `claude auth status` prints JSON and exits 0 if logged in, 1 if not. Its `authMethod` is one of `none`, `claude.ai`, `oauth_token`, `api_key`, `api_key_helper` or `third_party` ([CLI reference](https://code.claude.com/docs/en/cli-reference)). Run it with the same environment as the planned child, and refuse or warn unless it reports `claude.ai`.
- On Windows, credentials live in `%USERPROFILE%\.claude\.credentials.json`. Grimoire must never read this file ([authentication](https://code.claude.com/docs/en/authentication)).

**Policy, the key risk for this path**

- Agent SDK overview: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK" ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)).
- Legal page:
  - "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication…"
  - "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users."
  - [added] "developers may not collect, store, or intermediate Claude.ai credentials or session tokens."
  - The carve-out: it does not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription."
  - "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
  - "Anthropic reserves the right to take measures to enforce these restrictions and may do so without prior notice."

  ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance))
- [corrected] **The draft's main distinction does not hold up well.** The draft said spawning the CLI is clearly different from bundling the SDK. Anthropic's headless page instead describes `claude -p` as "using the Agent SDK via the CLI". The overview's line "run the CLI as a subprocess with the `-p` flag and `--output-format json`" applies "to drive the same agent loop from a language other than Python or TypeScript". It is not a policy endorsement of spawning the CLI as a way to use the subscription.

**Interpretation (unverified; a legal reading, not a ruling):**

- The most defensible shape is grimoire spawning the user's own unmodified `claude.exe`, which the user signed into themselves, on the user's machine, only after explicit per-repo opt-in, never touching credentials, and visible in logs.
- It still sits in a gray zone, because grimoire is a third-party product driving subscription usage programmatically.
- Bundling the Agent SDK and letting it inherit the claude.ai login is squarely in the restricted zone.
- Treat the `claude-cli` runner as optional and removable, and ask Anthropic before promoting it.

**Cost and limits**

- Pro and Max have a 5-hour session limit and a weekly limit, "shared across Claude and Claude Code" ([support](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)).
- [corrected] The 2026-06-15 banner says "We've paused the previously-announced changes to Claude Agent SDK usage… Claude Agent SDK, claude -p, and third-party app usage still draw from your subscription limits." The 2026-10-07 banner repeats that these can still use subscription limits ([support](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)). The paused item is "changes to Agent SDK usage". The separate June Agent SDK credit "isn't available", per the credits article.
- Max and Team monthly API credits (Max 5x $100, Max 20x $200, Team $20 or $100 per seat; Pro not eligible) cover `claude -p` **only when run with an API key** from the linked Console org. Under a subscription login, `-p` "still draw[s] from your plan's usage limits" ([support](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans)).

**Recursion and trust hazard (important for grimoire)**

Without `--bare`, a `-p` session runs the hooks in a project's `.claude/settings.json` and connects the servers in its `.mcp.json`, "even in a folder you've never trusted". There is no trust dialog and no per-server prompt. Project skills' hooks and `allowed-tools` are also used ([headless](https://code.claude.com/docs/en/headless); [permissions](https://code.claude.com/docs/en/permissions)).

Grimoire's own pointer files live in that host repo: its MCP server, and any SessionStart hook that announces chores. The child run would load grimoire again and could be told to do chores about itself.

[corrected] Mitigations listed on the [permissions](https://code.claude.com/docs/en/permissions) page:

- `--setting-sources user`, which reads neither project settings nor `.mcp.json`
- `--bare`, which is not usable for keyless runs
- `--settings '{"disableAllHooks": true}'`
- `disabledMcpjsonServers`

`--strict-mcp-config` is not on that list. It comes from the [CLI reference](https://code.claude.com/docs/en/cli-reference) ("Only use MCP servers from `--mcp-config`"). It is still needed: [added] claude.ai MCP connectors load whenever the session uses the claude.ai login, regardless of setting sources, and strict MCP config suppresses them ([SDK: what settingSources does not control](https://code.claude.com/docs/en/agent-sdk/claude-code-features)).

[added] Even with `--setting-sources user`, some inputs still load:

- **User-level hooks** from `~/.claude/settings.json`. Add `disableAllHooks` if needed, at the cost of the user's own safety hooks.
- **Auto memory.** Set `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` to turn it off.
- **`~/.claude.json`.** This one is always read.

[added, resolves a prior open question] Project skills, subagents, commands, `CLAUDE.md` and `.claude/rules` all belong to the `project` setting source. Under `--setting-sources user` they do not load, per the SDK docs, which state that this matches CLI behavior. So a spawned runner cannot rely on grimoire's committed skill. Pass the procedure through `--append-system-prompt-file` or stdin.

**Agent SDK (`@anthropic-ai/claude-agent-sdk`)**

- It bundles a native Claude Code binary as a per-platform optional dependency; SDK 0.3.N bundles CLI 2.1.N. `pathToClaudeCodeExecutable` overrides it ([TS SDK](https://code.claude.com/docs/en/agent-sdk/typescript); [npm](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest)).
- Options mirror the CLI: `cwd`, `allowedTools`, `disallowedTools`, `permissionMode`, `permissionPrompts`, `settingSources`, `maxTurns`, `maxBudgetUsd`, and `outputFormat: {type:'json_schema', schema}`.
- **Avoid it for grimoire.** The policy note names the SDK directly, and it adds a heavy native dependency.

**Windows**

- The native installer puts `claude.exe` at `%USERPROFILE%\.local\bin\claude.exe` ([setup](https://code.claude.com/docs/en/setup) uninstall steps). Confirmed on this machine: v2.1.296 is there, with an auto-updater `claude.exe.old.*` file beside it.
- The npm package's `bin` is `bin/claude.exe` ([npm](https://registry.npmjs.org/@anthropic-ai/claude-code/latest)). npm's global shim on Windows is a `.cmd` file (see section 5).
- Without Git for Windows, the shell tool is PowerShell ([setup](https://code.claude.com/docs/en/setup)).

**Failure modes**

- Not logged in, or login expired ("Login expired · Please run /login").
- The 5-hour or weekly limit is hit (`rate_limit` in `system/api_retry` events).
- An org policy (`forceLoginOrgUUID`, `forceLoginMethod`, `allowedProviders`) blocks the credential.
- An older CLI rejects newer flags with an unknown-option error.
- `--max-turns` exits with an error.
- Permission denials truncate the work; they are listed in `permission_denials`.
- [added] Structured output fails with the result subtype `error_max_structured_output_retries`. A `success` result *without* `structured_output` must also be treated as failure ([structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs)).
- [added] A future change makes `--bare` the default for `-p`.
- The recursion described above.
- An unexpected API bill from any higher-precedence credential.

**Node invocation sketch** (flags as documented; this combination has not been run end to end):

```ts
import { spawn } from "node:child_process";
const env = { ...process.env };
delete env.CLAUDE_CODE_SIMPLE;              // would force bare mode (no OAuth)
env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
const child = spawn(claudeExePath /* absolute .exe path, see section 5 */, [
  "-p", "--output-format", "json", "--json-schema", JSON.stringify(schema),
  "--setting-sources", "user", "--strict-mcp-config",       // no project hooks/.mcp.json/connectors -> no recursion
  "--tools", "Read,Grep,Glob", "--permission-mode", "dontAsk", "--permission-prompts", "none",
  "--max-turns", "20", "--no-session-persistence",
  "--append-system-prompt-file", promptFile,               // project skills won't load under --setting-sources user
], { cwd: repoRoot, env, windowsHide: true });
child.stdin.end(taskText);                 // stdin avoids the 32,767-char Windows command-line cap
// parse stdout -> { is_error, subtype, result, structured_output, total_cost_usd, session_id }
// treat subtype !== "success" OR missing structured_output as failure
```

**Unverified:**

- whether `--json-schema` works with `--tools ""`
- whether `-p` with no positional prompt treats stdin as the whole prompt (likely)
- whether `--restricted` keeps subscription OAuth

Test all three before relying on them.

### 1b. Codex: `codex exec` and the Codex SDK

**Invocation and output**

- `codex exec` (alias `codex e`) takes a prompt as an argument. If the argument is omitted, it reads the prompt from stdin. If both are given, piped stdin becomes extra context ([non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode); [CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)).
- Progress goes to stderr; only the final message goes to stdout.
- `--json` emits JSONL events: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*` and `error`.
- `--output-schema <file>` constrains the final answer. `-o/--output-last-message <path>` writes it to a file and still prints it.
- `--ephemeral` skips session rollout files. `--cd/-C` sets the workspace root. `-m` picks the model. `--ignore-user-config` skips `$CODEX_HOME/config.toml`, and `--ignore-rules` skips execpolicy rules.

**Sandbox and approvals**

- "By default, `codex exec` runs in a read-only sandbox." `--sandbox` accepts `read-only`, `workspace-write` or `danger-full-access`. `--full-auto` is deprecated and prints a warning ([non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode)).
- [added] The CLI reference describes `--sandbox` as "Defaults to configuration". A user's `config.toml` can therefore widen the default, so always pass `--sandbox read-only` explicitly ([CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)).
- The source hard-codes `approval_policy: Some(AskForApproval::Never)` ("Default to never ask for approvals in headless mode"). It rebuilds the config without that override only when the resolved approvals reviewer is `AutoReview` ([codex-rs/exec/src/lib.rs](https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs), checked on main 2026-10-11).
- Codex requires a Git repository; `--skip-git-repo-check` overrides this. Outside a repo, the source prints "Not inside a trusted directory and --skip-git-repo-check was not specified." and exits 1. A grimoire host repo is a git repo, so this is fine.

**Auth reuse**

- "`codex exec` reuses saved CLI authentication by default" ([non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode)).
- Credentials live in `~/.codex/auth.json` (plaintext) or the OS credential store, controlled by `cli_auth_credentials_store` ([auth](https://learn.chatgpt.com/docs/auth)).
- OpenAI says "Use API key authentication for programmatic Codex CLI workflows, such as CI/CD jobs." ChatGPT-workspace automation uses Enterprise-issued Codex access tokens, "intended for trusted scripts, schedulers, and private CI runners" ([auth](https://learn.chatgpt.com/docs/auth)).
- No statement forbids a local tool from invoking the user's own `codex exec` under ChatGPT login, and none permits it. That none exists is unverified.

**Cost and limits** ([pricing](https://learn.chatgpt.com/docs/pricing))

- Codex is included in ChatGPT Free, Go, Plus, Pro, Business, Edu and Enterprise. "Local messages and cloud chats share your plan's usage allowance. Weekly limits may also apply."
- Plus and Standard Business have 5-hour windows. "Pro plans currently have no five-hour limit."
- Users can run extra local chats with an API key at API rates.
- "GPT-5.5 retires from ChatGPT, ChatGPT Work, and Codex on all plans on October 14, 2026." Don't hard-code model names.

**Windows**

- Sandbox modes ([Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)):
  - `mxc` is recommended and needs no admin setup.
  - `elevated` is the legacy mode and needs admin-approved setup.
  - `unelevated` is a legacy fallback with weaker isolation.
- [corrected/added] The *desktop app* prefers MXC automatically for consumer accounts. The **standalone CLI** needs `prefer_mxc = true`; otherwise "Codex prefers `elevated` when no mode is selected".
- MXC requires Windows 11 24H2 (build 26100.9278+) or 25H2 (build 26200.9278+). This machine is 25H2 build 26200.9457, so it qualifies on build number.
- Windows 11 is recommended; Windows 10 1809+ is best effort.
- Whether read-only `codex exec` on native Windows triggers sandbox setup is unverified.
- The npm package's `bin` is `bin/codex.js`, a Node launcher, with per-platform binaries as optional dependencies ([npm](https://registry.npmjs.org/@openai/codex/latest)). On Windows that means a `.cmd` shim.

**Codex SDK (`@openai/codex-sdk`)**

- It "wraps the `codex` CLI from `@openai/codex`. It spawns the CLI and exchanges JSONL events over stdin/stdout." It supports per-turn `outputSchema`, `workingDirectory` and `skipGitRepoCheck` ([README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)).
- It runs `exec --experimental-json`, writes the prompt to stdin, and resolves `codex.exe` from `@openai/codex-win32-x64/vendor/<triple>/bin` ([exec.ts](https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts)). An `apiKey` option sets `CODEX_API_KEY`.
- [corrected] It depends on `@openai/codex` pinned at 0.162.1 ([npm](https://registry.npmjs.org/@openai/codex-sdk/latest)), so it installs its own binary. However, `codexPathOverride` lets it run the user's binary instead. Sharing the saved login through `CODEX_HOME` is my inference (unverified).
- Its spawn pattern is worth copying: absolute binary path, prompt over stdin, JSONL parsing, stderr captured. Depending on the package is optional.

**Recursion hazard for Codex [added]**

- Codex loads project `.codex/` layers (config including MCP servers, hooks and rules) only when the project is trusted. User and system config always load ([config basics](https://learn.chatgpt.com/docs/config-file/config-basic.md)).
- A repo the user already works in with Codex is likely trusted. A `codex exec` child there would likely attach grimoire's MCP server and hooks, whether those are declared in project `.codex/config.toml` or in user config via `codex mcp add`. That exec follows the same trust rule is unverified.
- `--ignore-user-config` drops user config only. I found no documented equivalent of `--strict-mcp-config` (unverified).

**Other notes**

- `codex mcp-server` and the standalone `codex-mcp-server` binary "have been removed". The replacement, `codex app-server`, is "primarily for development and debugging and may change without notice" ([CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)).

**Failure modes**

- Not in a git repo.
- A `required = true` MCP server fails to start, so exec "exits with an error" ([non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode)).
- Windows sandbox setup errors such as error 1385, where Windows denies the sandbox user's logon type ([Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox)).
- Plan limits are hit.
- Retired model names.
- `CODEX_API_KEY` or `OPENAI_API_KEY` in the environment changes the billing path (unverified; precedence is not documented).
- Recursion through grimoire's own MCP server or hooks.

**Node invocation sketch:**

```ts
spawn(codexExePath, ["exec", "--json", "--sandbox", "read-only", "--output-schema", schemaPath,
  "-o", outFile, "--cd", repoRoot, "--ephemeral"], { windowsHide: true })
  .stdin.end(taskText);   // prompt arg omitted, so Codex reads it from stdin
```

**Unverified:** schemas probably need `additionalProperties: false` and every property listed in `required`, as in the SDK README example and `zodToJsonSchema(..., { target: "openAi" })`.

---

## 2. MCP sampling (`sampling/createMessage`)

**Spec status (verified)**

- The current spec page carries a banner: "**Deprecated**: The Sampling feature is deprecated as of protocol version `2026-07-28` (SEP-2577)… New implementations **SHOULD NOT** adopt it; existing implementations **SHOULD** migrate to integrating directly with LLM provider APIs" ([sampling spec](https://modelcontextprotocol.io/specification/latest/client/sampling)).
- Earliest removal is the "First revision released on or after 2027-07-28" ([deprecated registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated)).
- SEP-2577 ("Deprecate Roots, Sampling, and Logging") was merged on 2026-05-15. It cites "low adoption relative to their implementation complexity" and, for Sampling, "low client adoption" ([SEP-2577](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2577)).
- [added] **Roots is deprecated too.** Grimoire's MCP server should not rely on `roots/list` to find the host repo. Claude Code passes `CLAUDE_PROJECT_DIR` to MCP servers ([Claude MCP docs](https://code.claude.com/docs/en/mcp)), or the path can come from server config.

**Never unattended, by design**

- In `2026-07-28`, "Servers **MUST** send server-to-client requests (such as `roots/list`, `sampling/createMessage`, or `elicitation/create`) using the MRTR pattern. The previous pattern of server-initiated requests is no longer supported." `InputRequiredResult` is only allowed on `prompts/get`, `resources/read` and `tools/call` ([MRTR](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr)).
- The spec says there "SHOULD always be a human in the loop with the ability to deny sampling requests."
- So grimoire could only sample while a client is calling one of its tools, and the user would usually have to approve.

**Which clients implement it today**

| Client | Sampling? | Evidence |
|---|---|---|
| Claude Code | **No** | Feature request [#1785](https://github.com/anthropics/claude-code/issues/1785) is still open, with its latest visible activity on 2026-09-25 (cross-reference). "Sampling" appears nowhere in the [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) (2.1.296) or the [MCP docs](https://code.claude.com/docs/en/mcp). The MCP docs do document roots, elicitation and channels. |
| Codex | **No** | `mcp_initialize_request_params` sets only `elicitation` plus extensions and sends `2025-06-18`. The source also has a `V20260728` protocol-discovery mode ([rmcp_client.rs](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/rmcp_client.rs)). The `ClientHandler` implements `create_elicitation` but not `create_message` ([logging_client_handler.rs](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/logging_client_handler.rs)). Checked on main, 2026-10-11. |
| Cursor | Not listed | The protocol support table lists Tools, Prompts, Resources, Roots, Elicitation and Apps; "sampling" does not appear ([Cursor MCP docs](https://cursor.com/docs/context/mcp)). |
| VS Code (Copilot Chat) | **Yes** | Uses "the user's configured models and subscriptions". The user is "prompted to authorize the server to access their models" on the first request. There are "Configure Model Access" and "Show Sampling Requests" commands ([VS Code MCP guide](https://code.visualstudio.com/api/extension-guides/ai/mcp)). |
| GitHub Copilot CLI | **Yes** | v1.0.13 (2026-03-30): "MCP servers can request LLM inference (sampling) with user approval via a new review prompt" ([release](https://github.com/github/copilot-cli/releases/tag/v1.0.13)). In 1.0.64 (2026-06-23), autopilot mode began to auto-handle sampling prompts ([changelog](https://github.com/github/copilot-cli/blob/main/changelog.md)). |

**Precedent:** Task Master registers an `mcp` provider only when `session?.clientCapabilities?.sampling` is present ([mcp-provider.md](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/mcp-provider.md)). The pattern is cheap but would not help Claude Code or Codex users.

---

## 3. In-session delegation (grimoire hands the work back to the connected agent)

**Shape**

1. Grimoire turns pending work into a queued **knowledge chore**. Examples: "compile traces T1–T9 into wiki pages"; "propose one skill change from pattern P".
2. The connected agent fetches the chore through a grimoire MCP tool. The tool returns trace excerpts, the current wiki index and an output schema.
3. The agent does the reasoning in its own session.
4. The agent submits the result through another tool, for example `grimoire_chore_submit`.
5. **Grimoire validates the result and writes the plain files itself**: wiki pages, `logs.md`, and a gated `SKILL.md` proposal.

The LLM never needs write access to `.grimoire/`.

**Ways to surface a chore**

- **MCP server instructions.** These load at session start. Claude Code truncates "each tool description and each server's instructions at 2,048 characters" ([Claude MCP docs](https://code.claude.com/docs/en/mcp)).
- **MCP prompts.** Claude Code lists them as `/servername:promptname (MCP)`, and `/mcp__<server>__<prompt>` also works ([Claude MCP docs](https://code.claude.com/docs/en/mcp)).
- **Skills, as pointer files.**
  - Claude Code reads `.claude/skills/<name>/SKILL.md` from the cwd up to the repo root. `context: fork` runs the skill in a forked subagent. [added] With `context: fork`, `background` defaults to `true` (v2.1.218+). Set `background: false` if the invoking turn should wait for the chore result ([skills](https://code.claude.com/docs/en/skills)).
  - Codex reads `.agents/skills/<name>/SKILL.md` "in every directory from your current working directory up to the repository root", plus `$HOME/.agents/skills`. It is invoked with `$skill` or `/skills`, or implicitly by matching the `description`. Implicit use can be disabled with `allow_implicit_invocation: false` in `agents/openai.yaml` ([Codex skills](https://learn.chatgpt.com/docs/build-skills)).
- **Subagents** give context isolation and restricted tools.
  - Claude uses `.claude/agents/*.md` with `tools`, `model`, `permissionMode`, `skills` and `mcpServers` frontmatter ([sub-agents](https://code.claude.com/docs/en/sub-agents)).
  - Codex uses `.codex/agents/*.toml`, which requires `name`, `description` and `developer_instructions`. `model` and `sandbox_mode` are optional ([Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)).
- **Hooks as nudges.**
  - In Claude Code, a SessionStart hook's `additionalContext` or plain stdout is added to context, capped at 10,000 characters. Anything longer is written to a file with a 2,000-character preview ([hooks](https://code.claude.com/docs/en/hooks)).
  - Codex SessionStart accepts `hookSpecificOutput.additionalContext`. Hooks are on by default, but project hooks load only when the project `.codex/` layer is trusted, and trust is recorded against the hook's hash ([Codex hooks](https://learn.chatgpt.com/docs/hooks)).
  - Claude prompt and agent hooks return only `{ok: true/false, reason}` decisions, so they cannot produce artifacts ([hooks](https://code.claude.com/docs/en/hooks)).

**Turning it into scheduled runs without grimoire holding a credential**

- **Claude Code Routines** ([routines](https://code.claude.com/docs/en/routines)):
  - Research preview.
  - Run in Anthropic's cloud even when the machine is off.
  - Each repo is cloned on every run, from the default branch.
  - Changes are pushed to `claude/`-prefixed branches.
  - Minimum interval is one hour, with per-trigger hourly caps.
  - Draws on subscription usage.
  - Locally added MCP servers are not available. A committed `.mcp.json` is, for single-repo routines, so grimoire's server can come with the clone.
- **Claude Desktop local scheduled tasks** ([Desktop scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks)):
  - Fire only while the app is open and the computer is awake.
  - Catch up only the most recent missed run within 7 days.
  - Stall on permission prompts unless tools are pre-allowed.
  - The prompt lives at `~/.claude/scheduled-tasks/<name>/SKILL.md`.
- **`/loop` and `loop.md`:** session-scoped. Recurring tasks expire after 7 days, and a session can hold up to 50 tasks ([scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks)).
- **ChatGPT/Codex desktop-app scheduled tasks** ([Codex scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app)):
  - [corrected wording] "keep the machine powered on and the ChatGPT desktop app running."
  - They use `approval_policy = "never"` when policy allows, and the default sandbox settings.
  - In git repos they can run in the local project or on a new worktree.
  - "Codex CLI doesn't provide the Scheduled management interface."
- **Claude Code GitHub Action on a `schedule` trigger:**
  - Uses a `CLAUDE_CODE_OAUTH_TOKEN` repo secret from `claude setup-token` ([GitHub Actions](https://code.claude.com/docs/en/github-actions)).
  - Grimoire holds nothing, but a credential lives in the repo's CI settings. That is borderline under the "never holds a key" spirit.
  - API credits don't cover Action runs.

**Precedents**

- **beads.** The `bd admin compact` doc lists these modes:
  - "Analyze: Export candidates for agent review (no API key needed)"
  - "Apply: Accept agent-provided summary (no API key needed)"
  - "Auto: AI-powered compaction (requires ANTHROPIC_API_KEY or ai.api_key, legacy)"

  `--analyze`/`--apply` is labelled the "Agent-driven workflow (recommended)" ([beads admin docs](https://github.com/steveyegge/beads/blob/main/docs/cli-reference/admin.md)). It is the same move grimoire is making.
- **Task Master** offers three keyless routes:
  - a `claude-code` provider ("without requiring direct API keys")
  - a `codex-cli` provider (ChatGPT OAuth via `ai-sdk-provider-codex-cli`)
  - an MCP-sampling provider

  [added caveat] Its Claude route uses `ai-sdk-provider-claude-code`, which is built on the Claude Agent SDK with the CLI's OAuth. That is the pattern Anthropic's SDK note restricts, so the precedent shows existence, not permission ([Claude Code integration](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/claude-code-integration.md); [codex-cli](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/providers/codex-cli.md); [mcp-provider](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/mcp-provider.md)).
- **Claude Code Channels.** An MCP server can push `notifications/claude/channel` events into a running session. Not viable as a grimoire dependency ([channels reference](https://code.claude.com/docs/en/channels-reference); [MCP docs](https://code.claude.com/docs/en/mcp); [CLI reference](https://code.claude.com/docs/en/cli-reference)):
  - Channels are a research preview and allowlist-gated.
  - Custom channels need `--dangerously-load-development-channels`, which "With `-p`, Claude Code ignores".
  - If the session hasn't loaded the server as a channel, "Claude Code drops the events silently".
  - On the v2 runtime, a channel server that negotiates `2026-07-28` can't deliver channel messages.

**Pitfalls**

- **Not unattended.** The work happens only when an agent session runs and the agent (or user) picks up the chore. Without a scheduler, chores can pile up.
- **Context cost.** The work competes with the user's task. Use a skill with `context: fork` or a subagent ([skills](https://code.claude.com/docs/en/skills)).
- **Tool output limits.** Claude Code warns above 10,000 tokens and caps MCP output at 25,000 tokens by default (`MAX_MCP_OUTPUT_TOKENS`). Successful text results longer than 50,000 characters are saved to a file. [added] A tool can declare `anthropic/maxResultSizeChars` to raise its own text limit ([MCP docs](https://code.claude.com/docs/en/mcp)). Page large trace bundles, or hand back file paths.
- **Instructions inside tool results may not be trusted.** Claude routine fire text arrives wrapped in `<routine-fire-payload>`, labelled as untrusted data ([routines](https://code.claude.com/docs/en/routines)). I found no statement on how Claude or Codex treat imperatives inside MCP tool results (unverified). Design choice: tool results carry **data plus a schema**, and the **procedure** lives in a committed skill that the user or agent invokes.
- **Concurrency.** Claude and Codex might pick up the same chore. Use lease or claim records in `.grimoire/` and idempotent submits. Git merges are the only sync.
- **Quality varies by host model.** Grimoire's gate has to validate structure, provenance and the "one atomic change" rule whichever agent did the work.
- **Avoid forced continuation.** Two hooks can keep an agent going:
  - A Codex Stop hook with `decision: "block"` continues the turn with `reason` as a new prompt ([Codex hooks](https://learn.chatgpt.com/docs/hooks)).
  - A Claude Stop hook can also block ([hooks](https://code.claude.com/docs/en/hooks)).

  Using these to force chores risks runaway loops.

---

## 4. Other keyless mechanisms

- **Ollama (local models).**
  - It runs on Windows 10 22H2+ (Home or Pro). The installer does not need admin and installs in the home directory. It serves `http://localhost:11434`. Models take "tens to hundreds of GB" ([Ollama Windows](https://docs.ollama.com/windows)).
  - Native `/api/chat` accepts a JSON Schema in `format` ([structured outputs](https://docs.ollama.com/capabilities/structured-outputs)). Structured outputs are not supported on Ollama Cloud. The docs recommend also putting the schema in the prompt and setting temperature to 0.
  - OpenAI-compatible endpoints include `/v1/chat/completions` (`response_format`) and `/v1/responses` (non-stateful, v0.13.3+) ([OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)).
  - An Anthropic-compatible `/v1/messages` endpoint lets Claude Code run against a local model with `ANTHROPIC_BASE_URL=http://localhost:11434` and `ANTHROPIC_AUTH_TOKEN=ollama` ("required but ignored"). It does not support `tool_choice`, prompt caching or `count_tokens` ([Anthropic compatibility](https://docs.ollama.com/api/anthropic-compatibility)).
  - Codex can use it with `--oss --local-provider ollama` ([CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)).
  - Cost: no per-call fee, but hardware, disk and a quality drop. It runs unattended easily.
  - Node can call it with a plain `fetch`, no spawn needed. This path does not ride on an existing agent, so it should be an explicit opt-in. Ollama *cloud* models are not local and not covered here.
- **Other agent CLIs.** GitHub Copilot CLI's `copilot -p` runs a prompt non-interactively with `--allow-tool` (and `--allow-all-tools`, which appears only in an example). `-s` gives clean text output ([Copilot CLI programmatic](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically)). A JSON output flag is not documented on that page. It could share the runner adapter shape.
- **Not keyless:**
  - the Agent SDK in `--bare` mode
  - the Codex SDK with `apiKey`
  - Codex access tokens (Enterprise)
  - direct provider APIs

  These are the spec's official migration path away from sampling, and they contradict grimoire's constraint.

---

## 5. Windows notes for spawning from Node (developer machine: Windows 11 25H2, Node 24)

- **PATH lookup only finds `.com` and `.exe`.** libuv searches PATH by "*appending* (not replacing) .com first and then .exe", with the "exception that PATHEXT environment variable isn't used" ([libuv process.c](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c)). So `spawn("codex")` will not find an npm `codex.cmd`.
- **`.cmd` and `.bat` need a shell.** The CVE-2024-27980 fix makes `spawn` of `.bat`/`.cmd` without `shell` fail with `EINVAL` ([Node security release](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2)). Passing an `args` array with `shell` is DEP0190: a **runtime** deprecation in Node 24, documentation-only in 22.15 ([deprecations](https://nodejs.org/api/deprecations.html); [child_process docs](https://nodejs.org/api/child_process.html)).
- **Prefer:**
  - The native `claude.exe` (`%USERPROFILE%\.local\bin\claude.exe`).
  - For Codex, the platform binary `@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe`, resolved the way the SDK's `findCodexPath` does ([exec.ts](https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts)), or `process.execPath` with the path to `bin/codex.js`.
- **Pass prompts over stdin.** The Windows command line is capped at 32,767 characters ([CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)). `--json-schema` passes the schema inline, so keep schemas small, or test whether it accepts a file (unverified).
- **Background processes can have a different PATH.** In this research session's non-interactive shells (both Bash and PowerShell), `claude.exe` resolved but `node` and `codex` did not (observed again on 2026-10-11). Detect the binaries once, store absolute paths in a **gitignored machine-local** config (not in committed `.grimoire/` config), and re-validate before each run.
- **Unattended runs need a host process.** Either `grimoire start` stays running, or the user wires Windows Task Scheduler. Desktop and app schedulers need their apps open ([Desktop scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks); [Codex scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app)).

---

## 6. Comparison

| Mechanism | Unattended / scheduled? | Cost to user | LLM file/tool access | Main failure modes | Invoked from Node | Maturity (2026-10) |
|---|---|---|---|---|---|---|
| **In-session chore (MCP tools + skill + prompt)** | No by itself. Yes via Routines, Desktop or app scheduled tasks, or `/loop` | The host session's plan usage; no extra setup | Whatever the host session has. Grimoire gets results through its own tool and writes the files itself | Agent ignores or defers the chore; context bloat; 25k-token / 50k-char tool output cap; concurrent pickup; quality varies | Not invoked: grimoire serves MCP and waits for a submit | Stable building blocks (MCP tools, skills, subagents) |
| **`claude -p`** (user's own binary) | Yes, while grimoire or Task Scheduler is running | Subscription 5-hour and weekly limits, shared with interactive use. API bill if any higher-precedence credential is set | `--tools`, `--allowedTools`, `--permission-mode`, optionally `--restricted`. **No OS sandbox on native Windows** | Login expired or limits hit; **policy gray zone**; **`--bare` may become the `-p` default (no OAuth)**; recursion unless `--setting-sources user --strict-mcp-config`; flags need newer versions | `spawn(claude.exe, ["-p", ...])`, stdin prompt, JSON with `structured_output` | GA; frequent releases |
| **Claude Agent SDK** | Yes | Same as above | Same, via options | **Policy:** products built on it may not offer claude.ai login; bundles its own binary | `query({prompt, options})` | GA, but avoid for grimoire |
| **`codex exec`** | Yes, while a host process is running | ChatGPT plan local-message allowance and weekly limits; API rates with a key | Read-only sandbox by default, though config can override, so pass `--sandbox read-only`. Approvals never asked | Not a git repo; required MCP server fails; Windows sandbox setup (CLI defaults to `elevated` unless `prefer_mxc`); model retirement; plan limits; recursion through project or user MCP config | `spawn(codexExe, ["exec","--json","--sandbox","read-only","--output-schema",...])`, stdin prompt | GA CLI; app-server experimental |
| **Codex SDK** | Yes | Same as above | Same as above | Pins its own Codex binary (`codexPathOverride` can use the user's) | `new Codex().startThread().run(p, {outputSchema})` | Released, 0.x |
| **MCP sampling** | **No** (only inside a client request; human in the loop) | The client's model or subscription | Only the text the server sends (optional sampling-scoped tools) | Deprecated; **unsupported in Claude Code and Codex; not listed by Cursor**; user denies | `InputRequiredResult` with `sampling/createMessage` | Deprecated as of 2026-07-28 |
| **Claude Channels push** | Into a live interactive session only | Session usage | The session's own | Research preview; allowlist; ignored with `-p`; silent drops; broken on 2026-07-28 servers | MCP notification | Research preview |
| **Ollama local** | Yes | Hardware and electricity; no metering | Only what grimoire sends (plain completion) | Not installed or running; model not pulled; weak output on complex synthesis | `fetch("http://localhost:11434/api/chat")` with a `format` schema | Stable |
| **Claude Routines / GitHub Action** | Yes, in the cloud, machine off | Subscription usage; hourly run caps | A fresh repo clone plus connectors and committed `.mcp.json`; pushes to `claude/` branches | GitHub auth lapses; research preview (Routines); 1h minimum; results arrive by git branch | Not invoked: the user configures it; grimoire only needs to be runnable inside the clone | Routines: research preview. Action: GA |

---

## 7. Steal / avoid

**Steal**

- **beads' analyze/apply split** ([beads](https://github.com/steveyegge/beads/blob/main/docs/cli-reference/admin.md)): grimoire exports a chore and accepts the agent's result. No key is needed, and grimoire stays the only writer.
- **Read-only LLM, structured output, host writes.** Use `--json-schema` / `structured_output` ([headless](https://code.claude.com/docs/en/headless)), and `--output-schema` with an explicit `--sandbox read-only` ([Codex non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode)). This sidesteps the Windows sandbox gap and matches the "gated, wiki never rolled back" design.
- **Pluggable providers** with capability detection, as in Task Master.
- **Codex SDK's process handling** ([exec.ts](https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts)): absolute platform-binary resolution, prompt on stdin, JSONL line parsing, and stderr captured for errors.
- **Isolation for spawned Claude runs:**
  - `--setting-sources user`, `--strict-mcp-config` and `--no-session-persistence`
  - `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`
  - optionally `--restricted` and `disableAllHooks`

  Sources: [permissions](https://code.claude.com/docs/en/permissions); [CLI reference](https://code.claude.com/docs/en/cli-reference); [SDK settingSources](https://code.claude.com/docs/en/agent-sdk/claude-code-features).
- **Preflight with `claude auth status`** (`authMethod` must be `claude.ai`) before any spawned Claude run.
- **Skills with `context: fork` and custom subagents** so chores don't pollute the user's session ([skills](https://code.claude.com/docs/en/skills); [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)).

**Avoid**

- **Bundling `@anthropic-ai/claude-agent-sdk` with subscription login.** It goes against the published policy ([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)).
- **`--bare`, or an inherited `CLAUDE_CODE_SIMPLE=1`.** Both need an API key ([headless](https://code.claude.com/docs/en/headless)).
- **`--dangerously-skip-permissions`, `--yolo`, `danger-full-access`.**
- **`shell: true` with interpolated arguments on Windows** ([Node CVE-2024-27980](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2); DEP0190).
- **Building v1 on MCP sampling or MCP roots** ([deprecated](https://modelcontextprotocol.io/specification/2026-07-28/deprecated)).
- **Channels** ([channels reference](https://code.claude.com/docs/en/channels-reference)) and the **Codex app-server** ([CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli)) as dependencies.
- **Stop hooks that force chore work.**
- **Pinning model names** ([Codex pricing](https://learn.chatgpt.com/docs/pricing)).
- **Reading `.credentials.json` or `auth.json`.** The legal page also bars developers from collecting, storing or intermediating Claude.ai credentials.
- **Silently running on the user's plan.** Every spawned run should be opt-in, visible in the dashboard and in `logs.md`, with turn and budget caps.

---

## 8. Minimal set for v1 (recommendation)

1. **Knowledge chores as data, done in-session.** This is the default and works with every client.
   - The chore queue lives in `.grimoire/`.
   - MCP tools get the next chore, claim it and submit the result. Submit validates against the schema and the gate, then grimoire writes the wiki pages and `SKILL.md` proposals.
   - Consider `anthropic/maxResultSizeChars` on the fetch tool.
   - One MCP prompt, plus skill pointer files, both recorded in the manifest:
     - `.claude/skills/grimoire-knowledge/SKILL.md` with `context: fork`. Decide whether you want `background: false`.
     - `.agents/skills/grimoire-knowledge/SKILL.md`.
   - Optionally, a lightweight SessionStart nudge ("3 knowledge chores pending").
2. **Opt-in `runner` adapter for unattended work**, configured per machine and gitignored. Both runners use the same chore and gate path as (1).
   - **`claude-cli`** uses the user's own `claude.exe` with `-p --output-format json --json-schema --setting-sources user --strict-mcp-config --tools Read,Grep,Glob --permission-mode dontAsk --permission-prompts none --max-turns N --no-session-persistence`, with the procedure passed via `--append-system-prompt-file`.
     - Gate each run on a `claude auth status` preflight.
     - Watch for the `--bare` default change in release notes.
     - Strip `CLAUDE_CODE_SIMPLE` from the child's environment.
   - **`codex-cli`** uses `codex exec --json --sandbox read-only --output-schema --ephemeral`. Verify recursion behavior first.
   - Detect and warn when `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, cloud-provider variables, `CODEX_API_KEY` or `OPENAI_API_KEY` would change billing.
3. **Documented scheduler recipes, not grimoire daemons.** Each recipe points at the grimoire skill:
   - Claude Routines (cloud, git-native, `claude/` branches)
   - Claude Desktop scheduled tasks
   - ChatGPT/Codex desktop-app scheduled tasks
4. **Later, optional:** an `ollama` runner using `/api/chat` with a `format` schema.
5. **Skip MCP sampling.** At most, opportunistically detect `sampling` in client capabilities; not in v1.

## Open questions / unverified

- Whether Anthropic considers a third-party local tool spawning the user's own `claude -p` under subscription login acceptable. Anthropic's docs frame `claude -p` as the Agent SDK's CLI form, so this is grayer than the SDK-versus-CLI split suggests. Ask Anthropic before shipping the `claude-cli` runner as anything beyond opt-in.
- When `--bare` becomes the `-p` default, and whether an opt-out flag will exist.
- Whether `--json-schema` works with `--tools ""`, whether `--restricted` keeps subscription OAuth, and whether `-p` with stdin only uses stdin as the prompt. Test all three on 2.1.296.
- How Claude and Codex models treat imperative text inside MCP tool results. Likely with suspicion, but undocumented.
- Whether `codex exec` loads project `.codex/config.toml` MCP servers and hooks in a trusted repo (likely, since project layers load when trusted), and whether they can be suppressed. Also whether `--ignore-user-config` affects auth (likely not: credentials are in `auth.json` or the keyring).
- Whether `codex exec --sandbox read-only` on native Windows needs `elevated` or MXC setup.
- The exact strictness rules for `--output-schema` (likely OpenAI strict JSON schema).
- Precedence between `CODEX_API_KEY` / `OPENAI_API_KEY` and the saved ChatGPT login.

## Sources

- Claude Code docs: [headless / programmatic](https://code.claude.com/docs/en/headless) · [CLI reference](https://code.claude.com/docs/en/cli-reference) · [authentication](https://code.claude.com/docs/en/authentication) · [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) · [setup](https://code.claude.com/docs/en/setup) · [sandboxing](https://code.claude.com/docs/en/sandboxing) · [permissions](https://code.claude.com/docs/en/permissions) · [env vars](https://code.claude.com/docs/en/env-vars) · [MCP](https://code.claude.com/docs/en/mcp) · [hooks](https://code.claude.com/docs/en/hooks) · [skills](https://code.claude.com/docs/en/skills) · [sub-agents](https://code.claude.com/docs/en/sub-agents) · [channels reference](https://code.claude.com/docs/en/channels-reference) · [routines](https://code.claude.com/docs/en/routines) · [Desktop scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks) · [scheduled tasks /loop](https://code.claude.com/docs/en/scheduled-tasks) · [GitHub Actions](https://code.claude.com/docs/en/github-actions) · [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) · [Agent SDK TypeScript](https://code.claude.com/docs/en/agent-sdk/typescript) · [Agent SDK Claude Code features / settingSources](https://code.claude.com/docs/en/agent-sdk/claude-code-features) · [structured outputs](https://code.claude.com/docs/en/agent-sdk/structured-outputs)
- Claude Code repo: [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) · [issue #1785 (MCP sampling)](https://github.com/anthropics/claude-code/issues/1785)
- Anthropic support: [Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) · [monthly API credits](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans) · [Claude Code with Pro/Max](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan)
- Codex docs: [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode) · [CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli) · [auth](https://learn.chatgpt.com/docs/auth) · [config basics](https://learn.chatgpt.com/docs/config-file/config-basic.md) · [pricing](https://learn.chatgpt.com/docs/pricing) · [Windows sandbox](https://learn.chatgpt.com/docs/windows/windows-sandbox) · [hooks](https://learn.chatgpt.com/docs/hooks) · [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) · [skills](https://learn.chatgpt.com/docs/build-skills) · [scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app) · [MCP server removal](https://learn.chatgpt.com/docs/mcp-server)
- Codex source (openai/codex, main, fetched 2026-10-11): [SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md) · [SDK exec.ts](https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts) · [exec lib.rs](https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs) · [rmcp_client.rs](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/rmcp_client.rs) · [logging_client_handler.rs](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/logging_client_handler.rs)
- npm registry: [@anthropic-ai/claude-code](https://registry.npmjs.org/@anthropic-ai/claude-code/latest) · [@anthropic-ai/claude-agent-sdk](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest) · [@openai/codex](https://registry.npmjs.org/@openai/codex/latest) · [@openai/codex-sdk](https://registry.npmjs.org/@openai/codex-sdk/latest)
- MCP: [Sampling (2026-07-28)](https://modelcontextprotocol.io/specification/latest/client/sampling) · [deprecated features registry](https://modelcontextprotocol.io/specification/2026-07-28/deprecated) · [MRTR pattern](https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr) · [SEP-2577](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2577)
- Other clients: [VS Code MCP developer guide](https://code.visualstudio.com/api/extension-guides/ai/mcp) · [Cursor MCP docs](https://cursor.com/docs/context/mcp) · [Copilot CLI v1.0.13 release](https://github.com/github/copilot-cli/releases/tag/v1.0.13) · [Copilot CLI changelog](https://github.com/github/copilot-cli/blob/main/changelog.md) · [Copilot CLI programmatic use](https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/run-cli-programmatically)
- Ollama: [Windows](https://docs.ollama.com/windows) · [structured outputs](https://docs.ollama.com/capabilities/structured-outputs) · [OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility) · [Anthropic compatibility](https://docs.ollama.com/api/anthropic-compatibility)
- Node and Windows: [Node child_process](https://nodejs.org/api/child_process.html) · [Node deprecations (DEP0190)](https://nodejs.org/api/deprecations.html) · [Node April 2024 security release (CVE-2024-27980)](https://nodejs.org/en/blog/vulnerability/april-2024-security-releases-2) · [libuv win/process.c](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c) · [CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw)
- Precedents: [beads `bd admin compact`](https://github.com/steveyegge/beads/blob/main/docs/cli-reference/admin.md) · [Task Master Claude Code integration](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/claude-code-integration.md) · [Task Master codex-cli provider](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/providers/codex-cli.md) · [Task Master MCP (sampling) provider](https://github.com/eyaltoledano/claude-task-master/blob/main/docs/mcp-provider.md)

## Verification notes

**Checked and confirmed against primary sources (2026-10-11)**

- **Versions:** Claude Code 2.1.296 (npm, CHANGELOG head, and the local `claude.exe --version`). The Agent SDK is at 0.3.296. `@openai/codex` and `@openai/codex-sdk` are both 0.162.1, and the SDK pins `@openai/codex` 0.162.1. Package bins: `bin/claude.exe` and `bin/codex.js`.
- **Headless page:**
  - exit codes, and failures printed on stdout
  - `--output-format` values, `structured_output`, and `total_cost_usd` as a client-side estimate
  - the v2.1.205 invalid-schema error
  - the 10 MB stdin cap
  - `dontAsk` semantics, and `--permission-prompts none` at v2.1.259+
  - the starting mode that "can be `auto`"
  - `-p` running project hooks and `.mcp.json` servers without a trust dialog
  - `--bare` never reading OAuth
- **CLI reference:** `--tools`, `--disallowedTools "mcp__*"`, `--strict-mcp-config`, `--max-turns`, `--max-budget-usd`, `--no-session-persistence`, the system-prompt flags, `--setting-sources`, and `--dangerously-load-development-channels` being ignored with `-p`.
- **Permissions page:** `Write(path)` rules are never consulted, and it has a section on what runs before trust.
- **Authentication page:** the precedence list (OAuth is item 7), "always used when present" under `-p`, and the Windows credential path.
- **Sandboxing page:** the sandbox is not available on native Windows.
- **Legal and Agent SDK overview quotes.**
- **Support articles:** shared 5-hour and weekly limits; API credits apply to `-p` only with an API key; Pro is not eligible.
- **MCP:** Sampling is deprecated in `2026-07-28` by SEP-2577 (merged 2026-05-15, citing "low client adoption"), with earliest removal on or after 2027-07-28. The MRTR "no longer supported" wording, and the human-in-the-loop SHOULD.
- **Claude Code has no sampling:** issue #1785 is open, and "sampling" is absent from the CHANGELOG and MCP docs.
- **Codex has no sampling:** the source declares only elicitation, and there is no `create_message` handler.
- **Other clients:** Cursor doesn't list sampling. VS Code supports it with an authorization prompt. Copilot CLI has had it since v1.0.13 (2026-03-30), and since 1.0.64 (2026-06-23) autopilot auto-handles sampling prompts.
- **Codex exec:** read-only default, stdin prompt, JSONL events, `--output-schema`, `-o`, `--ephemeral`, `--cd`, the git-repo check, a required MCP server failing exits, `--full-auto` deprecated, and approval policy `Never` in source.
- **Codex auth, pricing and model retirement:** Pro has no 5-hour limit; GPT-5.5 retires 2026-10-14.
- **Codex Windows sandbox:** MXC, elevated and unelevated modes, and error 1385. The `mcp-server` command is removed and `app-server` is experimental.
- **Codex skills, subagents and hooks:** paths and fields, trust by hash, and Stop `block` continuation.
- **Claude skills, subagents and hooks:** `context: fork`, the frontmatter fields, the 10,000-character hook cap, and prompt/agent hooks returning `{ok}` only.
- **Claude MCP limits:** 2,048-character instruction truncation, 10k/25k token output limits, and MCP prompt naming.
- **Schedulers:** Routines (research preview, clone per run, `claude/` branches, 1h minimum, subscription usage, fire text labelled untrusted). Desktop tasks need the app open and the machine awake, with one catch-up run. `/loop` expires after 7 days. Codex-app scheduled tasks run with `approval_policy = "never"`.
- **Channels:** research preview, silent drops, and no delivery on 2026-07-28 servers.
- **beads** analyze/apply/auto modes, with auto marked legacy. **Task Master's** sampling-capability check.
- **Ollama:** Windows requirements, the `format` schema, OpenAI-compatible endpoints, and the Anthropic-compatible endpoint's limits.
- **Node and libuv:** the libuv PATH rule (`.com`/`.exe`, no PATHEXT), `.cmd` needing a shell, and DEP0190.
- **This machine:** `claude.exe` is at `%USERPROFILE%\.local\bin`. `node` and `codex` were not resolvable from non-interactive shells. Windows 25H2 build 26200.9457.

**Corrected**

- The SDK-versus-CLI policy distinction is overstated.
  - Anthropic describes `claude -p` as the Agent SDK via the CLI.
  - The "run the CLI as a subprocess" quote is about languages other than Python/TS, not a policy endorsement.
  - Added the legal page's ban on collecting or intermediating credentials.
- The "paused" item in the 2026-06-15 banner is "changes to Claude Agent SDK usage", not "a separate credit". The June SDK credit "isn't available", per the credits article.
- `--strict-mcp-config` is not among the permissions page's documented mitigations. That list is `--setting-sources user`, `--bare`, `disableAllHooks` and `disabledMcpjsonServers`. Strict MCP config is still needed to block claude.ai connectors.
- The billing trap is broader than `ANTHROPIC_API_KEY`: six credential sources outrank `/login`.
- Codex's `--sandbox` default can come from user configuration, so pass it explicitly.
- On Windows, the standalone Codex CLI prefers `elevated` unless `prefer_mxc = true`. MXC needs specific Windows 11 builds.
- The Codex SDK can use the user's binary through `codexPathOverride`.
- The Codex scheduled-task quote is "keep the machine powered on and the ChatGPT desktop app running".
- The latest visible activity on issue #1785 is 2026-09-25, not 2026-08-17.
- Codex sends `2025-06-18` at initialize but also has a 2026-07-28 discovery mode.
- MCP output: text over 50,000 characters is saved to a file, and tools can raise their own limit.

**Added (decision-relevant)**

- `--bare` "will become the default for `-p` in a future release", and `CLAUDE_CODE_SIMPLE` is equivalent to it.
- The `claude auth status` preflight (`authMethod`, exit code).
- The `--restricted` flag.
- Project skills, CLAUDE.md and subagents don't load under `--setting-sources user`, so the runner must carry its procedure in the system prompt or stdin. User hooks, auto memory and claude.ai connectors still load.
- Structured-output failure subtypes.
- Roots is deprecated too; use `CLAUDE_PROJECT_DIR` or config to find the repo.
- `context: fork` skills run in the background by default.
- Codex project-config trust implies a recursion risk for `codex exec`.
- Task Master's Claude route is built on the Agent SDK with OAuth.

**Still unverified:** see "Open questions / unverified" above. Notably:

- the policy acceptability of spawning `claude -p`
- `--json-schema` with `--tools ""`
- whether `--restricted` keeps OAuth
- recursion and MCP loading in `codex exec`
- the Windows read-only sandbox for `codex exec`
- `--output-schema` strictness
- Codex credential precedence

No `claude -p` or `codex exec` run was executed, to avoid spending the user's plan usage.
