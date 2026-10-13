// The format freeze at the first publish (GOK-172; spec §21): 1.0.0 ships
// store format 1, machine-local format 1 and install_format 1, and the frozen
// cross-pin contract (docs/cross-pin-contract.md) in exactly these shapes.
// A failure here is never fixed by updating the expected value inside a major:
// read the release promise and the nine rules in the README first.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { INSTALL_FORMAT_RANGE } from '../../src/core/host';
import { BOOTSTRAP, claudeHookArgs, codexHookCommand, MCP_ENTRY_ARGS } from '../../src/installer/bootstrap';
import { INSTALL_FORMAT } from '../../src/installer/config';
import { COMPLETE_MARKER, COPY_ENTRY, PACKAGE_NAME } from '../../src/installer/copies';
import { ENTRY_KINDS, MANIFEST_FORMAT } from '../../src/installer/manifest';
import { JOIN_RECORDS } from '../../src/installer/records';
import { SHIM_PATH, shimText } from '../../src/installer/shim';
import { pathListFile } from '../../src/generated/path-list';
import { MachineLocalStore, START_LOCK } from '../../src/machine-local';
import { MACHINE_FORMAT_RANGE } from '../../src/machine-local/marker';
import { CONTROL_PROTOCOL } from '../../src/surfaces/start/control';
import { TRACKER_FORMAT_RANGE } from '../../src/tracker/marker';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('the formats 1.0.0 declares', () => {
  test('store format 1, machine-local format 1 and install_format 1, each with J = K = 1', () => {
    expect(TRACKER_FORMAT_RANGE).toEqual({ J: 1, K: 1 });
    expect(MACHINE_FORMAT_RANGE).toEqual({ J: 1, K: 1 });
    expect(INSTALL_FORMAT_RANGE).toEqual({ J: 1, K: 1 });
    expect(INSTALL_FORMAT).toBe(1);
    expect(MANIFEST_FORMAT).toBe(1);
  });
});

describe('the frozen cross-pin contract, version 1', () => {
  test('the bootstrap string and the client entries that carry it', () => {
    expect(sha256(BOOTSTRAP)).toBe('e45aee8c70fef1898db10390417f079c6000ecddff8c8a259f395ed385bfcd18');
    expect(MCP_ENTRY_ARGS).toEqual(['-e', BOOTSTRAP, 'mcp']);
    expect(claudeHookArgs('session-start')).toEqual(['-e', BOOTSTRAP, '--', '--from', '${CLAUDE_PROJECT_DIR}', 'hook', 'session-start']);
    expect(claudeHookArgs('pre-tool-use')).toEqual(['-e', BOOTSTRAP, '--', '--from', '${CLAUDE_PROJECT_DIR}', 'hook', 'pre-tool-use']);
    expect(codexHookCommand()).toBe(`node -e "${BOOTSTRAP}" -- hook session-start`);
  });

  test('the shell shim, whose bytes install_format covers and whose `pin` verb CI reads', () => {
    expect(SHIM_PATH).toBe('.grimoire/run.cjs');
    expect(sha256(shimText())).toBe('623141c20dd27913eb27c3f25e3c08b10954380400121034da8ad36fb4a5395c');
  });

  test('the launcher↔package contract: pkg/<version>/, its entry and its .complete marker', () => {
    expect(PACKAGE_NAME).toBe('@goksening/grimoire');
    expect(COPY_ENTRY).toBe(path.join('dist', 'launch.mjs'));
    expect(COMPLETE_MARKER).toBe('.complete');
  });

  test('the manifest entry kinds, a closed set', () => {
    expect([...ENTRY_KINDS]).toEqual(['file', 'json-key', 'json-array-item', 'toml-table', 'marker-block', 'npm-script', 'seeded-file']);
  });

  test('where the join records, the start lock, the control channel and the generated-path list live', () => {
    const store = new MachineLocalStore(path.join('repo', '.git'));
    expect(JOIN_RECORDS).toBe('join');
    expect(START_LOCK).toBe('start');
    expect(CONTROL_PROTOCOL).toBe(1);
    expect(pathListFile(store)).toBe(path.join(store.dir, 'records', 'generated-paths.txt'));
  });
});
