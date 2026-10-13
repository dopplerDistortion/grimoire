import { test } from 'vitest';
import { createGitWorld } from './git-world';

/**
 * A Vitest `test` with a fresh `world` fixture (see createGitWorld), removed
 * after each test.
 *
 *   gitTest('...', async ({ world }) => { await world.a.git(['status']); });
 */
export const gitTest = test.extend('world', async ({}, { onCleanup }) => {
  const world = await createGitWorld();
  onCleanup(() => world.cleanup());
  return world;
});
