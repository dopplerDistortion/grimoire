// A launched `grimoire mcp` registers a process record (role `mcp`) before it
// knows its client; the server's first request names the client, and the
// record then carries it (spec §6 process records, §7 Actors: the client comes
// from `clientInfo`).
import path from 'node:path';
import { describe, expect } from 'vitest';
import { gitTest } from '#harness';
import { MachineLocalStore } from '../../../src/machine-local';
import { noteServerClient, recordServer } from '../../../src/surfaces/mcp/process-record';

describe('the server process record', () => {
  gitTest('starts without a client, and names the first one the server learns, once', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    await noteServerClient('before-any-record');

    await recordServer({ home: store.dir, root: world.a.dir });
    expect((await store.processes.live({ role: 'mcp' })).map((record) => record.client)).toEqual([null]);

    await noteServerClient('claude-code');
    await noteServerClient('someone-else');

    const [record] = await store.processes.live({ role: 'mcp' });
    expect(record).toMatchObject({ pid: process.pid, client: 'claude-code', worktree: world.a.dir });
    await store.processes.prune();
  });
});
