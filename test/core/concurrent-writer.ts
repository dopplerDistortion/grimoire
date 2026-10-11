// One writer process for the concurrency acceptance test: makes `writes`
// concurrent creates through one core, prints the outcomes as JSON.
//
//   node concurrent-writer.mjs <repo root> <writer number> <writes>
import { createCore } from '../../src/core';

const [root, writer, writes] = process.argv.slice(2);
const core = createCore();
const ctx = {
  surface: 'cli' as const,
  repo: { root: root!, pin: null },
  person: { name: `Writer ${writer}`, email: `writer${writer}@example.com` },
  nonce: `writer-${writer}`,
};
const outcomes = await Promise.all(
  Array.from({ length: Number(writes) }, (_, i) =>
    core.call('create', { title: `writer ${writer} write ${i}` }, ctx),
  ),
);
await core.close();
process.stdout.write(JSON.stringify(outcomes));
