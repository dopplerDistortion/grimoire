// For test/harness/children.slow.test.ts only: runs leaky.fixture.ts with the harness's setup file.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '#harness': fileURLToPath(new URL('../index.ts', import.meta.url)) } },
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['leaky.fixture.ts'],
    setupFiles: [fileURLToPath(new URL('../setup.ts', import.meta.url))],
  },
});
