// The Attention queue's empty state (spec §20): "Nothing needs you" only when
// every section was read and nothing needs a person. A section the core
// couldn't read is an error item of its own, never an empty queue.
import { describe, expect, it } from 'vitest';
import { EMPTY, emptyState, queueSize, unreadableTitle } from '../../../src/surfaces/dashboard/attention-queue';
import type { AttentionResult } from '../../../src/surfaces/dashboard/types';

const counts = { ready: 0, claimed: 0, stale: 0, blocked: 0, conflicts: 0 };

describe('the Attention queue', () => {
  it('reads "Nothing needs you" only when every section was read and holds nothing', () => {
    const quiet: AttentionResult = { items: [], unreadable: [], counts };
    expect(queueSize(quiet, false)).toBe(0);
    expect(emptyState(quiet, false)).toBe(EMPTY);
    expect(emptyState(quiet, true)).toBeNull();
  });

  it('counts a section that couldn’t be read as an item, and never shows the empty state beside it', () => {
    const failed: AttentionResult = { items: [], unreadable: [{ section: 'knowledge', code: 'INTERNAL', message: 'the scanner broke' }], counts };
    expect(queueSize(failed, false)).toBe(1);
    expect(emptyState(failed, false)).toBeNull();
    expect(unreadableTitle('knowledge')).toMatch(/couldn’t read/);
    expect(unreadableTitle('stray_edits')).toMatch(/stray edits/);
  });
});
