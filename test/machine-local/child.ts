// The child-process entry for the machine-local store's cross-process tests
// (bundled by child-process.ts). argv[2] is a JSON action; the child prints
// one JSON line with its result.
import { setTimeout as sleep } from 'node:timers/promises';
import { locateMachineLocalStore, type Json } from '../../src/machine-local';

type Action =
  | { action: 'race-lease'; from: string; name: string; ttlMs: number; goAt: number }
  | { action: 'hold-lease'; from: string; name: string; ttlMs: number }
  | { action: 'hold-lock'; from: string; name: string; data?: { [key: string]: Json } }
  | { action: 'count'; from: string; kind: string; key: string; times: number }
  | {
      action: 'register';
      from: string;
      client: string;
      worktree: string;
      pin: string;
      pathSource: string;
    };

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function waitUntil(at: number): Promise<void> {
  const ms = at - Date.now();
  if (ms > 20) await sleep(ms - 20);
  while (Date.now() < at) {
    // spin for the last few milliseconds, so every child starts together
  }
}

function stayAlive(): void {
  setInterval(() => {}, 1 << 30);
}

async function main(action: Action): Promise<void> {
  const store = await locateMachineLocalStore(action.from);
  if (!store) throw new Error(`no machine-local store at ${action.from}`);

  switch (action.action) {
    case 'race-lease': {
      await waitUntil(action.goAt);
      const result = await store.leases.acquire(action.name, { ttlMs: action.ttlMs });
      print({
        status: result.status,
        owner: result.status === 'acquired' ? result.lease.holder.owner : result.holder.owner,
      });
      stayAlive();
      return;
    }
    case 'hold-lease': {
      const result = await store.leases.acquire(action.name, { ttlMs: action.ttlMs });
      print({ status: result.status });
      stayAlive();
      return;
    }
    case 'hold-lock': {
      const result = await store.locks.acquire(action.name, action.data ? { data: action.data } : {});
      print({ status: result.status });
      stayAlive();
      return;
    }
    case 'count': {
      for (let i = 0; i < action.times; i++) {
        await store.coordination.update<number>(action.kind, action.key, (n) => (n ?? 0) + 1);
      }
      print({ done: true });
      return;
    }
    case 'register': {
      const registration = await store.processes.register({
        role: 'mcp',
        client: action.client,
        worktree: action.worktree,
        pin: action.pin,
        pathSource: action.pathSource,
      });
      print(registration.record);
      stayAlive();
      return;
    }
  }
}

main(JSON.parse(process.argv[2]!) as Action).catch((error: unknown) => {
  process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
  process.exit(1);
});
