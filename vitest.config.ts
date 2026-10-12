import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// The slow tests: whatever asserts a wall-clock budget or latency, stalls or
// kills real processes, or runs many concurrent writers. They run in the
// `slow` project, one file at a time with the machine to themselves
// (`npm run test:slow`; `npm run check:full` = check + test:slow), never
// beside the main suite's parallel files. Name a new one `*.slow.test.ts`.
// The 40-writer acceptance test measures the ~10 s write budget; the MCP
// cold-start test measures the 300 ms opening budget.
const SLOW = ['src/**/*.slow.test.ts', 'test/**/*.slow.test.ts', 'test/core/concurrency.test.ts', 'test/surfaces/mcp/cold-start.test.ts'];

export default defineConfig({
  define: {
    // The same constant the esbuild bundle gets (scripts/build.mjs).
    __GRIMOIRE_VERSION__: JSON.stringify(pkg.version),
  },
  resolve: {
    alias: {
      '#harness': fileURLToPath(new URL('./test/harness/index.ts', import.meta.url)),
    },
  },
  test: {
    // Isolates every test process from the user's and the system's git config, and fails a test
    // (or a file's beforeAll) that leaves a process it started running (test/harness/children.ts).
    setupFiles: ['./test/harness/setup.ts'],
    // vi.stubEnv() changes are undone after every test.
    unstubEnvs: true,
    // Real git on Windows is slow to spawn; give real-repo tests room.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'main',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: [...SLOW, 'node_modules/**'],
        },
      },
      // After the main suite when both run (`npm test`), and serially.
      { extends: true, test: { name: 'slow', include: SLOW, fileParallelism: false, sequence: { groupOrder: 1 } } },
    ],
  },
});
