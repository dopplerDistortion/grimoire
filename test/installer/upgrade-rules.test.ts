// Seam 1 for `init --upgrade` (spec Testing Decisions; §21 Upgrade; §5): the
// installer's runInit driven in process at two versions, against temporary
// clones with a bare remote. The version copies come from small package
// folders, so no build is needed; two packed releases are seam 3
// (upgrade.test.ts).
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { gitTest, type Checkout, type Clone } from '#harness';
import { readPerson } from '../../src/core/host';
import { listCopies, readJoinRecord, UPGRADE_RECORDS } from '../../src/installer';
import { runDoctor } from '../../src/installer/doctor';
import { runInit, type InitFlags, type InitOptions, type InitReport, type Prompter } from '../../src/installer/init';
import { MachineLocalStore } from '../../src/machine-local';
import { reportingPackage } from './support';

const OLD = '1.0.0-test.4';
const NEW = '1.0.0-test.5';

const NO_FLAGS: InitFlags = { yes: true, clients: null, excerpts: null, newTracker: false, adapter: false, upgrade: false };

interface InitRun {
  readonly report: InitReport;
  readonly said: string;
}

/** `npx @goksening/grimoire@<version> init …` in `root`, in process; with `answers`, at a terminal. */
async function initAt(
  root: string,
  version: string,
  options: { flags?: Partial<InitFlags>; answers?: { when: RegExp; type: string }[]; extra?: Partial<InitOptions> } = {},
): Promise<InitRun> {
  const said: string[] = [];
  const answers = options.answers ? [...options.answers] : null;
  const prompter: Prompter | null = answers
    ? {
        async ask(question) {
          said.push(question);
          const at = answers.findIndex((answer) => answer.when.test(question));
          if (at < 0) throw new Error(`unexpected question: ${question}`);
          return answers.splice(at, 1)[0]!.type;
        },
      }
    : null;
  const report = await runInit({
    root,
    flags: { ...NO_FLAGS, yes: answers === null, ...options.flags },
    source: { dir: await reportingPackage(path.dirname(root), version), integrity: null },
    version,
    person: await readPerson(root),
    nonce: 'test',
    prompter,
    say: (text) => said.push(text),
    ...options.extra,
  });
  return { report, said: said.join('\n') };
}

/** Installs OLD in `clone`, then commits and pushes what init wrote. */
async function installOld(clone: Clone): Promise<void> {
  await initAt(clone.dir, OLD);
  await clone.git(['add', '-A']);
  await clone.git(['commit', '--quiet', '-m', 'install grimoire']);
  await clone.git(['push', '--quiet', 'origin', 'main']);
}

async function changedPaths(checkout: Checkout): Promise<string[]> {
  const out = await checkout.git(['status', '--porcelain', '--untracked-files=all']);
  return out === '' ? [] : out.split('\n').map((line) => line.slice(3)).sort();
}

const pinOf = async (root: string) => /^version: (.+)$/m.exec(await readFile(path.join(root, '.grimoire/config.yml'), 'utf8'))?.[1];

describe('init --upgrade', () => {
  gitTest('moves the checkout to the new pin, installs and joins the new copy, and reports exactly the paths to commit', async ({ world }) => {
    await installOld(world.a);
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));

    const { report, said } = await initAt(world.a.dir, NEW, { flags: { upgrade: true } });

    expect(await pinOf(world.a.dir)).toBe(NEW);
    expect(report.upgrade).toMatchObject({ from: OLD, to: NEW, direction: 'upgrade' });
    expect(report.upgrade!.commit.paths).toEqual(await changedPaths(world.a));
    expect(report.upgrade!.commit.paths).toEqual(['.grimoire/config.yml']);
    expect(report.upgrade!.commit.command).toBe('git add .grimoire/config.yml && git commit -m "Upgrade grimoire to 1.0.0-test.5"');
    expect(said).toContain(report.upgrade!.commit.command);
    expect((await listCopies(store)).map((copy) => copy.version)).toEqual([OLD, NEW]);
    expect(await readJoinRecord(store, NEW)).toBeDefined();
    // Done: the upgrade-in-progress record is gone.
    expect(await store.coordination.list(UPGRADE_RECORDS)).toEqual([]);
  });

  gitTest('interrupted after step 2, it is finished by the same command; meanwhile an old-pin init and doctor --fix skip the worktree with the message', async ({ world }) => {
    await installOld(world.a);
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    const crash = new Error('the process died after step 2');

    const interrupted = initAt(world.a.dir, NEW, { flags: { upgrade: true }, extra: { onUpgradeStep: (step) => { if (step === 2) throw crash; } } });
    await expect(interrupted).rejects.toBe(crash);

    // The machine side is done, the checkout still pins OLD, and the record says an upgrade is under way.
    expect(await pinOf(world.a.dir)).toBe(OLD);
    expect(await changedPaths(world.a)).toEqual([]);
    expect(await store.coordination.list(UPGRADE_RECORDS)).toEqual([{ key: expect.any(String), value: expect.objectContaining({ from: OLD, to: NEW }) }]);
    const finish = `finish with \`npx @goksening/grimoire@${NEW} init --upgrade\`, or discard with \`git restore\``;
    const oldInit = initAt(world.a.dir, OLD);
    await expect(oldInit).rejects.toMatchObject({ code: 'INVALID', message: expect.stringContaining(finish) });
    const oldDoctor = await runDoctor({ root: world.a.dir, version: OLD, fix: true, env: { ...process.env, CODEX_HOME: path.join(world.root, 'codex-home') } });
    expect(oldDoctor.fix?.notices).toContainEqual(expect.stringContaining(finish));
    expect(await pinOf(world.a.dir)).toBe(OLD);

    const { report } = await initAt(world.a.dir, NEW, { flags: { upgrade: true } });

    expect(report.upgrade).toMatchObject({ from: OLD, to: NEW, resumed: true });
    expect(await pinOf(world.a.dir)).toBe(NEW);
    expect(report.upgrade!.commit.paths).toEqual(['.grimoire/config.yml']);
    expect(await store.coordination.list(UPGRADE_RECORDS)).toEqual([]);
    // Once it is done, the old pin's init is back to naming the pin.
    await expect(initAt(world.a.dir, OLD)).rejects.toMatchObject({ code: 'INVALID', details: { pin: NEW, running: OLD } });
  });

  gitTest('--yes never raises compat: a release that needs the store at a newer compat refuses before anything is written', async ({ world }) => {
    await installOld(world.a);
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    // A later release whose oldest runnable store format is 2: running it needs a migration that raises compat.
    const later = { store: { J: 2, K: 2 }, machine: { J: 1, K: 1 }, install: { J: 1, K: 1 } };

    const refused = initAt(world.a.dir, NEW, { flags: { upgrade: true }, extra: { formats: later } });

    await expect(refused).rejects.toMatchObject({
      code: 'INVALID',
      message: expect.stringContaining('--yes never raises compat'),
      details: { markers: [expect.objectContaining({ marker: 'store', compat: 1, verdict: 'compat-raise' })] },
    });
    expect(await pinOf(world.a.dir)).toBe(OLD);
    expect(await changedPaths(world.a)).toEqual([]);
    expect((await listCopies(store)).map((copy) => copy.version)).toEqual([OLD]);
    expect(await store.coordination.list(UPGRADE_RECORDS)).toEqual([]);
  });

  gitTest('a downgrade runs the same command and keeps the newer launcher; one to a release that can’t run against the markers refuses', async ({ world }) => {
    await installOld(world.a);
    await initAt(world.a.dir, NEW, { flags: { upgrade: true } });
    const store = new MachineLocalStore(path.join(world.a.dir, '.git'));
    // A launcher newer than this release's: it never moves back.
    const launcher = path.join(store.dir, 'launcher.cjs');
    const { createHash } = await import('node:crypto');
    const { writeFile } = await import('node:fs/promises');
    const current = await readFile(launcher, 'utf8');
    const body = current.slice(current.indexOf('\n') + 1).replace(/^const LAUNCHER_VERSION = (\d+);$/m, (_, n: string) => `const LAUNCHER_VERSION = ${Number(n) + 1};`);
    const newer = `// grimoire-launcher ${Number(/^const LAUNCHER_VERSION = (\d+);$/m.exec(body)![1])} ${createHash('sha256').update(body, 'utf8').digest('hex')}\n${body}`;
    await writeFile(launcher, newer);
    // An older release that only understood a store format below the one this store is at.
    const older = { store: { J: 0, K: 0 }, machine: { J: 1, K: 1 }, install: { J: 1, K: 1 } };

    const refused = initAt(world.a.dir, OLD, { flags: { upgrade: true }, extra: { formats: older } });
    await expect(refused).rejects.toMatchObject({ code: 'UPGRADE_REQUIRED', details: { marker: 'store', why: 'newer', running: OLD, pin: NEW } });
    expect(await pinOf(world.a.dir)).toBe(NEW);

    const { report } = await initAt(world.a.dir, OLD, { flags: { upgrade: true } });

    expect(report.upgrade).toMatchObject({ from: NEW, to: OLD, direction: 'downgrade' });
    expect(await pinOf(world.a.dir)).toBe(OLD);
    expect(report.machine?.launcher).toBe('kept');
    expect(await readFile(launcher, 'utf8')).toBe(newer);
    expect(existsSync(path.join(store.dir, 'pkg', OLD, '.complete'))).toBe(true);
  });
});
