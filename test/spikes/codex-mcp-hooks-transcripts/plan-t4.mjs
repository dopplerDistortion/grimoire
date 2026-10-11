const child = [
  { search: 'probe echo' },
  { call: 'echo', ns: 'mcp__probe', args: { text: 'child reads gr-7k2pq' } },
  { call: 'exec_command', args: { cmd: 'git log --oneline -1' } },
  { say: 'child done' },
];
const root = [
  { search: 'spawn agent probe echo', limit: 12 },
  { call: 'spawn_agent', ns: 'multi_agent_v1', args: { message: `PLAN: ${JSON.stringify(child)}` } },
  { call: 'wait_agent', ns: 'multi_agent_v1', args: { targets: ['$AGENT'], timeout_ms: 60000 } },
  { call: 'echo', ns: 'mcp__probe', args: { text: 'root closes gr-7k2pq' } },
  { say: 'root done' },
];
process.stdout.write(`PLAN: ${JSON.stringify(root)}`);
