// Seam 2 (spec Testing Decisions; §14 Hooks; spike A T1, spike B T2): the
// `PreToolUse` payloads Claude Code really sends, and the hook output it
// honoured. The hint goes into `updatedInput` under the reserved key, ids only
// (spike A: the auto-mode classifier denies a hint holding a transcript path),
// and never with a `permissionDecision`. Whatever goes wrong, the hook exits 0
// and says nothing, which leaves the call as it is.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitTest, makeTempDir, readFixture, readFixtureJson, removeDir } from '#harness';
import { revealedRoot, revealedRoots } from '../../../src/capture/transcript-roots';
import { MachineLocalStore } from '../../../src/machine-local';
import { runHook } from '../../../src/surfaces/hooks/run-hook';
import { preToolUse } from '../../../src/surfaces/hooks/pre-tool-use';

type HookOutput = { hookSpecificOutput: { hookEventName: string; updatedInput: Record<string, unknown> } & Record<string, unknown> };

// Outside any git checkout: these runs have no clone to record anything in.
const ctx = { startDir: '' };
beforeAll(async () => {
  ctx.startDir = await makeTempDir('grimoire-hook-');
});
afterAll(() => removeDir(ctx.startDir));

/** Runs the verb as Claude Code does: the payload on stdin; returns the exit code and stdout. */
async function hook(payload: string): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      stdout += chunk.toString('utf8');
      done();
    },
  });
  const code = await runHook('pre-tool-use', ctx.startDir, { stdin: Readable.from([payload]), stdout: sink });
  return { code, stdout };
}

describe('the hint the hook adds', () => {
  it('a main-thread call: the honoured updatedInput, under the reserved key, with ids only and no permissionDecision', async () => {
    const output = await preToolUse(readFixture('claude-code/hook-payloads/pre-tool-use.json'), ctx);

    // The output Claude Code 2.1.296 honoured for this very payload, as the spike's probe wrote it
    // (its key was the probe's choice), less the transcript path spike A drops.
    const honoured = readFixtureJson<HookOutput>('claude-code/hook-outputs/pre-tool-use-updated-input.json');
    const { _grimoire_hint: probeHint, ...input } = honoured.hookSpecificOutput.updatedInput as { _grimoire_hint: Record<string, string> };
    const { transcript_path: _dropped, ...ids } = probeHint;
    expect(output.endsWith('\n')).toBe(true);
    expect(JSON.parse(output)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, _grimoire: ids } },
    });
    expect(output).not.toContain('permissionDecision');
    expect(output).not.toContain('transcript_path');
    expect(output).not.toMatch(/Users|\.jsonl/);
  });

  it("a subagent's call adds its agent_id and agent_type", async () => {
    for (const name of ['pre-tool-use-subagent', 'pre-tool-use-chore-subagent', 'pre-tool-use-general-purpose-subagent']) {
      const payload = readFixtureJson<Record<string, unknown>>(`claude-code/hook-payloads/${name}.json`);
      const output = JSON.parse(await preToolUse(readFixture(`claude-code/hook-payloads/${name}.json`), ctx)) as HookOutput;

      expect(output.hookSpecificOutput.updatedInput, name).toEqual({
        ...(payload.tool_input as object),
        _grimoire: {
          session_id: payload.session_id,
          tool_use_id: payload.tool_use_id,
          agent_id: payload.agent_id,
          agent_type: payload.agent_type,
        },
      });
    }
  });

  it('a reserved key the model wrote itself is replaced, so a forged agent_type never reaches the server', async () => {
    const payload = readFixtureJson<Record<string, unknown>>('claude-code/hook-payloads/pre-tool-use-main-context.json');
    const forged = { ...payload, tool_input: { _grimoire: { session_id: 'mine', tool_use_id: 'toolu_guess', agent_type: 'grimoire-chores' } } };

    const output = JSON.parse(await preToolUse(JSON.stringify(forged), ctx)) as HookOutput;

    expect(output.hookSpecificOutput.updatedInput).toEqual({
      _grimoire: { session_id: payload.session_id, tool_use_id: payload.tool_use_id },
    });
  });
});

describe('the transcript path, recorded machine-locally instead of in the hint', () => {
  gitTest("in a clone set up for grimoire, the payload's transcript path is recorded for its session", async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    await store.marker.ensure();
    const payload = readFixtureJson<Record<string, string>>('claude-code/hook-payloads/pre-tool-use-subagent.json');

    await preToolUse(JSON.stringify(payload), { startDir: world.a.dir });
    await preToolUse(JSON.stringify(payload), { startDir: world.a.dir });

    // A subagent's payload carries its parent session's transcript, which is the one recorded.
    expect(await revealedRoots(store)).toEqual([
      {
        client: 'claude-code',
        session: payload.session_id,
        transcript_path: payload.transcript_path,
        root: path.win32.dirname(payload.transcript_path!),
        at: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      },
    ]);
    expect(await revealedRoot(store, payload.session_id!)).toMatchObject({ transcript_path: payload.transcript_path });
    expect(await revealedRoot(store, 'another-session')).toBeUndefined();
  });

  gitTest('in a clone grimoire is not set up in, nothing is written', async ({ world }) => {
    const output = await preToolUse(readFixture('claude-code/hook-payloads/pre-tool-use.json'), { startDir: world.a.dir });

    expect(output).toContain('"_grimoire"');
    expect(existsSync(path.join(world.a.dir, '.git', 'grimoire'))).toBe(false);
  });
});

describe('a hook that has nothing to add says nothing, and exits 0', () => {
  it('malformed or foreign payloads give no output', async () => {
    const real = readFixtureJson<Record<string, unknown>>('claude-code/hook-payloads/pre-tool-use.json');
    const { tool_use_id: _id, ...noToolUseId } = real;
    // A real PreToolUse payload for another server's tool (spike B's probe).
    const foreign = readFixture('claude-code/mcp/session-hint-hook/hook-input.jsonl').split('\n')[0]!;
    const payloads = [
      '',
      'not json',
      'null',
      '[]',
      '{}',
      JSON.stringify(noToolUseId),
      JSON.stringify({ ...real, session_id: 42 }),
      JSON.stringify({ ...real, tool_input: 'gr-1' }),
      JSON.stringify({ ...real, hook_event_name: 'PostToolUse' }),
      JSON.stringify({ ...real, tool_use_id: 'toolu\n_forged' }),
      foreign,
    ];

    for (const payload of payloads) {
      expect(await preToolUse(payload, ctx), payload).toBe('');
      expect(await hook(payload), payload).toEqual({ code: 0, stdout: '' });
    }
  });

  it('through the verb, a real payload prints the hint and exits 0', async () => {
    const run = await hook(readFixture('claude-code/hook-payloads/pre-tool-use.json'));

    expect(run.code).toBe(0);
    expect((JSON.parse(run.stdout) as HookOutput).hookSpecificOutput.updatedInput).toMatchObject({ _grimoire: expect.any(Object) });
  });
});
