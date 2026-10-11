# Working agents get evolved skills through pointer stubs, never the wiki

The knowledge layer produces a wiki and evolved skills. Only the evolved skills reach the agents that work in a host repo: no instruction, hook output, MCP surface or skill body points an agent at the wiki during issue work. WikiSkill found that giving agents wiki access during training rollouts lowered scores (63.7% → 60.9%), and the paper suspects it also made the resulting traces less useful for evolving skills.

The one exception is a knowledge chore, which has to read the wiki. Grimoire hands chore work only to a context that holds no open attempt: a forked skill context in Claude Code, or otherwise a session with no open attempt or the opt-in runner. If a session ran a chore in its main context and later opens an attempt, that attempt's trace is marked as wiki-exposed.

Each evolved skill's text lives in `.grimoire/skills/<name>/SKILL.md`. For each one, grimoire's own code writes a small stub per client, at `.claude/skills/grimoire-<name>/SKILL.md` and `.agents/skills/grimoire-<name>/SKILL.md`. The stub copies only the `name` and `description` and tells the agent to read the real file. Both clients can then match skills by description natively, and every LLM-written word stays inside the dotfolder.

Evolved skills grant nothing. Grimoire keeps only `name`, `description` and the markdown body, so a prompt injection carried from a trace into a skill can never become an auto-approved command. Skills that grimoire ships are versioned with the package and keep any client extras they need. Their names are reserved, so an evolved skill can never take one.

## Considered Options

- **Load every evolved skill into every session, as the paper does.** The paper injects the full skill text into the system prompt and never tests triggering. Rejected for two reasons:
  - Codex has no instruction imports, so the full text would have to be pasted into `AGENTS.md`, outside the dotfolder.
  - Every session would pay for every skill, whether it was relevant or not.
- **Wiki on request**, through an MCP resource or a search tool. Rejected on the ablation's evidence. The paper implies its agents read the wiki index and then opened pages on demand, which is this option.
- **Other ways to get the skill text to the client**, all rejected:
  - Full copies in each client's folder aren't small pointer files, and they triple every diff.
  - Git on Windows commits symlinks as duplicate files.
  - A plugin is trust-gated and renames the skills.
  - `@`-expansion in the stub has unverified path resolution, and it would run the real text through Claude's skill loader.
  - `!` injection needs pre-approved `allowed-tools`.
- **MCP only, or one umbrella stub.** Rejected: both lose per-skill native matching, and MCP-only skills reach only sessions that call grimoire.

## Consequences

- This leaves the paper's tested setup: nobody has measured whether agents pick the right evolved skill from its description. For that reason, active evolved skills are capped (by default 8 skills, with descriptions of at most 300 characters), and each trace records which evolved skills the attempt read.
- Using a skill costs one extra file read. Adding, retiring or re-describing an evolved skill rewrites two files outside the dotfolder, and both are recorded in the manifest.
- The wiki is still plain committed files, so an agent that searches the repo can find it. We accept that leak and don't police it.

_Amended by ADR 0010: evolved-skill text lives on the tracker branch. `.grimoire/skills/<name>/SKILL.md` and the stubs are copies that grimoire generates in each checkout and nobody commits. Each evolved skill is one `SKILL.md`, with no supporting files. The wiki isn't in any checkout, so the grep leak above narrows to deliberate reads of the tracker branch._
