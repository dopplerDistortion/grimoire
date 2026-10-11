import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

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
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Isolates every test process from the user's and the system's git config.
    setupFiles: ['./test/harness/setup.ts'],
    // vi.stubEnv() changes are undone after every test.
    unstubEnvs: true,
    // Real git on Windows is slow to spawn; give real-repo tests room.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
