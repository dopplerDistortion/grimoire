// `doctor`'s install checks (spec §12 doctor, the install; §11): the pinned
// copy and its integrity, the launcher and the shim's bytes, the Node the
// clients used, pointer drift (content and permission-bearing), hooks
// compared by parsed fields, `.gitattributes`, `AGENTS.md`, client config
// conflicts, stale leases and locks, running servers against the pin,
// duplicate tracker docs and the Codex hook's approval. Everything a release
// ships is compared with what the checkout's manifest says grimoire wrote,
// so only the pinned version's doctor checks it.
import { spawnSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { readCheckoutConfig } from '../core/host';
import { runGit } from '../git/run';
import { readTextIfExists, START_LOCK } from '../machine-local';
import { joinCommand } from './bootstrap';
import { nodeMajor, readClientRuntimes } from './client-runtime';
import { codexHookState, mainCheckout } from './codex-trust';
import { copyDir, verifyCopy } from './copies';
import type { CheckOutcome, DoctorCheck, DoctorInput } from './doctor';
import type { CheckFinding } from './health';
import { inspectLauncher, LAUNCHER_VERSION } from './launcher';
import { CLIENTS, entryIdentity, normalizedText, readManifest, type ClientName, type Manifest } from './manifest';
import { CODEX_MARKER, codexBlockBody, desiredEntries, isContentEntry, isGrimoireHookGroup, type DesiredEntry, type PointerOptions } from './pointers';
import { readJoinRecord } from './records';
import { existingAdapterPlacement } from './refresh';
import { SHIM_PATH, shimText } from './shim';
import { ADAPTER_DOC, ADAPTER_MARKER, markdownMarkers } from './texts';
import { parseToml } from './toml';
import { planFiles, tomlMarkers, type FilePlan } from './writer';

const GITATTRIBUTES_PATH = '.grimoire/.gitattributes';
const GITATTRIBUTES_TEXT = '* text=auto eol=lf\n';
const CLAUDE_SETTINGS = '.claude/settings.json';
const CODEX_CONFIG = '.codex/config.toml';

/** The re-run of `init` that rewrites what grimoire generated (never a changed grant). */
function rerunInit(input: DoctorInput): string {
  return `rerun \`${joinCommand(input.config?.version ?? null)} --yes\`, which rewrites what grimoire generated`;
}

/** Why the install can't be checked by this process, or null. */
function notInstalled(input: DoctorInput): string | null {
  if (input.config === null) return 'grimoire isn’t installed in this checkout (no .grimoire/config.yml)';
  if (input.config.version === null) return '.grimoire/config.yml names no version';
  return null;
}

/** Why what this release ships can't be compared with the checkout here, or null. */
function otherRelease(input: DoctorInput): string | null {
  const missing = notInstalled(input);
  if (missing) return missing;
  if (input.config!.version !== input.version) {
    return `this is grimoire ${input.version} and the checkout pins ${input.config!.version}: run the pinned doctor (node .grimoire/run.cjs doctor) to compare its files`;
  }
  return null;
}

/** What the checkout's manifest says grimoire wrote, as this release writes it. */
interface PointerReview {
  readonly manifest: Manifest;
  readonly clients: ClientName[];
  readonly desired: DesiredEntry[];
  readonly plan: FilePlan;
}

const reviews = new WeakMap<DoctorInput, Promise<PointerReview | { skipped: string }>>();

function identityOf(entry: DesiredEntry): string {
  return entryIdentity(entry);
}

/** The pointer entries the manifest records, planned against the checkout (reads only). */
function reviewPointers(input: DoctorInput): Promise<PointerReview | { skipped: string }> {
  let review = reviews.get(input);
  if (!review) {
    review = (async () => {
      const skip = otherRelease(input);
      if (skip) return { skipped: skip };
      const manifest = await readManifest(input.root);
      if (!manifest.exists) return { skipped: 'the checkout has no .grimoire/manifest.yml (rerun init to write it)' };
      const clients = CLIENTS.filter((client) => manifest.entries.some((entry) => entry.client === client));
      const adapter = manifest.entries.find((entry) => entry.path === ADAPTER_DOC && entry.kind === 'marker-block' && entry.marker === ADAPTER_MARKER);
      let placement: PointerOptions['adapter'] = 'none';
      if (adapter) {
        const doc = await readTextIfExists(path.join(input.root, ADAPTER_DOC));
        placement = doc === undefined ? 'end' : existingAdapterPlacement(doc, adapter.created);
      }
      const recorded = new Set(manifest.entries.map((entry) => entryIdentity(entry)));
      const npmScript = manifest.entries.some((entry) => entry.kind === 'npm-script');
      const desired = desiredEntries({ clients, npmScript, adapter: placement }).filter((entry) => recorded.has(identityOf(entry)));
      return { manifest, clients, desired, plan: await planFiles(input.root, desired) };
    })();
    reviews.set(input, review);
  }
  return review;
}

async function withReview(input: DoctorInput, body: (review: PointerReview) => Promise<CheckFinding[]> | CheckFinding[]): Promise<CheckOutcome> {
  const review = await reviewPointers(input);
  return 'skipped' in review ? review : body(review);
}

function describeEntry(entry: { path: string; item?: string; hook?: string; marker?: string; key?: readonly string[] }): string {
  const what = entry.item ?? entry.hook ?? entry.marker ?? entry.key?.join('.');
  return what ? `${entry.path} (${what})` : entry.path;
}

/** grimoire's block in `.codex/config.toml`, parsed; null when the file or the block isn't there or doesn't parse. */
async function codexBlock(root: string): Promise<Record<string, unknown> | null> {
  const text = await readTextIfExists(path.join(root, CODEX_CONFIG));
  if (text === undefined) return null;
  const { begin, end } = tomlMarkers(CODEX_MARKER);
  const lines = normalizedText(text).split('\n');
  const start = lines.findIndex((line) => line.trim() === begin);
  const stop = lines.findIndex((line, i) => i > start && line.trim() === end);
  if (start < 0 || stop < 0) return null;
  try {
    return parseToml(lines.slice(start + 1, stop).join('\n'));
  } catch {
    return null;
  }
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as object)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** The keys of two objects whose values differ. */
function differingFields(actual: Record<string, unknown>, expected: Record<string, unknown>, prefix = ''): string[] {
  const keys = [...new Set([...Object.keys(actual), ...Object.keys(expected)])].sort();
  return keys.filter((key) => !sameJson(actual[key], expected[key])).map((key) => `${prefix}${key}`);
}

const asObject = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

// ---------------------------------------------------------------------------

const installCopy: DoctorCheck = {
  name: 'install.copy',
  section: 'install',
  async run(input) {
    const skip = notInstalled(input);
    if (skip) return { skipped: skip };
    const pin = input.config!.version!;
    const findings: CheckFinding[] = [];
    const copy = await verifyCopy(input.store, pin);
    const dir = copyDir(input.store, pin);
    if (copy.status === 'missing') {
      findings.push({
        kind: 'copy-missing',
        severity: 'error',
        subject: dir,
        message: `this machine has no complete copy of grimoire ${pin}, the version this checkout pins`,
        remedy: `run \`${joinCommand(pin)}\``,
      });
    } else if (copy.status === 'corrupt') {
      const changes = [...copy.changed.map((f) => `${f} changed`), ...copy.missing.map((f) => `${f} missing`), ...copy.extra.map((f) => `${f} added`)];
      findings.push({
        kind: 'copy-corrupt',
        severity: 'error',
        subject: dir,
        message: `the copy of grimoire ${pin} differs from what was installed: ${changes.slice(0, 5).join(', ')}${changes.length > 5 ? `, and ${changes.length - 5} more` : ''}`,
        remedy: `delete ${dir}, then run \`${joinCommand(pin)}\` to install it again`,
        details: { changed: copy.changed, missing: copy.missing, extra: copy.extra },
      });
    } else if (copy.status === 'unverified') {
      findings.push({
        kind: 'copy-unverified',
        severity: 'info',
        subject: dir,
        message: `the copy of grimoire ${pin} was installed before copies recorded their files, so only its presence is checked`,
      });
    }
    if (!(await readJoinRecord(input.store, pin))) {
      findings.push({
        kind: 'not-joined',
        severity: 'error',
        subject: pin,
        message: `this clone has no join record for grimoire ${pin}, so the launcher won’t run it`,
        remedy: `run \`${joinCommand(pin)}\``,
      });
    }
    return findings;
  },
};

const installLauncher: DoctorCheck = {
  name: 'install.launcher',
  section: 'install',
  async run(input) {
    const skip = notInstalled(input);
    if (skip) return { skipped: skip };
    const launcher = await inspectLauncher(input.store);
    const remedy = `run \`${joinCommand(input.config!.version)}\``;
    if (launcher.status === 'missing') {
      return [{ kind: 'launcher-missing', severity: 'error', subject: 'launcher.cjs', message: 'this clone has no launcher, so no agent client can start grimoire', remedy }];
    }
    if (launcher.status === 'corrupt') {
      return [{ kind: 'launcher-corrupt', severity: 'error', subject: 'launcher.cjs', message: 'the launcher fails its self-check (its header’s hash doesn’t match its text)', remedy }];
    }
    if (launcher.version < LAUNCHER_VERSION) {
      return [{ kind: 'launcher-old', severity: 'info', subject: 'launcher.cjs', message: `the launcher is version ${launcher.version}; this release ships ${LAUNCHER_VERSION}`, remedy }];
    }
    return [];
  },
};

const installShim: DoctorCheck = {
  name: 'install.shim',
  section: 'install',
  async run(input) {
    const skip = otherRelease(input);
    if (skip) return { skipped: skip };
    const bytes = await readFile(path.join(input.root, SHIM_PATH)).catch(() => null);
    if (bytes === null) return [{ kind: 'shim-missing', severity: 'error', subject: SHIM_PATH, message: `${SHIM_PATH} is missing: agents’ CLI calls go through it`, remedy: rerunInit(input) }];
    if (!bytes.equals(Buffer.from(shimText(), 'utf8'))) {
      return [{ kind: 'shim-drift', severity: 'error', subject: SHIM_PATH, message: `${SHIM_PATH} isn’t byte for byte the shim grimoire ${input.version} writes`, remedy: rerunInit(input) }];
    }
    return [];
  },
};

const installNode: DoctorCheck = {
  name: 'install.node',
  section: 'install',
  async run(input) {
    const findings: CheckFinding[] = [];
    for (const runtime of await readClientRuntimes(input.store).catch(() => [])) {
      if (nodeMajor(runtime.node) >= 22) continue;
      findings.push({
        kind: 'node-too-old',
        severity: 'error',
        subject: runtime.client,
        message: `${runtime.client} ran grimoire with Node ${runtime.node} (from ${runtime.path_source}); grimoire needs Node 22 or newer on the PATH that client gives its servers and hooks`,
        remedy: `install Node 22+ where ${runtime.client} finds \`node\`, then restart it`,
        details: { node: runtime.node, path_source: runtime.path_source },
      });
    }
    for (const record of await input.store.processes.live().catch(() => [])) {
      if (nodeMajor(record.node) >= 22 || findings.some((finding) => finding.subject === (record.client ?? record.role))) continue;
      findings.push({
        kind: 'node-too-old',
        severity: 'error',
        subject: record.client ?? record.role,
        message: `a running grimoire ${record.role} (pid ${record.pid}) uses Node ${record.node}; grimoire needs Node 22 or newer`,
        details: { node: record.node, pid: record.pid },
      });
    }
    const onPath = spawnSync('node', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000, env: input.env });
    const version = onPath.status === 0 ? onPath.stdout.trim() : null;
    if (version === null || nodeMajor(version) < 22) {
      findings.push({
        kind: 'node-path',
        severity: 'warning',
        subject: 'PATH',
        message: version === null ? 'no `node` runs from this shell’s PATH; agent clients start grimoire with `node`' : `the \`node\` on this shell’s PATH is ${version}; grimoire needs 22 or newer`,
        remedy: 'install Node 22+ where your agent clients find `node`',
      });
    }
    return findings;
  },
};

const installPointers: DoctorCheck = {
  name: 'install.pointers',
  section: 'install',
  run: (input) =>
    withReview(input, async ({ plan, desired }) => {
      const findings: CheckFinding[] = [];
      const byIdentity = new Map(desired.map((entry) => [identityOf(entry), entry]));
      for (const entry of plan.entries) {
        const wanted = byIdentity.get(entryIdentity(entry));
        if (!wanted || entry.action === 'conflict') continue;
        // Hooks are compared by their fields (install.hooks); run.cjs and .gitattributes byte for byte (their own checks).
        if (entry.hook !== undefined || entry.path === SHIM_PATH || entry.path === GITATTRIBUTES_PATH) continue;
        if (entry.action === 'kept' || (entry.kept_grants?.length ?? 0) > 0) {
          findings.push({
            kind: 'permission-drift',
            severity: 'warning',
            subject: describeEntry(entry),
            message: `${describeEntry(entry)}: ${entry.why ?? 'a grant grimoire wrote changed'}; grimoire keeps it as it is`,
            remedy: 'only an interactive `init` offers to restore it; agents may be asked to approve grimoire’s tools until then',
            details: { grants: entry.kept_grants ? [...entry.kept_grants] : entry.item ? [entry.item] : [] },
          });
        }
        if (entry.kind === 'toml-table') continue;
        if (entry.action !== 'rewrite' && entry.action !== 'update' && entry.action !== 'create' && entry.action !== 'restore') continue;
        if (isContentEntry(wanted)) {
          findings.push({
            kind: 'content-drift',
            severity: 'warning',
            subject: entry.path,
            message: `${describeEntry(entry)} differs from the text grimoire ${input.version} ships`,
            fixable: true,
            remedy: 'grimoire doctor --fix (or upkeep) rewrites it; then commit it',
          });
        } else {
          findings.push({
            kind: 'pointer-drift',
            severity: 'error',
            subject: describeEntry(entry),
            message: `${describeEntry(entry)} ${entry.action === 'create' ? 'is gone' : 'differs from what grimoire wrote'}`,
            remedy: rerunInit(input),
          });
        }
      }
      // The Codex block: its server table here, its grants above, its hook in install.hooks.
      if (desired.some((entry) => entry.kind === 'toml-table')) {
        const block = await codexBlock(input.root);
        const conflicted = plan.entries.some((entry) => entry.kind === 'toml-table' && entry.action === 'conflict');
        const expected = asObject(asObject(parseToml(codexBlockBody()).mcp_servers).grimoire);
        if (block === null && !conflicted) {
          findings.push({ kind: 'pointer-drift', severity: 'error', subject: `${CODEX_CONFIG} (grimoire)`, message: `grimoire’s block in ${CODEX_CONFIG} is gone or doesn’t parse`, remedy: rerunInit(input) });
        } else if (block !== null) {
          const server = { ...asObject(asObject(block.mcp_servers).grimoire) };
          const { default_tools_approval_mode: _theirs, ...rest } = server;
          const { default_tools_approval_mode: _ours, ...wanted } = expected;
          const fields = differingFields(rest, wanted);
          if (fields.length > 0) {
            findings.push({
              kind: 'pointer-drift',
              severity: 'error',
              subject: `${CODEX_CONFIG} (mcp_servers.grimoire)`,
              message: `${CODEX_CONFIG}: grimoire’s server entry differs from what grimoire wrote (${fields.join(', ')})`,
              remedy: rerunInit(input),
              details: { fields },
            });
          }
        }
      }
      return findings;
    }),
};

const installClientConfig: DoctorCheck = {
  name: 'install.client-config',
  section: 'install',
  run: (input) =>
    withReview(input, ({ plan }) =>
      plan.entries
        .filter((entry) => entry.action === 'conflict')
        .map((entry) => ({
          kind: 'client-config-conflict',
          severity: 'error' as const,
          subject: describeEntry(entry),
          message: `${describeEntry(entry)}: ${entry.why ?? 'something grimoire doesn’t own is in the way'}`,
          remedy: 'grimoire never overwrites what it didn’t write: fix the file by hand, then rerun init',
        })),
    ),
};

const installHooks: DoctorCheck = {
  name: 'install.hooks',
  section: 'install',
  run: (input) =>
    withReview(input, async ({ desired }) => {
      const findings: CheckFinding[] = [];
      const claudeHooks = desired.filter((entry): entry is Extract<DesiredEntry, { kind: 'json-array-item' }> => entry.kind === 'json-array-item' && entry.hook !== undefined);
      if (claudeHooks.length > 0) {
        let settings: unknown;
        try {
          settings = JSON.parse(normalizedText((await readTextIfExists(path.join(input.root, CLAUDE_SETTINGS))) ?? 'null'));
        } catch {
          settings = undefined;
        }
        // An unreadable settings file is a client config conflict, reported there.
        if (settings !== undefined) {
          for (const entry of claudeHooks) {
            let groups: unknown = settings;
            for (const key of entry.key) groups = asObject(groups)[key];
            const mine = Array.isArray(groups) ? groups.filter((group) => isGrimoireHookGroup(group, entry.hook!)) : [];
            const subject = `${CLAUDE_SETTINGS} (${entry.key.join('.')})`;
            if (mine.length === 0) {
              findings.push({ kind: 'hook-missing', severity: 'error', subject, message: `${CLAUDE_SETTINGS} has no grimoire ${entry.hook} hook`, remedy: rerunInit(input) });
              continue;
            }
            const group = asObject(mine[0]);
            const expected = asObject(entry.value);
            const fields = differingFields({ ...group, hooks: undefined }, { ...expected, hooks: undefined });
            const handlers = Array.isArray(group.hooks) ? group.hooks : [];
            const wantedHandlers = Array.isArray(expected.hooks) ? expected.hooks : [];
            if (handlers.length !== wantedHandlers.length) fields.push('hooks');
            else handlers.forEach((handler, i) => fields.push(...differingFields(asObject(handler), asObject(wantedHandlers[i]), `hooks[${i}].`)));
            if (mine.length > 1) fields.push('repeated');
            if (fields.length > 0) {
              findings.push({
                kind: 'hook-drift',
                severity: 'error',
                subject,
                message: `${CLAUDE_SETTINGS}: grimoire’s ${entry.hook} hook differs from what grimoire wrote (${fields.join(', ')})`,
                remedy: rerunInit(input),
                details: { hook: entry.hook!, fields },
              });
            }
          }
        }
      }
      if (desired.some((entry) => entry.kind === 'toml-table')) {
        const block = await codexBlock(input.root);
        if (block !== null) {
          const groups = asObject(block.hooks).SessionStart;
          const expected = asObject(parseToml(codexBlockBody()).hooks).SessionStart as unknown[];
          const actualHandlers = Array.isArray(groups) ? groups.flatMap((group) => (Array.isArray(asObject(group).hooks) ? (asObject(group).hooks as unknown[]) : [])) : [];
          const wantedHandlers = expected.flatMap((group) => asObject(group).hooks as unknown[]);
          const fields: string[] = [];
          if (!Array.isArray(groups) || groups.length !== expected.length || actualHandlers.length !== wantedHandlers.length) fields.push('hooks.SessionStart');
          else actualHandlers.forEach((handler, i) => fields.push(...differingFields(asObject(handler), asObject(wantedHandlers[i]), 'hooks.SessionStart.hooks.')));
          if (fields.length > 0) {
            findings.push({
              kind: 'hook-drift',
              severity: 'error',
              subject: `${CODEX_CONFIG} (hooks.SessionStart)`,
              message: `${CODEX_CONFIG}: grimoire’s SessionStart hook differs from what grimoire wrote (${fields.join(', ')}); Codex also asks to approve it again`,
              remedy: rerunInit(input),
              details: { hook: 'session-start', fields },
            });
          }
        }
      }
      return findings;
    }),
};

const installGitattributes: DoctorCheck = {
  name: 'install.gitattributes',
  section: 'install',
  async run(input) {
    const skip = otherRelease(input);
    if (skip) return { skipped: skip };
    const text = await readTextIfExists(path.join(input.root, GITATTRIBUTES_PATH));
    if (text === undefined) {
      return [{ kind: 'gitattributes', severity: 'error', subject: GITATTRIBUTES_PATH, message: `${GITATTRIBUTES_PATH} is missing: grimoire’s files may get CRLF line ends in a checkout`, remedy: rerunInit(input) }];
    }
    if (normalizedText(text) !== GITATTRIBUTES_TEXT) {
      return [{ kind: 'gitattributes', severity: 'error', subject: GITATTRIBUTES_PATH, message: `${GITATTRIBUTES_PATH} should read ${JSON.stringify(GITATTRIBUTES_TEXT)}`, remedy: rerunInit(input) }];
    }
    const attr = await runGit(input.root, ['check-attr', 'eol', '--', '.grimoire/config.yml']);
    const eol = /: eol: (\S+)/.exec(attr.stdout.toString('utf8'))?.[1];
    if (attr.code === 0 && eol !== undefined && eol !== 'lf') {
      return [{ kind: 'gitattributes', severity: 'warning', subject: GITATTRIBUTES_PATH, message: `git checks out .grimoire/ with eol=${eol}: another .gitattributes overrides grimoire’s` }];
    }
    return [];
  },
};

const installAgentsMd: DoctorCheck = {
  name: 'install.agents-md',
  section: 'install',
  run: (input) =>
    withReview(input, async ({ clients }) => {
      if (!clients.includes('codex')) return [];
      const findings: CheckFinding[] = [];
      const agents = await stat(path.join(input.root, 'AGENTS.md')).catch(() => null);
      if (agents && agents.size > 24 * 1024) {
        findings.push({
          kind: 'agents-md-size',
          severity: 'warning',
          subject: 'AGENTS.md',
          message: `AGENTS.md is ${Math.round(agents.size / 1024)} KiB; Codex reads only the first 32 KiB of project docs in all, so grimoire’s block may be cut`,
          remedy: 'shorten AGENTS.md (move detail into linked docs)',
        });
      }
      if (await stat(path.join(input.root, 'AGENTS.override.md')).catch(() => null)) {
        findings.push({
          kind: 'agents-md-override',
          severity: 'warning',
          subject: 'AGENTS.override.md',
          message: 'AGENTS.override.md at the repo root takes the place of AGENTS.md in Codex, so Codex won’t see grimoire’s AGENTS.md block',
          remedy: 'remove AGENTS.override.md, or copy grimoire’s block into it',
        });
      }
      return findings;
    }),
};

const installLocks: DoctorCheck = {
  name: 'install.locks',
  section: 'install',
  async run({ store }) {
    const findings: CheckFinding[] = [];
    for (const { name, state } of await store.leases.list()) {
      if (state.status !== 'expired' || state.holder === null) continue;
      findings.push({
        kind: 'stale-lease',
        severity: 'warning',
        subject: name,
        message: `the lease ${name} was left by pid ${state.holder.pid} on ${state.holder.host}, which lapsed or is gone`,
        fixable: true,
      });
    }
    for (const { name, state } of await store.locks.list()) {
      if (state.status !== 'stale') continue;
      const start = name === START_LOCK;
      findings.push({
        kind: start ? 'stale-start-lock' : 'stale-lock',
        severity: 'warning',
        subject: name,
        message: start
          ? `the start lock names pid ${state.holder?.pid ?? '?'}, which is gone: \`grimoire start\` takes it over anyway`
          : `the lock ${name} was left by pid ${state.holder?.pid ?? '?'}, which is gone`,
        fixable: true,
      });
    }
    return findings;
  },
};

const installServers: DoctorCheck = {
  name: 'install.servers',
  section: 'install',
  async run({ store }) {
    const findings: CheckFinding[] = [];
    for (const record of await store.processes.live()) {
      if ((record.role !== 'mcp' && record.role !== 'start') || record.worktree === null) continue;
      const pin = (await readCheckoutConfig(record.worktree).catch(() => null))?.pin ?? null;
      if (pin === null || pin === record.pin) continue;
      findings.push({
        kind: 'server-pin-mismatch',
        severity: 'warning',
        subject: `pid ${record.pid}`,
        message: `a ${record.client ?? 'client'}’s grimoire ${record.role} (pid ${record.pid}) runs ${record.pin}, but ${record.worktree} now pins ${pin}`,
        remedy: record.role === 'start' ? 'restart `grimoire start`' : `restart that ${record.client ?? 'agent'} session so it runs ${pin}`,
        details: { pid: record.pid, role: record.role, client: record.client, pin: record.pin, worktree: record.worktree, worktree_pin: pin },
      });
    }
    return findings;
  },
};

const installTrackerDocs: DoctorCheck = {
  name: 'install.tracker-docs',
  section: 'install',
  async run(input) {
    const skip = notInstalled(input);
    if (skip) return { skipped: skip };
    const findings: CheckFinding[] = [];
    const { begin } = markdownMarkers(ADAPTER_MARKER);
    const docsDir = path.join(input.root, 'docs', 'agents');
    const docs = (await readdir(docsDir).catch(() => [] as string[])).filter((name) => name.toLowerCase().endsWith('.md')).map((name) => `docs/agents/${name}`);
    const holders: string[] = [];
    for (const file of [...docs, 'AGENTS.md', 'CLAUDE.md']) {
      const text = await readTextIfExists(path.join(input.root, file));
      if (text === undefined) continue;
      const blocks = normalizedText(text).split('\n').filter((line) => line.trim() === begin).length;
      if (blocks > 0) holders.push(file);
      if (blocks > 1) {
        findings.push({ kind: 'duplicate-tracker-doc', severity: 'warning', subject: file, message: `${file} holds grimoire’s issue-tracker block ${blocks} times`, remedy: 'keep one block' });
      }
    }
    if (holders.length > 1) {
      findings.push({
        kind: 'duplicate-tracker-doc',
        severity: 'warning',
        subject: holders.join(', '),
        message: `grimoire’s issue-tracker block is in ${holders.join(' and ')}; agents read one tracker doc`,
        remedy: `keep it in ${ADAPTER_DOC} only`,
      });
    }
    if (input.config?.adapter === 'grimoire') {
      const others = docs.filter((file) => /^docs\/agents\/issue-tracker.+\.md$/i.test(file) && file.toLowerCase() !== ADAPTER_DOC);
      for (const file of others) {
        findings.push({
          kind: 'duplicate-tracker-doc',
          severity: 'warning',
          subject: file,
          message: `${file} describes a tracker too, beside ${ADAPTER_DOC}, which makes grimoire the tracker; an agent may follow either`,
          remedy: `remove ${file}, or fold what it still says into ${ADAPTER_DOC}`,
        });
      }
    }
    return findings;
  },
};

const installCodexHook: DoctorCheck = {
  name: 'install.codex-hook',
  section: 'install',
  run: (input) =>
    withReview(input, async ({ clients }) => {
      if (!clients.includes('codex')) return [];
      const join = await readJoinRecord(input.store, input.config!.version!).catch(() => null);
      const state = await codexHookState(input.root, input.dirs, input.env, join?.codex_hook_hash ?? null);
      const findings: CheckFinding[] = [];
      const main = mainCheckout(input.root, input.dirs);
      if (state.trust === 'missing') {
        if (main !== input.root) {
          findings.push({
            kind: 'codex-main-checkout',
            severity: 'warning',
            subject: state.declaring_file,
            message: `Codex runs the main checkout’s .codex/config.toml in every linked worktree, and ${state.declaring_file} has no grimoire hook group`,
            remedy: `run grimoire init in ${main} too`,
          });
        }
        return findings;
      }
      if (state.trust === 'needs-approval' || state.trust === 'modified') {
        findings.push({
          kind: state.trust === 'modified' ? 'codex-hook-modified' : 'codex-hook-unapproved',
          severity: 'warning',
          subject: state.key ?? state.declaring_file,
          message: state.summary,
          remedy: 'open Codex in this repo, run `/hooks`, and approve grimoire’s SessionStart hook',
          details: { position: state.position, key: state.key, declared_hash: state.declared_hash, expected_hash: state.expected_hash },
        });
      } else if (state.trust === 'unknown') {
        findings.push({ kind: 'codex-hook-unknown', severity: 'info', subject: state.declaring_file, message: state.summary });
      }
      if (state.last === false) {
        findings.push({
          kind: 'codex-hook-position',
          severity: 'info',
          subject: state.declaring_file,
          message: `grimoire’s SessionStart group is group ${state.position} of ${state.declaring_file}, not the last; groups added before it change its trust key, so Codex asks to approve it again`,
        });
      }
      return findings;
    }),
};

/** The install checks, in report order. */
export const INSTALL_CHECKS: readonly DoctorCheck[] = [
  installCopy,
  installLauncher,
  installShim,
  installNode,
  installPointers,
  installHooks,
  installGitattributes,
  installAgentsMd,
  installClientConfig,
  installLocks,
  installServers,
  installTrackerDocs,
  installCodexHook,
];
