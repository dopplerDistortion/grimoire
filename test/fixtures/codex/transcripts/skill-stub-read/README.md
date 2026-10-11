# Codex rollout: skills written mid-session, then a stub read and a copy read (Spike F, GOK-131)

One rollout (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl`,
file name kept) of one `codex app-server` thread with three turns. Findings:
`docs/research/spikes/codex-skills-role-exec.md` (B2, P2). Encoded in
`test/spikes/codex-skills-role-exec.test.ts`.

What happened, in order:

1. The repo's committed `.codex/config.toml` has one SessionStart hook
   (`node "<repo>/.codex/hook-write.cjs"`, run with
   `thread/start {config: {bypass_hook_trust: true}}`). It wrote the stub
   `.agents/skills/grimoire-hook-skill/SKILL.md` and the copy
   `.grimoire/skills/hook-skill/SKILL.md`, each folder with a `.gitignore` of
   `*`. The hook ran after Codex built turn 1's skills listing (its own log
   said so; this rollout has no hook line, but the `../skill-roots/` rollouts
   record the hook's note after the listing).
2. **Turn 1:** a shell command wrote the stub and copy for `tidewater-ledger` the
   same way. Turn 1's listing (the first `<skills_instructions>` developer
   message) has neither stub.
3. **Turn 2** ("Please reconcile the tidewater ledger."): Codex put a new full
   `<skills_instructions>` message at the start of the turn, listing both stubs
   under the root `r1` = `<repo>/.agents/skills`, and wrote a `world_state`
   line with `full: false` and `host_skills`. The scripted model then read the
   stub (`Get-Content .agents/skills/grimoire-tidewater-ledger/SKILL.md`), read
   the copy (`Get-Content .grimoire/skills/tidewater-ledger/SKILL.md`), wrote
   `ledger/tidewater.md`, and rewrote the stub's description in place (adding
   "(v2)").
4. **Turn 3:** no new listing; the "(v2)" description never reached the model.
   The repo had no `.agents/` folder when the thread started, so Codex never
   watched the root the hook created (see `../skill-roots/` and the findings).

Each shell read appears as an `event_msg` `item_completed`
`CommandExecution` whose `parsed_cmd` is `[{type: "read", cmd, name, path}]`,
with `path` as the command wrote it (relative, forward slashes here).

**Captured under a scripted model**: the "stub match" is the stand-in following
a `PLAN:` in the prompt, not model judgement. The stub body, the listing, the
`parsed_cmd` read actions and every other byte are the real Codex.

## Provenance

- **Client:** Codex CLI 0.162.1 (`codex.exe app-server`, driven over stdio by
  `test/spikes/codex-skills-role-exec/kit.mjs`), not logged in. Throwaway
  `CODEX_HOME` whose `config.toml` declared the stand-in provider
  (`scripted-responses.mjs`, `wire_api = "responses"`, model `gpt-5.5`) and
  trusted the repo. Thread: `approvalPolicy: never`, `sandbox:
  danger-full-access`, default (paginated) history.
- **OS:** Windows 11 Pro 10.0.26200, Node 24.21.0, PowerShell 5.1 as Codex's
  shell. Captured 2026-10-11.
- **Script:** `test/spikes/codex-skills-role-exec/b2-skills.mjs`, variant
  `new-root` (the default).

## Sanitizing

`test/spikes/codex-skills-role-exec/sanitize.mjs`: the Windows user name became
`USER` and the machine's IANA time zone became `Etc/UTC`, everywhere they
occurred. The package name `@goksening/grimoire` in the stub body is kept.
Nothing else changed.
