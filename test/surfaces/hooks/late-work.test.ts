// How a hook process ends (spec §11: the clients give a hook 10 s). A hook
// that stopped waiting for work at its budget (session-start's chore facts)
// has said all it will: that work, still running git, must not keep the
// process alive past the clients' timeout, or the client drops the line the
// hook already wrote.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { exitWith } from '../../../src/surfaces/entry';
import { lateWork, leftRunning } from '../../../src/surfaces/hooks/late';

describe('ending a verb’s process', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('with nothing left running, it gives open handles up to 5 s to settle', () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    exitWith(0);

    vi.advanceTimersByTime(4_999);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledOnce();
  });

  it('with work a hook stopped waiting for, it ends at once, with the hook’s code', async () => {
    let finish!: () => void;
    const work = new Promise<void>((resolve) => (finish = resolve));
    leftRunning(work);
    expect(lateWork()).toBe(1);
    vi.useFakeTimers();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    exitWith(0);

    vi.advanceTimersByTime(0);
    expect(exit).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(0);
    vi.useRealTimers();
    finish();
    await work;
    await new Promise((resolve) => setImmediate(resolve));
    expect(lateWork()).toBe(0);
  });

  it('work left running that fails is no unhandled rejection', async () => {
    let fail!: (error: Error) => void;
    leftRunning(new Promise<void>((_, reject) => (fail = reject)));
    fail(new Error('git died'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(lateWork()).toBe(0);
  });
});
