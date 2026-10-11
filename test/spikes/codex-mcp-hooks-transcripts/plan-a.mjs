// Scenario A: one turn with an MCP call, one-shot and long-running unified
// exec, a failing command, a shell read of a skill copy, a git commit and an
// apply_patch (the "Exit code: N" format).
const patch = '*** Begin Patch\n*** Add File: notes.txt\n+written by apply_patch\n*** End Patch\n';
const plan = [
  { search: 'probe echo' },
  { call: 'echo', ns: 'mcp__probe', args: { text: 'show gr-7k2pq' } },
  { call: 'exec_command', args: { cmd: 'Get-Content .grimoire/skills/probe/SKILL.md' } },
  { call: 'exec_command', args: { cmd: 'git -c user.email=agent@example.com -c user.name=agent commit --allow-empty -m "Probe commit" -m "Refs: gr-7k2pq"' } },
  { call: 'exec_command', args: { cmd: 'node -e "console.error(String(42)); process.exit(3)"' } },
  { call: 'apply_patch', custom: true, input: patch },
  { call: 'exec_command', args: { cmd: 'node -e "console.log(String(1)); setTimeout(function(){console.log(String(2))}, 15000)"', yield_time_ms: 1000 } },
  { call: 'write_stdin', args: { session_id: '$SESSION', chars: '', yield_time_ms: 30000 } },
  { say: 'scenario A done' },
];
process.stdout.write(`PLAN: ${JSON.stringify(plan)}`);
