// Acceptance (spec §4): 40 concurrent writers × 2 writes on Windows give no
// BUSY, a linear history and every record — across processes, and across
// concurrent calls inside one process.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { afterAll, beforeAll, describe, expect } from 'vitest';
import { makeTempDir, removeDir, runCommand, type Checkout } from '#harness';
import type { Outcome } from '../../src/core';
import { coreTest as test, trackerTip } from './support';

const WRITERS = 40;
const WRITES = 2;

/** Asserts the tracker holds exactly `titles`, in a linear history of one commit per create. */
async function expectLinearWithEveryRecord(checkout: Checkout, titles: readonly string[]): Promise<void> {
  const tip = (await trackerTip(checkout))!;
  expect(await checkout.git(['rev-list', '--merges', tip])).toBe('');
  expect(await checkout.git(['rev-list', '--count', tip])).toBe(String(titles.length + 1));
  const files = (await checkout.git(['ls-tree', '-r', '--name-only', tip, 'issues'])).split('\n');
  expect(files).toHaveLength(titles.length);
  const records = await Promise.all(files.map((file) => checkout.git(['cat-file', 'blob', `${tip}:${file}`])));
  const found = records.map((record) => JSON.parse(/^title: (.*)$/m.exec(record)![1]!) as string);
  expect(found.sort()).toEqual([...titles].sort());
  const seqs = records.map((record) => Number(/^seq: (\d+)$/m.exec(record)![1]));
  expect(seqs.sort((a, b) => a - b)).toEqual(titles.map((_, i) => i + 1));
}

const allTitles = () =>
  Array.from({ length: WRITERS }, (_, w) => Array.from({ length: WRITES }, (_, i) => `writer ${w} write ${i}`)).flat();

describe('concurrent writers (acceptance)', () => {
  test('40 writers × 2 writes inside one process, through two cores, give no BUSY and a linear history', async ({
    world,
    grimoire,
  }) => {
    const cores = [grimoire.makeCore({ clock: undefined }), grimoire.makeCore({ clock: undefined })];

    const outcomes = await Promise.all(
      Array.from({ length: WRITERS }, async (_, w) => {
        const results: Outcome<unknown>[] = [];
        for (let i = 0; i < WRITES; i++) {
          results.push(await cores[w % 2]!.call('create', { title: `writer ${w} write ${i}` }, grimoire.ctx));
        }
        return results;
      }),
    );

    expect(outcomes.flat().filter((outcome) => !outcome.ok)).toEqual([]);
    await expectLinearWithEveryRecord(world.a, allTitles());
  });

  describe('across processes', () => {
    let bundleDir = '';
    let writer = '';

    beforeAll(async () => {
      bundleDir = await makeTempDir('grimoire-writer-');
      writer = path.join(bundleDir, 'writer.mjs');
      await esbuild.build({
        entryPoints: [fileURLToPath(new URL('./concurrent-writer.ts', import.meta.url))],
        outfile: writer,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        define: { __GRIMOIRE_VERSION__: JSON.stringify('0.0.0-test') },
        logLevel: 'silent',
      });
    });
    afterAll(async () => {
      await removeDir(bundleDir);
    });

    test('40 writer processes × 2 concurrent writes each give no BUSY and a linear history', async ({
      world,
      grimoire,
    }) => {
      void grimoire; // initializes the tracker
      const started = Date.now();

      const runs = await Promise.all(
        Array.from({ length: WRITERS }, (_, w) =>
          runCommand(process.execPath, [writer, world.a.dir, String(w), String(WRITES)], { timeoutMs: 60_000 }),
        ),
      );

      for (const run of runs) expect(run.stderr).toBe('');
      const outcomes = runs.flatMap((run) => JSON.parse(run.stdout) as Outcome<unknown>[]);
      expect(outcomes.filter((outcome) => !outcome.ok)).toEqual([]);
      expect(outcomes).toHaveLength(WRITERS * WRITES);
      await expectLinearWithEveryRecord(world.a, allTitles());
      console.info(`[acceptance] ${WRITERS} processes × ${WRITES} writes in ${Date.now() - started} ms`);
    }, 120_000);
  });
});
