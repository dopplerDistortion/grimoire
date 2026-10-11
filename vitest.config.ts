import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

// Timing acceptance tests: each runs after every other file, with the machine to itself.
const ACCEPTANCE = ['test/core/concurrency.test.ts'];
const COLD_START = ['test/surfaces/mcp/cold-start.test.ts'];

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
    // Isolates every test process from the user's and the system's git config.
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
          exclude: [...ACCEPTANCE, ...COLD_START, 'node_modules/**'],
        },
      },
      // The write-path acceptance test measures the ~10 s budget under 40 writers,
      // so it runs after every other file, with the machine to itself.
      { extends: true, test: { name: 'acceptance', include: ACCEPTANCE, sequence: { groupOrder: 1 } } },
      // The MCP cold-start test measures the 300 ms opening budget: last, alone.
      { extends: true, test: { name: 'cold-start', include: COLD_START, sequence: { groupOrder: 2 } } },
    ],
  },
});
