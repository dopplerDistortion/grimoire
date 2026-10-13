// Seam 1 for `init` (spec Testing Decisions; §11, §12): the installer's runInit
// driven directly, in process, against temporary clones with a bare remote.
// The version copy comes from a small package folder, so no build is needed;
// the packed package as npx installs it is seam 3 (init.test.ts).
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect } from 'vitest';
import { gitTest } from '#harness';
import { BOOTSTRAP, readJoinRecord } from '../../src/installer';
import { MachineLocalStore } from '../../src/machine-local';
import { initializeTracker } from '../core/support';
import { VERSION, initIn, installAndPush, replaceTrackerOnRemote, rootsAt } from './init-rules-support';

describe('the tracker root R', () => {
  gitTest('with R named, a remote tracker with another root stops init even though the local one holds R, and nothing is written', async ({ world }) => {
    const { trackerRoot } = await installAndPush(world.a);
    await world.b.git(['pull', '--quiet', 'origin', 'main']);
    await world.b.git(['fetch', '--quiet', 'origin', '+refs/heads/grimoire/tracker:refs/grimoire/tracker']);
    // Someone ran init --new-tracker elsewhere; this checkout hasn't merged their config.yml yet.
    const otherRoot = await replaceTrackerOnRemote(world.a);

    const refused = initIn(world.b.dir);

    await expect(refused).rejects.toMatchObject({ code: 'NOT_SYNCED', details: { tracker_root: trackerRoot, found: [otherRoot] } });
    expect(await rootsAt(world.b, 'refs/grimoire/tracker')).toEqual([trackerRoot]);
    expect(existsSync(path.join(world.b.dir, '.git', 'grimoire'))).toBe(false);
  });

  gitTest('with R named, a local tracker with another root stops init even though the remote one holds R', async ({ world }) => {
    const { trackerRoot } = await installAndPush(world.a);
    await world.b.git(['pull', '--quiet', 'origin', 'main']);
    const localRoot = await initializeTracker(world.b, world.b);

    const refused = initIn(world.b.dir);

    await expect(refused).rejects.toMatchObject({ code: 'NOT_SYNCED', details: { tracker_root: trackerRoot, found: [localRoot] } });
    expect(existsSync(path.join(world.b.dir, '.git', 'grimoire'))).toBe(false);
  });

  gitTest('a first install with a kept local tracker never adopts it while the remote can’t be read: its tracker might have another root', async ({ world }) => {
    await initializeTracker(world.a, world.a);
    await world.a.git(['remote', 'set-url', 'origin', path.join(world.root, 'gone.git')]);

    const refused = initIn(world.a.dir);

    await expect(refused).rejects.toMatchObject({ code: 'NOT_SYNCED', details: { remote: 'origin', remedy: expect.any(String) } });
    expect(existsSync(path.join(world.a.dir, '.grimoire'))).toBe(false);
    expect(existsSync(path.join(world.a.dir, '.git', 'grimoire'))).toBe(false);
  });

  gitTest('--new-tracker never folds the old history back in, even when the remote’s branch is gone and this clone still tracks it', async ({ world }) => {
    const { trackerRoot: oldRoot } = await installAndPush(world.a);
    // Someone deleted the remote's branch to start over; clone a still has its remote-tracking ref.
    await world.b.git(['push', '--quiet', 'origin', ':refs/heads/grimoire/tracker']);

    const { report } = await initIn(world.a.dir, {
      flags: { newTracker: true },
      answers: [
        { when: /Type new-tracker to confirm/, type: 'new-tracker' },
        { when: /Configure which agent clients\?/, type: '' },
        { when: /Excerpt mode for the new tracker\?/, type: 'none' },
        { when: /Go ahead\?/, type: 'y' },
      ],
    });

    expect(report.tracker).toMatchObject({ action: 'replaced', sync: 'pushed' });
    const newRoot = report.tracker.root!;
    expect(newRoot).not.toBe(oldRoot);
    expect(await rootsAt(world.a, 'refs/grimoire/tracker')).toEqual([newRoot]);
    const remoteTip = (await world.a.git(['ls-remote', 'origin', 'refs/heads/grimoire/tracker'])).split('\t')[0]!;
    expect(await rootsAt(world.a, remoteTip)).toEqual([newRoot]);
  });
});

describe('a join', () => {
  gitTest('a first install adopts the tracker another clone minted without committing, keeping its excerpt mode under --yes', async ({ world }) => {
    const minted = await initIn(world.a.dir, { flags: { excerpts: 'excerpts' } });
    const trackerRoot = minted.report.tracker.root!;

    const { report } = await initIn(world.b.dir);

    expect(report.tracker).toMatchObject({ action: 'adopted', root: trackerRoot, excerpt_mode: 'excerpts' });
    expect(report.disclosure[0]).toBe('Excerpt mode: excerpts.');
    expect(await readJoinRecord(new MachineLocalStore(path.join(world.b.dir, '.git')), VERSION)).toMatchObject({ excerpt_mode: 'excerpts' });
    expect(await readFile(path.join(world.b.dir, '.grimoire/config.yml'), 'utf8')).toMatch(new RegExp(`^tracker_root: ${trackerRoot}$`, 'm'));
    const remoteTip = (await world.b.git(['ls-remote', 'origin', 'refs/heads/grimoire/tracker'])).split('\t')[0]!;
    expect(await rootsAt(world.b, remoteTip)).toEqual([trackerRoot]);
    expect(await world.b.git(['show', `${remoteTip}:settings.yml`])).toMatch(/^excerpts: \{"value":"excerpts",/m);
  });

  gitTest('a join at a terminal into a store that captures excerpts offers this machine’s cap, and changes no checkout file', async ({ world }) => {
    await installAndPush(world.a, { excerpts: 'excerpts' });
    await world.b.git(['pull', '--quiet', 'origin', 'main']);

    const { report } = await initIn(world.b.dir, {
      answers: [
        { when: /Configure which agent clients\?/, type: '' },
        { when: /The most this machine’s sessions may capture\?/, type: 'none' },
        { when: /Go ahead\?/, type: 'y' },
      ],
    });

    expect(report.tracker).toMatchObject({ action: 'present', excerpt_mode: 'excerpts' });
    expect(report.machine).toMatchObject({ excerpts_max: 'none' });
    expect(await new MachineLocalStore(path.join(world.b.dir, '.git')).records.read('machine-settings', 'capture.excerpts_max')).toBe('none');
    expect(report.written).toEqual([]);
  });
});

describe('the clients', () => {
  gitTest('--clients narrows what is written; a join and a re-run under --yes keep to the clients the manifest records and write nothing in the checkout', async ({ world }) => {
    const { report } = await installAndPush(world.a, { clients: ['codex'] });
    expect(report.clients).toEqual(['codex']);
    for (const file of ['.mcp.json', '.claude', 'CLAUDE.md']) expect(existsSync(path.join(world.a.dir, file)), file).toBe(false);
    expect(existsSync(path.join(world.a.dir, '.codex/config.toml'))).toBe(true);
    await world.b.git(['pull', '--quiet', 'origin', 'main']);

    const joined = await initIn(world.b.dir);
    const rerun = await initIn(world.a.dir);

    expect(joined.report.clients).toEqual(['codex']);
    expect(joined.report.written).toEqual([]);
    expect(rerun.report.written).toEqual([]);
    expect(existsSync(path.join(world.b.dir, '.claude'))).toBe(false);
    expect(await world.b.git(['status', '--porcelain', '--untracked-files=all'])).toBe('');
    // Any other MCP client gets the server command itself, not a file this checkout lacks.
    expect(joined.said).toContain(`node -e "${BOOTSTRAP}" mcp`);
    expect(joined.said).not.toContain('.mcp.json');
  });
});

describe('changed permission entries', () => {
  gitTest('a removed Codex block comes back without its grant, which init reports as GRANT_CHANGED and an interactive init offers to restore', async ({ world }) => {
    const root = world.a.dir;
    await initIn(root);
    await writeFile(path.join(root, '.codex/config.toml'), '# no grimoire here\n');

    const { report } = await initIn(root);

    expect(report.warnings).toContainEqual({ code: 'GRANT_CHANGED', message: expect.stringContaining('.codex/config.toml') });
    expect(report.written).toContain('.codex/config.toml');
    expect(await readFile(path.join(root, '.codex/config.toml'), 'utf8')).not.toContain('default_tools_approval_mode');

    await writeFile(path.join(root, '.codex/config.toml'), '# no grimoire here\n');
    const { said } = await initIn(root, {
      answers: [
        { when: /Configure which agent clients\?/, type: '' },
        { when: /permission entries changed.*\.codex\/config\.toml.*Restore them\?/s, type: 'yes' },
        { when: /Go ahead\?/, type: 'y' },
      ],
    });

    expect(said).toMatch(/Restore them\?/);
    expect(await readFile(path.join(root, '.codex/config.toml'), 'utf8')).toContain('default_tools_approval_mode = "approve"');
  });
});
