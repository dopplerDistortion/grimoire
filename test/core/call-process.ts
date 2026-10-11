// A separate grimoire process for multi-process tests: makes the given core
// calls one after another through one core, prints the outcomes as JSON.
//
//   node call-process.mjs <repo root> <name> '<JSON [[op, input], ...]>'
import { createCore } from '../../src/core';

const [root, name, calls] = process.argv.slice(2);
const core = createCore();
const ctx = {
  surface: 'mcp' as const,
  repo: { root: root!, pin: null },
  person: { name: `Person ${name}`, email: `${name}@example.com` },
  client: { name: 'claude-code' },
  nonce: `process-${name}`,
};
const outcomes: unknown[] = [];
for (const [op, input] of JSON.parse(calls!) as [string, unknown][]) {
  outcomes.push(await core.call(op, input, ctx));
}
await core.close();
process.stdout.write(JSON.stringify(outcomes));
