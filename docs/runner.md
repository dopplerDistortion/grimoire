# The runner and scheduler recipes

Grimoire's knowledge chores (the Wiki Maintainer and the Skill Proposer) become due as agents work. Normally an agent already in a session picks a due chore up with the `grimoire-chores` skill, nudged by one SessionStart line. This page covers the two other ways chores get done: the **runner**, and **schedulers**.

## The runner

The runner is a per-machine opt-in. It lets grimoire start your own `claude -p` or `codex exec` to do due chores unattended, on your own login.

### Enabling it

At your own terminal (not from an agent):

```sh
npm run -s grimoire -- runner enable claude    # or: runner enable codex
```

What `runner enable` does:

1. It prints the warnings:
   - runs draw on your plan's shared 5-hour and weekly limits;
   - unattended `claude -p` use on a subscription is a policy gray zone, so check Anthropic's current terms for your plan;
   - for Codex: your Codex config stays in use, and its MCP servers, hooks, `notify` program and developer instructions are switched off for each run, one setting at a time. That list was verified against Codex 0.162.1.
2. It finds the client's platform binary on PATH: `claude.exe` or `codex.exe` on Windows (an npm `codex.cmd` shim is followed to its native binary), or the file itself elsewhere. `--binary <path>` names it instead.
3. It runs the preflight (the billing guard, below).
4. It asks you to type the client's name to confirm.
5. It stores the machine-local config: the kind, the absolute binary path, `allow_api_billing`, and the model (`--model`).

`npm run -s grimoire -- runner disable` turns it off.

### The billing guard

Before each run, grimoire asks the client which login it would bill. It runs with the child's exact environment, and grimoire never reads a credential file.

- **Claude:** `claude auth status --json` must report `authMethod: claude.ai`.
  - `api_key`, `api_key_helper`, `oauth_token` and `third_party` (Bedrock, Vertex, Foundry) are accepted only with `--allow-api-billing`. `grimoire status` then shows them.
  - `none` is always refused.
  - Without `--allow-api-billing`, a run is also refused while `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` or `CLAUDE_CODE_USE_BEDROCK` / `_VERTEX` / `_FOUNDRY` is set.
- **Codex:** `codex login status` must say "Logged in using ChatGPT". An API-key login is accepted only with `--allow-api-billing`. `CODEX_API_KEY` and `OPENAI_API_KEY` are refused the same way. Grimoire also lists your MCP servers (`codex mcp list --json`, names only) to switch each one off for the run. If that list fails, the run is refused.

At an interactive `runner enable`, a login that bills outside the plan asks whether to allow it.

### What a run is

- Grimoire starts the chore itself and gathers everything the chore is served into one bundle.
- The client runs from a fresh, empty temp directory outside any git repository, deleted afterwards. The bundle goes on stdin.
- The client gets no tools, no MCP servers and no hooks. It is killed after 15 minutes.
- Its JSON answer goes through the same submit path as an in-session chore's. An answer the checks refuse gets exactly one fix-up respawn, told the reason codes.
- The run is recorded with origin `runner`, and its actor is you plus `runner:claude` or `runner:codex`.
- Its stdout and stderr are kept in a machine-local log. After a secret-scan failure the log drops that run's output.

### Caps

- At most 6 runs in any 24 hours. One spawn plus its fix-up respawn counts as one run.
- After 2 failed runs in a row, the runner pauses for 6 hours.
- The counters are shared by every worktree and every grimoire version on the machine.
- `grimoire status` shows the runs used, the pause, the auth method and the last run.

### Triggers

- `npm run -s grimoire -- chore run --due` runs each due chore in turn: a compile, then a proposal if one became due. It is meant for OS schedulers. Nothing due is not an error: it exits 0 and starts nothing, not even the billing guard. It needs no terminal, but it refuses agent shells.
- `npm run -s grimoire -- chore run wiki-maintainer` (or `skill-proposer`) runs that chore now, with the thresholds waived. Without a runner, it tells you to ask an agent to run the `grimoire-chores` skill.
- `grimoire start` will also trigger the runner while one is configured. That comes with the dashboard's Settings screen.

## Scheduler recipes

### Local (recommended)

Local schedulers run on your machine, with your clone and your login. They may run the Skill Proposer.

- **An OS scheduler with the runner.** Have Windows Task Scheduler, cron or launchd run this from the repository root, for example every hour:

  ```sh
  node .grimoire/run.cjs chore run --due
  ```

  The run's origin is `runner`, and the caps above apply.
- **Claude Desktop scheduled tasks.** Create a scheduled task on the repository whose prompt is:

  > Run the grimoire-chores skill now, then report its summary.

  This runs as an ordinary session (origin `session`), through the `grimoire-chores` subagent. Don't make the task run `chore run`: its shell carries agent markers, and `chore run` refuses them.
- **Codex app automations.** Create an automation on the repository with the same prompt. It also runs as a session.

### Cloud fresh-clone: Claude Code on the web and Routines

A cloud session starts from a fresh clone. These runs are **compile-only**: origin `scheduled`, at most daily. The Skill Proposer never runs from the cloud.

1. **The join goes in the environment's setup script, never in the routine prompt.** The routine's shell and hooks carry agent markers, and the join is human-only. Make the setup script idempotent, since it runs once and then sessions start from a cached snapshot:

   ```sh
   # Setup script of the cloud environment (runs before Claude Code starts).
   cd "$REPO_DIR"   # the repository checkout
   npx -y @goksening/grimoire@<the pinned version> init --yes
   ```

   Then check it once by hand: open a session in the environment and run `node .grimoire/run.cjs status`. It must show the clone joined. If the snapshot dropped the join, edit the setup script (any change forces a rebuild), then check again.
2. **Declare the origin.** Set `GRIMOIRE_CHORE_ORIGIN=scheduled` in the environment's variables. It only restricts: the run is refused the Skill Proposer.
3. **The routine** runs at most daily, with this prompt:

   > Run the grimoire-chores skill now. Then run `node .grimoire/run.cjs sync` and report its result. If the push was rejected, say so loudly, first.

   The chore works from the fetched tracker, and the run ends with `grimoire sync`.

Why the join is in the setup script (spike D, R6, which couldn't be verified here): a setup script runs once, before Claude Code starts, so it plausibly carries no agent markers. Its result is cached in the environment's snapshot, which is why the setup script must be idempotent and the first session checked by hand. A SessionStart hook does run in every session, but it carries agent markers, so it can't run the human-only join.

### Codex cloud

There is no recipe for Codex cloud.
