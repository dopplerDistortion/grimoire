# grimoire

An issue tracker that agents talk to natively. It is installed into a git repo, runs entirely on your machine, and uses git as its only sync layer. As agents work issues, its knowledge layer compiles what they learned into a wiki and a set of evolved skills that later sessions follow.

```sh
npx @goksening/grimoire init
```

- [What grimoire is](#what-grimoire-is)
- [Install, join, upgrade, uninstall, leave](#install)
- [Trusting grimoire in your clients](#trusting-grimoire-in-your-clients)
- [What capture commits: the excerpt disclosure](#what-capture-commits-the-excerpt-disclosure)
- [The dashboard](#the-dashboard)
- [The runner and schedulers](#the-runner-and-schedulers)
- [Troubleshooting](#troubleshooting)
- [Codex support, and how it was verified](#codex-support-and-how-it-was-verified)
- [Findings that changed behaviour](#findings-that-changed-behaviour)
- [For maintainers](#for-maintainers)

## What grimoire is

- **Issues live in your repo**, on a branch of their own, `grimoire/tracker`. Nothing runs in the cloud and there is no account. Teammates and other machines sync with ordinary `git fetch` and `git push`, which grimoire runs in the background.
- **Agents use it natively.** Claude Code and Codex reach grimoire as a local MCP server (`create`, `list`, `show`, `claim`, `close` and the rest), set up for them by `init`. Each issue an agent claims opens an attempt, and closing it records the outcome and a debrief.
- **It learns.** An attempt's trace (facts about the session, and redacted transcript excerpts if you allow them) feeds two knowledge chores: the Wiki Maintainer compiles a wiki, and the Skill Proposer proposes evolved skills. A person accepts or rejects every skill in the dashboard before any agent sees it.
- **People keep the final word.** Some operations are human-only (assigning, reopening, deleting, accepting skills, changing settings). An agent's shell is refused them.
- **It needs no service.** One npm package with no runtime dependencies; a copy of the pinned version lives in your clone's git directory, so every client runs exactly the version the repo pins.

Requirements: Node 22 or later (Codex's compressed `.jsonl.zst` transcripts need Node 22.15 or later; older Node reads them as `unreadable`), and git on the PATH. Windows, macOS and Linux.

## Install

`npx @goksening/grimoire init` in the repo, as yourself at a terminal (never from an agent's shell: it is human-only). It runs a read-only preflight, shows you the plan, the grants it adds to your clients' settings, the excerpt disclosure (below) and the next steps, and asks once. Then it:

- creates the tracker branch, or adopts the one the remote already has, and pushes it;
- installs this version into `<git-common-dir>/grimoire/` with its launcher, and records that this clone joined;
- writes the pointer files your clients read: `.mcp.json`, `.claude/settings.json`, `.codex/config.toml`, `AGENTS.md`, the chore skill and agent files, and `.grimoire/` (the pin in `config.yml`, the shell shim `run.cjs`, and `manifest.yml`, the list of everything it wrote).

Commit the files it lists. `--yes` takes the safe defaults without asking (excerpt mode `facts` for a new tracker, the issue-tracker doc adapter declined, and permission entries you changed never restored); `--clients claude-code` or `--clients codex` configures only one client; `--json` alone prints the plan and writes nothing.

In this README, `grimoire <verb>` means `node .grimoire/run.cjs <verb>` from anywhere in the repo, or `npm run -s grimoire -- <verb>` when the repo has a `package.json` (`init` adds the script). Run `grimoire <verb> --help` for any verb's input and flags.

**Join** on another machine, or in a fresh clone: run the same command at the version the repo pins. Any grimoire entry that finds the clone not joined prints the exact command, for example `npx @goksening/grimoire@1.0.0 init`. A join writes no checkout files; it adds the version copy and the join record, and shows the disclosure again. When the repo has grimoire at the pinned version as a devDependency, `init --from-node-modules` takes the version copy from its `node_modules` instead, and refuses when that package is missing or at another version.

**Upgrade** one checkout with `npx @goksening/grimoire@<new> init --upgrade`. It writes only that worktree's files and never commits: the report lists exactly the paths to commit, with the `git add … && git commit` command. Re-running it resumes an interrupted upgrade; the same command moves down to an older version, and refuses when that version can't read the current data. Other branches take the upgrade when they merge it; other machines follow by joining. Running servers are never killed: they keep working on the old pin and tell you to restart. A revert of the upgrade commit undoes it.

**Uninstall** with `grimoire uninstall` (human-only, typed confirmation, no `--yes`). It removes everything the manifest says grimoire wrote into the checkout, reporting what you edited and keeping files it doesn't know, then `.grimoire/`, and prints a commit and PR text. It never deletes the remote tracker branch: that stays as an archive, and it prints the commands to delete it or keep it under a tag. When no other worktree is still installed it also leaves the clone.

**Leave** with `npx @goksening/grimoire leave` (or `grimoire leave`; human-only, no `--yes`). It removes grimoire from this clone on this machine: the generated output in every worktree, the machine-local store, the version copies and the launcher, and the local tracker ref once the remote holds its tip. Teammates run it after an uninstall lands. It refuses while grimoire processes still run in the clone, and lists them.

### Generated output and `git stash --all`

Evolved skills reach agents as generated output, which nobody commits: a copy of each skill in `.grimoire/skills/<name>/`, and a stub for each client in `.claude/skills/grimoire-<name>/` and `.agents/skills/grimoire-<name>/`. Every one of these folders ignores itself. **`git stash --all` is unsupported while copies exist**, because it stashes ignored files too; `git stash -u` is fine. An edit to a generated copy is set aside as a stray edit for a person to record or discard, and the served text is put back.

## Trusting grimoire in your clients

Do this once after `init`, then restart open sessions and launch your clients from the repo root.

**Claude Code: workspace trust.** Start `claude` in the repo and accept the trust prompt once. Headless runs (`claude -p`, the SDK) in a folder never trusted also ignore the allow list: pass `--allowedTools mcp__grimoire`, add a user-level allow rule, or trust the folder once interactively.

**Codex: project trust, then `/hooks`.**

- Trust the project when Codex asks. Trust is keyed on the main checkout's root, and linked worktrees inherit it.
- Approve grimoire's hook in `/hooks`. **Codex will skip grimoire's hook until you approve it in `/hooks`, once per clone of this repo.** The approval is stored per user and per clone path. It is lost if another `[[hooks.SessionStart]]` group is inserted before grimoire's in `.codex/config.toml`, or when grimoire's hook definition changes (an upgrade's plan says so). Codex runs the main checkout's `.codex/` in every linked worktree.
- `codex exec` skips unapproved hooks silently. `grimoire status` and `grimoire doctor` report whether Codex will run grimoire's hook.
- In a Codex session that was already running when grimoire was installed, evolved skills written later appear only in the next session.

## What capture commits: the excerpt disclosure

Every `init`, including a join, shows this disclosure. The tracker's excerpt mode is one of `excerpts`, `facts` or `none`:

- **`excerpts`:** redacted excerpts of agent transcripts, plus facts, are committed to `grimoire/tracker` and pushed while the attempt is still open.
- **`facts`:** names, versions, hashes, times and statuses, never excerpt text. This is what `init --yes` picks for a new tracker.
- **`none`:** grimoire never opens a transcript.

Redaction is best-effort: a secret can slip through. **Pushed history can't be purged.** A person changes the mode with `grimoire settings set excerpts <mode>` or in the dashboard, which shows the disclosure again; a machine may only lower it for its own sessions. Tightening it strips excerpt text from open attempts in the same commit. Loosening it applies on every clone at its next cut, and teammates aren't asked.

grimoire pushes the branch `grimoire/tracker` to your remote. Branch rulesets, required checks and preview deploys must exempt it. Optionally, a GitHub autolink for the prefix `gr-` turns issue ids in commits and PRs into links.

## The dashboard

`grimoire start` serves the dashboard on 127.0.0.1 for this clone, with upkeep on timers and, while one is configured, the runner. It is one foreground process per clone, with no daemon or OS service; Ctrl-C stops it. It refuses agent shells but needs no terminal, so a login item can run it. Agents never need it.

`grimoire open [<ref>]` signs a browser tab in to the running dashboard (landing on an issue when you name one), over a user-only control channel. It prints no secret. A second `grimoire start` does the same and exits.

The dashboard is where people work: Attention (sync failures, conflicts, stale claims, stray edits), the issues, attempts and their traces, the wiki, skill proposals to accept or reject, evolved skills, and Settings (the excerpt mode, sync, the runner). When the worktree you launched it from comes to pin another version, it shows a banner asking you to restart `start`.

## The runner and schedulers

Knowledge chores become due as agents work. Normally an agent already in a session picks a due chore up with the `grimoire-chores` skill, nudged by one SessionStart line. Two other ways are described in full in [docs/runner.md](docs/runner.md):

- **The runner** is a per-machine opt-in: `grimoire runner enable claude` (or `codex`), at your own terminal, lets grimoire start your own `claude -p` or `codex exec` to do due chores unattended, on your own login. **Its warnings:**
  - runs draw on your plan's shared 5-hour and weekly limits;
  - unattended `claude -p` use on a subscription is a policy gray zone, so check Anthropic's current terms for your plan;
  - for Codex, your Codex config stays in use, and its MCP servers, hooks, `notify` program and developer instructions are switched off for each run.

  Before each run a billing guard asks the client which login it would bill, and refuses API-key billing unless you passed `--allow-api-billing`. At most 6 runs in 24 hours; after 2 failed runs in a row it pauses for 6 hours. `grimoire runner disable` turns it off.
- **Schedulers.** Locally, have Windows Task Scheduler, cron or launchd run `node .grimoire/run.cjs chore run --due` from the repo root (it exits 0 and starts nothing when no chore is due), or create a Claude Desktop scheduled task or a Codex app automation whose prompt runs the `grimoire-chores` skill. In the cloud (Claude Code on the web and Routines), the join goes in the environment's setup script, never the routine prompt, and runs are compile-only. The recipes are in [docs/runner.md](docs/runner.md).

**CI follows the pin.** A CI job (or a cloud setup script) joins at exactly the version the checkout pins:

```sh
v=$(node .grimoire/run.cjs pin) && npx -y "@goksening/grimoire@$v" init --yes
```

A dependency bot may run `npx @goksening/grimoire@<new> init --upgrade --yes` in a job with no agent markers; `--yes` never raises a format's `compat`.

## Troubleshooting

- **`grimoire status`** says what to know about this checkout now, and writes nothing: sync state and the last failure, the pending proposal, what is due, the runner's caps and pause, stray edits, stale claims, pointer files upkeep refreshed (commit them), the Node version your clients run, whether the excerpt mode changed since this machine joined, and whether Codex will run grimoire's hook.
- **`grimoire doctor`** is a read-only report on the store (unparsable records, duplicate ids, conflicts, stale locks, sync ahead or behind), the install (the pinned copy and its integrity, the launcher, the shim, pointer and hook drift, client config conflicts, running servers against the pin) and capture statistics. **`grimoire doctor --fix`** makes the repairs that have a single answer: content pointer files and stale locks. `--readers` adds the transcript readers' structure statistics.
- **"grimoire isn't set up on this machine"** (exit 3): this clone hasn't joined the pinned version. Run the `npx @goksening/grimoire@<pin> init` it names.
- **A hook does nothing.** Hooks always exit 0 and swallow their own failures; set `GRIMOIRE_DEBUG=1` to see them on stderr. For Codex, check the `/hooks` approval above.
- **`NOT_SYNCED`:** this clone can't use the tracker `.grimoire/config.yml` names: no ref here holds it (none fetched yet, or a different tracker; fetch it, or join with `init`), or the clone is shallow or partial and misses its history. `init` also gives it when it can't reach the remote it reads. A sync whose fetch or push failed is not `NOT_SYNCED`: `grimoire sync status` shows that failure with the remote's message, and `grimoire sync` retries now.

## Codex support, and how it was verified

**Codex support was verified against the real Codex CLI 0.162.1 binary with a scripted model, not a live ChatGPT session.** No Codex login was available during the build, so every model turn came from a local stand-in for the OpenAI Responses API, while everything else ran in the real binary: the MCP client and tool routing, hooks and their trust, rollout files, subagents, compaction, skills listing and the exec sandbox. Findings: [docs/research/spikes/codex-mcp-hooks-transcripts.md](docs/research/spikes/codex-mcp-hooks-transcripts.md) and [docs/research/spikes/codex-skills-role-exec.md](docs/research/spikes/codex-skills-role-exec.md).

What depends on a real model or a real ChatGPT login couldn't be verified that way, so **these fallback paths are on in 1.0.0:**

- **Skill stubs (P2, Codex half).** The Codex stub `.agents/skills/grimoire-<name>/SKILL.md` leads with a `skill_read` call, rather than relying on a model matching the stub by its description.
- **The chore role (P5, model side).** The `grimoire-chores` role file and skill ship, and the in-place chore run under the root-thread admission rule stays built, in case a real model doesn't spawn the role.
- **The Codex runner (C4).** It keeps your `config.toml`, so keyring logins work, and switches off what that config adds with `-c` flags: MCP servers, hooks, `notify`, `developer_instructions`, the skills block, and the provider pinned to `openai`. The ChatGPT-login path itself was not verified.
- **Background sync from a Codex shell (R4, Codex half).** `sync --background` isn't relied on there, because Codex's Windows sandboxes kill or block a detached child; the sync-pending marker, retried by the next upkeep, carries the push.

## Findings that changed behaviour

Before the build, each client behaviour grimoire depends on was checked against the real clients (spec §22). Where a check took its documented fallback or changed the design, the findings file says so:

| Spike | Findings | What changed |
| -- | -- | -- |
| A: Claude Code hooks, bootstrap and transcripts | [docs/research/spikes/claude-hooks-transcripts.md](docs/research/spikes/claude-hooks-transcripts.md) | R3 took its fallback: Node treats `--from` after `-e` as its own option, so hook entries put `--` after the bootstrap, and the bootstrap passes its arguments to the launcher explicitly. T1: the pre-tool-use hint carries only ids, never `transcript_path` (the auto-mode classifier denies calls whose hint holds it). |
| B: one MCP server, both protocol eras | [docs/research/spikes/mcp-dual-era.md](docs/research/spikes/mcp-dual-era.md) | T2 took its low-level-handler route: the hint key reaches the SDK's low-level `tools/call` handler raw. The MCP SDK v2 is bundled (about 800 KB unminified) from devDependencies, so the package keeps zero runtime dependencies. |
| C: Claude Code skill delivery and the chore subagent | [docs/research/spikes/claude-skills-chores.md](docs/research/spikes/claude-skills-chores.md) | No fallbacks. It independently found the `--from` problem fixed by A's `--`. |
| D: the Claude runner, cloud setup and the Windows named pipe | [docs/research/spikes/claude-runner-ipc.md](docs/research/spikes/claude-runner-ipc.md) | R5 took its fallback: a Windows named pipe can't be made user-only from Node, so every control-channel request is authenticated with a per-user secret under `%LOCALAPPDATA%`. R6 was unverifiable, so its fallback applies: the cloud join goes in the environment's setup script ([docs/runner.md](docs/runner.md)). |
| E: Codex MCP, hooks and transcripts | [docs/research/spikes/codex-mcp-hooks-transcripts.md](docs/research/spikes/codex-mcp-hooks-transcripts.md) | No fallbacks (real Codex 0.162.1, scripted model). It settled the Codex trust steps above, and the transcript reader searches a thread's creation-day folder. |
| F: Codex skills, the chore role and the exec runner | [docs/research/spikes/codex-skills-role-exec.md](docs/research/spikes/codex-skills-role-exec.md) | Four fallbacks: P2 (Codex half), P5 (model side), C4 and R4 (Codex half), listed in the previous section. |

## For maintainers

### The release promise

- A patch changes no format.
- A minor may raise a `format` additively, never `compat` or `install_format`.
- Only a major may raise `compat` or bump `install_format`.

Within one major, reverting an upgrade's commit undoes it. There is no update check, ever. 1.0.0 freezes store format 1, machine-local format 1 and `install_format` 1 (`test/release/format-freeze.test.ts`).

`install_format` covers the bootstrap, the hook entries, the permission-bearing entries, which pointer files exist and where, the manifest schema, `run.cjs` and the dotfolder layout. Shipped text (instruction text, chore carriers, the adapter block, stub bodies) and verb behaviour may change in any release.

### The nine rules

1. **Declare formats.** Each release declares J and K per marker. J rises only with a migration that raises `compat`.
2. **Additive within a major.** A minor adds only optional keys, and write-once files under new paths, that v1's generic handling folds correctly. Anything that changes a derivation raises `compat`: the current skill version, fork resolution, wiki folds, ready and blocked, outcomes, revisions.
3. **Expand, then contract.** A `compat` raise runs only when nothing would be stranded (for the store, the remote default branch's committed pin is at least the new `requires`; for the machine-local store, every registered worktree's pin is), is interactive with a typed confirmation, and is never part of a minor.
4. **A store migration is a forward commit:** one compare-and-set commit per format step, with the marker and the data together; deterministic, never rewriting history, migrating or refusing a lagging side's unpushed commits at fold time.
5. **The cross-pin contract only grows.** See [docs/cross-pin-contract.md](docs/cross-pin-contract.md): the bootstrap, the entry verbs, `run.cjs pin`, the launcher↔package contract, the marker schema, the join record, the coordination class, the control channel, the manifest entry kinds and the generated-path list.
6. **`install_format` bumps are batched into majors.**
7. **Removal reads only frozen lists,** so any release can uninstall any install and leave any clone.
8. **The Node floor rises only in a major.** `init --upgrade` checks the target's floor against the Node versions recorded in process records.
9. **Never unpublish a release.** A bad release is superseded by a patch and deprecated with a pointer to it.

### Publishing

1. `npm ci`, then `npm run check:full` green, on Windows at least.
2. `npm pack --dry-run`: the list must hold only `package.json`, `README.md`, `LICENSE` and `dist/` (the bundle, `dist/chunks/`, `dist/dashboard/` and `dist/THIRD_PARTY_LICENSES.md`), and no source maps. `test/release/package.test.ts` checks the allowlist, and `test/release/packed-release.slow.test.ts` installs the packed tarball with `init` and runs MCP in both eras, the CLI and the dashboard against it.
3. `npm publish`. `prepack` builds `dist/` first, and `publishConfig` makes the scoped package public.

The package has no runtime dependencies (`npm run check:deps` fails on any `dependencies`, `optionalDependencies`, `peerDependencies` or `bundleDependencies`); everything is bundled from devDependencies, and the bundled packages' licenses ship in `dist/THIRD_PARTY_LICENSES.md`.

**Follow-up from 1.0.1 on: provenance.** 1.0.0 is published from a maintainer's machine, which can't produce npm provenance (it needs a CI OIDC identity), so `publishConfig` sets only `"access": "public"`. From 1.0.1 on, publish from GitHub Actions with npm trusted publishing, which adds provenance; add CI on Windows, macOS and Linux at the Node floor and the current LTS at the same time. 1.0.0 was checked on Windows with Node 24.

## Contributing

How to build, test and find your way around the source: [docs/contributing.md](docs/contributing.md). Design decisions are in [docs/adr/](docs/adr/), the vocabulary in [GLOSSARY.md](GLOSSARY.md).

## License

[MIT](LICENSE). The packages bundled into `dist/` keep their own licenses, listed in `dist/THIRD_PARTY_LICENSES.md`.
