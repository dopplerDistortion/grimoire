// A short-lived process that closes an issue and exits the moment the close
// answers, without waiting for the core: what a CLI killed (or exiting) right
// after its write looks like. Its automatic sync only notes the request.
//
//   node write-and-exit.mjs <repo root>
import { createCore, type CallContext } from '../../src/core';

const [root] = process.argv.slice(2);
const core = createCore({ autoSync: () => {} });
const ctx: CallContext = {
  surface: 'mcp',
  repo: { root: root!, pin: null },
  person: { name: 'Alice Example', email: 'alice@example.com' },
  client: { name: 'codex' },
  nonce: 'write-and-exit',
};

async function call(name: string, input: unknown): Promise<Record<string, string>> {
  const outcome = await core.call(name, input, ctx);
  if (!outcome.ok) throw new Error(`${name} failed: ${JSON.stringify(outcome.error)}`);
  return outcome.result as Record<string, string>;
}

const { id } = await call('create', { title: 'Closed in a process that exits at once' });
const { attempt } = await call('claim', { id });
await call('close', {
  id,
  attempt,
  reason: 'done',
  debrief: { asked: 'fix it', tried: 'a patch', failed: 'none', worked: 'the patch', next: 'none' },
});
process.exit(0);
