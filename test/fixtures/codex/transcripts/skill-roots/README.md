# Codex rollouts: when skill changes reach a running session (Spike F, GOK-131)

Three rollouts (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl`,
file names kept), one per subfolder. Each is one `codex app-server` thread.
Findings: `docs/research/spikes/codex-skills-role-exec.md` (B2). Encoded in
`test/spikes/codex-skills-role-exec.test.ts`. They complement
`../skill-stub-read/`, which is the `new-root` variant.

Common to all three:

- The repo's committed `.codex/config.toml` has one SessionStart hook,
  run with `thread/start {config: {bypass_hook_trust: true}}`. It writes the stub
  `.agents/skills/grimoire-hook-skill/SKILL.md` and its copy
  `.grimoire/skills/hook-skill/SKILL.md`, each folder with a `.gitignore` of `*`.
- **Turn 1** runs a shell command that writes the same pair for
  `tidewater-ledger`.
- Each new listing is a full `<skills_instructions>` developer message at the
  start of a turn, plus a `world_state` line.

| Folder | Start state | Turns | What it shows |
| -- | -- | -- | -- |
| `existing-root/` | `.agents/skills/grimoire-chores/SKILL.md` committed, so the root exists when the thread starts. The hook also prints `GRIM-B2-HOOK-WROTE <ISO time>`, which Codex records as a developer message. | Turn 2 rewrites the tidewater description in place ("(v2)"). Turn 3 writes a new pair, `late-folder`. Turn 4 only answers. Turn 5 starts 11 s after turn 4 and only answers. Turns 1 to 4 run back to back. | Turn 1's listing (only `grimoire-chores`) comes before the hook's note. Turn 2 lists `hook-skill` and `tidewater-ledger`. Turns 3 and 4 get no new listing: those changes came within 10 s of the previous watcher event. Turn 5 lists "(v2)" and `late-folder`: they were delayed, not dropped. |
| `existing-root-wait11000/` | the same | The same turns, with every turn after the first starting 11 s after the previous one ends | Every change is listed in the next turn: `tidewater-ledger` in turn 2, "(v2)" in turn 3, `late-folder` in turn 4. Turn 5 gets no new listing. |
| `new-root-late/` | no `.agents/` folder; the hook creates it | Turn 2 reads the stub and the copy, writes `ledger/tidewater.md` and rewrites the stub's description ("(v2)"). After 11 s, turn 3 writes `late-folder`. After another 11 s, turn 4 only answers. | Turn 2 lists both stubs under the new root. Neither "(v2)" nor `late-folder` is ever listed: a root created mid-session is not watched. |

**Captured under a scripted model**: the shell commands and answers come from
the stand-in following a `PLAN:` in each prompt. The listings, their timing,
the `world_state` lines and every other byte are the real Codex.

## Provenance

- **Client:** Codex CLI 0.162.1 (`codex.exe app-server`, driven over stdio by
  `test/spikes/codex-skills-role-exec/kit.mjs`), not logged in. Each run had a
  throwaway `CODEX_HOME` whose `config.toml` declared the stand-in provider
  (`scripted-responses.mjs`, `wire_api = "responses"`, model `gpt-5.5`) and
  trusted the repo. Thread: `approvalPolicy: never`, `sandbox:
  danger-full-access`, default (paginated) history.
- **OS:** Windows 11 Pro 10.0.26200, Node 24.21.0, PowerShell 5.1 as Codex's
  shell. Captured 2026-10-11.
- **Script:** `test/spikes/codex-skills-role-exec/b2-skills.mjs <scratch>
  <variant>`, with the variant named by the folder.

## Sanitizing

`test/spikes/codex-skills-role-exec/sanitize.mjs`: the Windows user name became
`USER` and the machine's IANA time zone became `Etc/UTC`, everywhere they
occurred. The package name `@goksening/grimoire` in the stub bodies is kept.
Nothing else changed.
