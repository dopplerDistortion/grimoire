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
});
