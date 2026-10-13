// A launched `grimoire mcp` registers a process record (role `mcp`) before it
// knows its client; the server's first request names the client, and the
// record then carries it (spec §6 process records, §7 Actors: the client comes
// from `clientInfo`). The record says which Node runs the server and where
// the client's PATH found it, and that client's runtime is kept past the
// server's exit for `status` and `doctor` (spec §11 Node).
import path from 'node:path';
import { describe, expect } from 'vitest';
import { gitTest } from '#harness';
import { readClientRuntimes } from '../../../src/installer/client-runtime';
import { MachineLocalStore } from '../../../src/machine-local';
import { noteServerClient, recordServer } from '../../../src/surfaces/mcp/process-record';
import { VERSION } from '../../../src/version';

describe('the server process record', () => {
  gitTest('starts without a client, and names the first one the server learns, once, keeping its Node and PATH source', async ({ world }) => {
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    await noteServerClient('before-any-record');

    await recordServer({ home: store.dir, root: world.a.dir });
    expect((await store.processes.live({ role: 'mcp' })).map((record) => record.client)).toEqual([null]);

    await noteServerClient('claude-code');
    await noteServerClient('someone-else');

    const [record] = await store.processes.live({ role: 'mcp' });
    expect(record).toMatchObject({ pid: process.pid, client: 'claude-code', worktree: world.a.dir, node: process.version, path_source: path.dirname(process.execPath) });
    const [registration] = await store.processes.list();
    await import('node:fs/promises').then((fs) => fs.rm(path.join(store.dir, 'processes', `${registration!.record.pid}-${registration!.record.nonce}.json`)));
    expect(await store.processes.live({ role: 'mcp' })).toEqual([]);
    expect(await readClientRuntimes(store)).toEqual([
      expect.objectContaining({ client: 'claude-code', node: process.version, path_source: path.dirname(process.execPath), pin: VERSION }),
    ]);
  });
});
