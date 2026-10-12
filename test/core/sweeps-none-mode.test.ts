// `none` never opens a transcript (spec §14 The setting): a sweep in `none`
// mode attaches facts-only records, reaching the context's latest skill_read
// event plus the event count, and touches nothing under the client's folders.
// Asserted by fixture access tracking: every filesystem call is recorded while
// the sweep runs. Seam 1.
import path from 'node:path';
import { describe, expect, vi } from 'vitest';
import { MachineLocalStore } from '../../src/machine-local';
import { runUpkeep } from '../../src/upkeep';
import { excerptSweep } from '../../src/upkeep/sweep';
import { CLAUDE_SESSION, claimed, created, sessionRecords, setExcerptMode, test } from './capture-support';

const track = vi.hoisted(() => ({ on: false, paths: [] as string[] }));

/** Wraps every function of an fs module so that a call made while tracking records its path argument. */
function tracked<T extends object>(actual: T): T {
  const wrapped: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(actual)) {
    wrapped[name] =
      typeof value === 'function' && /^[a-z]/.test(name)
        ? (...args: unknown[]) => {
            if (track.on && (typeof args[0] === 'string' || args[0] instanceof URL)) track.paths.push(`${name} ${String(args[0])}`);
            return (value as (...a: unknown[]) => unknown).apply(actual, args);
          }
        : value;
  }
  return { ...wrapped, default: wrapped } as T;
}

vi.mock('node:fs', async (importOriginal) => tracked(await importOriginal<object>()));
vi.mock('node:fs/promises', async (importOriginal) => tracked(await importOriginal<object>()));

const IDLE = new Date('2026-10-11T04:00:00.000Z');

/** Runs one sweep while tracking; returns the paths under `dir` it touched. */
async function sweepTracking(root: string, dir: string, options: Parameters<typeof excerptSweep>[0]): Promise<string[]> {
  track.paths = [];
  track.on = true;
  try {
    const report = await runUpkeep({ root, parts: [excerptSweep(options)], force: true });
    expect(report.runs[0]).toMatchObject({ status: 'ran' });
  } finally {
    track.on = false;
  }
  const under = path.resolve(dir).toLowerCase();
  return track.paths.filter((entry) => path.resolve(entry.slice(entry.indexOf(' ') + 1)).toLowerCase().startsWith(under));
}

describe('a sweep in none mode', () => {
  test('opens no transcript and attaches a facts-only record from the context’s skill_read events', async ({ world, grimoire, capture }) => {
    await setExcerptMode(world.a, 'none');
    const core = capture.makeCore();
    const id = await created(core, grimoire.ctx, 'No transcripts');
    const attempt = await claimed(core, grimoire.ctx, id);
    const machine = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const actor = { kind: 'agent', client: 'claude-code', session: CLAUDE_SESSION, context: 'main', call: 'toolu_read', nonce: 'nonce-claude' };
    await machine.records.append('skill-reads', { skill: 'fix-redirects', version: 'a'.repeat(64), at: '2026-10-11T03:27:18.000Z', actor, nonce: 'nonce-claude' });
    await machine.records.append('skill-reads', { skill: 'fix-redirects', version: 'a'.repeat(64), at: '2026-10-11T03:27:21.000Z', actor, nonce: 'nonce-claude' });

    const touched = await sweepTracking(world.a.dir, capture.configDir, { capture: capture.options, clock: () => IDLE });

    expect(touched).toEqual([]);
    const [record] = await sessionRecords(world.a, id, attempt);
    expect(record!.fields).toMatchObject({
      session: CLAUDE_SESSION,
      context: 'main',
      excerpt: 'off',
      facts: 'events_only',
      reader_version: null,
      reach: { at: '2026-10-11T03:27:21.000Z', ref: '2' },
    });
    expect(record!.body).toBe('');
  });

  test('while in excerpts mode the same sweep does read the transcript (the tracking sees it)', async ({ world, grimoire, capture }) => {
    const id = await created(capture.core, grimoire.ctx, 'Transcripts');
    await claimed(capture.core, grimoire.ctx, id);

    const touched = await sweepTracking(world.a.dir, capture.configDir, { capture: capture.options, clock: () => IDLE });

    expect(touched.some((entry) => entry.includes(`${CLAUDE_SESSION}.jsonl`))).toBe(true);
  });
});
