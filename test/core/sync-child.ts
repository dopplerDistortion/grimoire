// The detached sync child a CLI write spawns, run the way `grimoire sync
// --background` (GOK-141) will run it: a CLI context inside a Codex shell.
//
//   node sync-child.mjs <repo root>
import { runBackgroundSync } from '../../src/core';

const [root] = process.argv.slice(2);
await runBackgroundSync({
  surface: 'cli',
  repo: { root: root!, pin: null },
  person: { name: 'Alice Example', email: 'alice@example.com' },
  client: { name: 'codex' },
  evidence: { agentMarkers: ['CODEX_THREAD_ID'] },
  nonce: 'sync-child',
});
