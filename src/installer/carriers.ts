// The chore carriers (spec §11 Pointer files, §16 Carriers): the four files
// `init` writes as manifest `file` entries, which upkeep refreshes as content
// pointer files. Every one carries the one shipped procedure.
//
// - Claude Code (spike C): the skill forks into the `grimoire-chores`
//   subagent in the background. It has no `allowed-tools`: with it, the Skill
//   call itself needed approval and the chore never started. The subagent gets
//   the 4 chore tools plus `ToolSearch` (C2: deferred tools load through it).
// - Codex (spike F): the skill spawns the `grimoire-chores` role with a fresh
//   context (a role with a full-history fork is rejected), and runs the
//   procedure in place, under the root-thread rule, when it can't spawn. The
//   role turns off the five features a role can, and the skills listing; it
//   can't remove `apply_patch` or `web_search`, so the procedure forbids them.
import { CHORE_PROCEDURE, CHORE_TOOLS, CHORES_NAME, CHORES_SKILL_DESCRIPTION } from '../knowledge/chores/offering';
import { tomlString } from './toml';

/** Where each carrier lives, by client. */
export const CHORE_CARRIERS = {
  claudeSkill: `.claude/skills/${CHORES_NAME}/SKILL.md`,
  claudeAgent: `.claude/agents/${CHORES_NAME}.md`,
  codexSkill: `.agents/skills/${CHORES_NAME}/SKILL.md`,
  codexRole: `.codex/agents/${CHORES_NAME}.toml`,
} as const;

function markdown(fields: readonly (readonly [string, string])[], body: string): string {
  return `---\n${fields.map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n\n${body}\n`;
}

/** `.claude/skills/grimoire-chores/SKILL.md`. */
export function claudeChoreSkillText(): string {
  return markdown(
    [
      ['name', CHORES_NAME],
      // The fork sees none of the conversation: the user's request reaches it only as the skill's argument (§16: a user's request always works).
      ['description', `${CHORES_SKILL_DESCRIPTION} When the user asked for this run, pass manual as the argument.`],
      ['argument-hint', 'manual'],
      ['context', 'fork'],
      ['agent', CHORES_NAME],
      ['background', 'true'],
    ],
    `${CHORE_PROCEDURE}

This run's arguments: $ARGUMENTS`,
  );
}

/** `.claude/agents/grimoire-chores.md`. */
export function claudeChoreAgentText(): string {
  return markdown(
    [
      ['name', CHORES_NAME],
      ['description', "Runs grimoire's maintenance chores with grimoire's chore tools only. Use only through the grimoire-chores skill."],
      ['tools', [...CHORE_TOOLS.map((tool) => `mcp__grimoire__${tool}`), 'ToolSearch'].join(', ')],
      ['omitClaudeMd', 'true'],
    ],
    `You run grimoire's maintenance chores. Follow this procedure exactly.\n\n${CHORE_PROCEDURE}`,
  );
}

/** `.agents/skills/grimoire-chores/SKILL.md`. */
export function codexChoreSkillText(): string {
  const body = [
    'Spawn a subagent with `spawn_agent`: `agent_type` set to `grimoire-chores` and `fork_context` set to `false` (on the v2 tool: `fork_turns: "none"`). Give it the message "Run the due grimoire chore." If the user explicitly asked for this run, give it the message "Run the grimoire chore; the user asked for this run: manual." instead: the subagent sees none of this conversation. Wait for it, then return its final message verbatim, and nothing else.',
    '',
    'If spawning is unavailable, run the chore here instead, with this procedure:',
    '',
    CHORE_PROCEDURE,
  ].join('\n');
  return markdown(
    [
      ['name', CHORES_NAME],
      ['description', CHORES_SKILL_DESCRIPTION],
    ],
    body,
  );
}

/** `.codex/agents/grimoire-chores.toml`. */
export function codexChoreRoleText(): string {
  return [
    `name = ${tomlString(CHORES_NAME)}`,
    `description = ${tomlString("Runs grimoire's due maintenance chores with grimoire's chore tools only. Spawn it only from the grimoire-chores skill.")}`,
    `developer_instructions = ${tomlString(CHORE_PROCEDURE)}`,
    '',
    '[features]',
    'shell_tool = false',
    'apps = false',
    'plugins = false',
    'memories = false',
    'request_permissions_tool = false',
    '',
    '[skills]',
    'include_instructions = false',
    '',
  ].join('\n');
}
