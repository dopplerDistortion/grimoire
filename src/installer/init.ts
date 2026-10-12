// `init` (spec §12, init in order; §11 for what it writes): a person installs
// grimoire into a host repo, or joins a clone, as the version they run. It is
// the only networked step besides sync.
//
//  1. The gate (agent markers, a terminal or --yes) is the CLI's (../surfaces/cli/init.ts).
//  2. A read-only preflight: the remote, an explicit tracker fetch (a failed
//     one never means "the remote has none"), Node, the git identity, the
//     clients, the adapter doc, and the plan of every file against the
//     manifest.
//  3. The plan, the grants, the excerpt disclosure, the storage notices and
//     the next steps, then one consent (--yes gives it up front).
//  4. The tracker, keyed on root R: adopt, mint (seeding the full settings,
//     then push or leave it sync-pending), or report it missing.
//  5. The version copy, the launcher and the join record.
//  6. The dotfolder and pointer files, the manifest, then config.yml last:
//     the commit point for this worktree.
//  7. Upkeep, forced: every part runs (copy pruning, pending syncs, content
//     pointer refresh, and what later releases add).
//  8. The report: what was written, the next steps, machine checks.
//
// Every refusal comes before step 4, so a refused init changes nothing.
import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Identity } from '../core/context';
import { putMachineSetting, seedStoreSettings, storeExcerptMode, type ExcerptMode } from '../core/settings';
import { syncNow } from '../core/sync';
import { GrimoireError, type ErrorBody } from '../errors';
import { findGitDirs, MachineLocalStore, readTextIfExists } from '../machine-local';
import { openTracker, type Person } from '../tracker';
import { MCP_ENTRY_ARGS, joinCommand } from './bootstrap';
import { CONFIG_PATH, INSTALL_FORMAT, readInstallConfig, sameInstall, serializeInstallConfig, type AdapterDecision, type InstallConfig } from './config';
import { installCopy, listCopies, type CopySource } from './copies';
import { inspectLauncher, installLauncher, LAUNCHER_VERSION } from './launcher';
import { CLIENTS, normalizedText, readManifest, type ClientName } from './manifest';
import { codexHookHash, desiredEntries, type PointerOptions } from './pointers';
import {
  dropStaleRemoteTracker,
  fetchTracker,
  holdsRoot,
  listRemote,
  readRemotes,
  replaceRemoteTracker,
  restoreTrackerRef,
  rootOf,
  saveRemote,
  trackerTips,
  type RemoteFailure,
  type RemoteListing,
  type Remotes,
} from './preflight';
import { readJoinRecord, writeJoinRecord, type JoinRecord } from './records';
import { existingAdapterPlacement } from './refresh';
import { holdWorktreeLease, runUpkeep, type UpkeepReport } from '../upkeep';
import { ADAPTER_DOC, ADAPTER_MARKER, markdownMarkers } from './texts';
import { applyFiles, planFiles, tomlMarkers, writePlanned, type FilePlan, type PlannedEntry } from './writer';

export interface InitFlags {
  /** Take the safe defaults and ask nothing. */
  readonly yes: boolean;
  /** `--clients`: the clients to configure (default: both). */
  readonly clients: readonly ClientName[] | null;
  /** `--excerpts <mode>`: the mode a minted tracker gets. */
  readonly excerpts: ExcerptMode | null;
  /** `--new-tracker`: mint a new root even when a tracker exists (interactive, typed). */
  readonly newTracker: boolean;
  /** `--adapter`: ask about the adapter doc again after a decline. */
  readonly adapter: boolean;
}

/** The person at an interactive terminal. */
export interface Prompter {
  /** One line of input; null when the person closed the prompt (Ctrl-C, Ctrl-D). */
  ask(question: string): Promise<string | null>;
}

export interface InitOptions {
  /** The checkout's root (the first ancestor of the start directory that holds `.git`). */
  readonly root: string;
  readonly flags: InitFlags;
  /** The running package: what the version copy is installed from. */
  readonly source: CopySource;
  /** The running version: the pin a first install writes. */
  readonly version: string;
  readonly person: Identity;
  /** This process's nonce, for the actor of the tracker's first commit. */
  readonly nonce: string;
  /** Null under --yes: nothing is asked. */
  readonly prompter: Prompter | null;
  /** The human-readable plan and summary (stderr); a no-op under --json. */
  readonly say: (text: string) => void;
  /** Stop after the plan (--json without --yes): ask nothing, write nothing. */
  readonly dryRun?: boolean;
}

export type TrackerAction = 'minted' | 'replaced' | 'adopted' | 'present' | 'missing';

export interface MachineResult {
  copy: 'installed' | 'present';
  launcher: 'written' | 'replaced' | 'kept';
  join_record: 'written' | 'updated' | 'unchanged';
  excerpts_max?: ExcerptMode;
  pruned: string[];
}

export interface InitReport {
  version: string;
  root: string;
  /** A plan only: --json without --yes writes nothing. */
  dry_run?: true;
  remote: { name: string | null; url: string | null; saved: boolean };
  tracker: {
    action: TrackerAction;
    /** The tracker root R. */
    root: string | null;
    /** The store's excerpt mode, as shown in the disclosure; null while the tracker isn't here. */
    excerpt_mode: ExcerptMode | null;
    /** After a mint: whether the remote got it. */
    sync?: 'pushed' | 'in-sync' | 'pending';
    sync_reason?: string;
    failure?: RemoteFailure;
  };
  clients: ClientName[];
  adapter: AdapterDecision | null;
  disclosure: string[];
  storage_notices: string[];
  plan: { files: PlannedEntry[]; config: 'create' | 'update' | 'unchanged'; machine: MachinePlan };
  /** Checkout files written, in order: pointer and dotfolder files, the manifest, config.yml last. */
  written: string[];
  /** Planned writes left undone because the file changed meanwhile. */
  skipped: { path: string; why: string }[];
  /** What init did on this machine; null for a plan only (--json without --yes). */
  machine: MachineResult | null;
  /** What upkeep did at the end (step 7); absent for a plan only. */
  upkeep?: UpkeepReport;
  warnings: { code: string; message: string }[];
  next_steps: string[];
  machine_checks: { node: { running: string; on_path: string | null } };
  /** For any other MCP client: the stdio server command, run from the repo root. */
  generic_mcp: { command: string; args: string[] };
  docs: string[];
  /** Set when init finished everything it could but the tracker isn't here (NOT_SYNCED). */
  error?: ErrorBody;
}

interface MachinePlan {
  copy: 'install' | 'present';
  launcher: 'write' | 'replace' | 'keep';
  join_record: 'write' | 'update' | 'unchanged';
}

type TrackerPlan =
  | { readonly action: 'mint'; readonly mode: ExcerptMode }
  | { readonly action: 'replace'; readonly mode: ExcerptMode; readonly remoteTip: string | null }
  | { readonly action: 'adopt'; readonly root: string }
  | { readonly action: 'present'; readonly root: string }
  | { readonly action: 'missing'; readonly root: string; readonly failure: RemoteFailure | null };

const DOCS = ['https://www.npmjs.com/package/@goksening/grimoire'];

/** The canceled answer: a refusal before anything was written. */
function canceled(what: string): GrimoireError {
  return new GrimoireError('INVALID', `init was canceled at ${what}; nothing changed`, { fields: { confirmation: 'not given' } });
}

/** Asks until the answer is one of `choices` (empty: `fallback`). */
async function choose<T extends string>(prompter: Prompter, question: string, choices: readonly T[], fallback: T, aliases: Record<string, T> = {}): Promise<T> {
  for (;;) {
    const answer = await prompter.ask(`${question} [${choices.join('/')}] (default: ${fallback}) `);
    if (answer === null) throw canceled(question.replace(/[?:]$/, ''));
    const word = answer.trim().toLowerCase();
    if (word === '') return fallback;
    const picked = (choices as readonly string[]).includes(word) ? (word as T) : aliases[word];
    if (picked) return picked;
  }
}

/** Whether the tracker history at `tip` holds root R. */
async function holds(root: string, tip: string | null, trackerRoot: string): Promise<boolean> {
  return tip !== null && (await holdsRoot(root, tip, trackerRoot));
}

/**
 * The remote the tracker goes to (spec §12 step 2), asking only when several
 * remotes hold none. The choice is saved as `grimoire.remote` whenever sync's
 * own rule (grimoire.remote, else a remote with a tracker, else `origin`)
 * might pick another: a lone remote not named `origin` is saved too.
 */
async function chooseRemote(root: string, remotes: Remotes, prompter: Prompter | null): Promise<{ name: string | null; save: boolean; listing: RemoteListing | null }> {
  if (remotes.chosen !== null) return { name: remotes.chosen, save: false, listing: null };
  if (remotes.names.length <= 1) {
    const name = remotes.names[0] ?? null;
    return { name, save: name !== null && name !== 'origin', listing: null };
  }
  const listings = new Map<string, RemoteListing>();
  for (const name of remotes.names) listings.set(name, await listRemote(root, name, remotes));
  const holding = remotes.names.filter((name) => {
    const listing = listings.get(name)!;
    return listing.reachable && listing.tracker !== null;
  });
  if (holding.length > 0) {
    const name = holding.includes('origin') ? 'origin' : holding[0]!;
    // A stale remote-tracking tracker of another remote would win sync's choice over a remote not named origin.
    return { name, save: name !== 'origin', listing: listings.get(name)! };
  }
  const unreachable = remotes.names.filter((name) => !listings.get(name)!.reachable);
  if (unreachable.length > 0) {
    throw new GrimoireError('NOT_SYNCED', `init couldn't reach ${unreachable.join(', ')} to see which remote holds the tracker; nothing changed`, {
      unreachable: Object.fromEntries(unreachable.map((name) => [name, (listings.get(name) as { failure: RemoteFailure }).failure])),
      remedy: 'rerun init when every remote is reachable, or name the tracker’s remote with `git config grimoire.remote <name>`',
    });
  }
  const fallback = remotes.names.includes('origin') ? 'origin' : remotes.names[0]!;
  const name = prompter
    ? await choose(prompter, 'This clone has several remotes and none holds a grimoire tracker. Which remote should grimoire push grimoire/tracker to?', remotes.names, fallback)
    : fallback;
  return { name, save: true, listing: listings.get(name)! };
}

/**
 * The clients the person wants: --clients, the prompt, or by default both. A
 * checkout grimoire is installed in defaults to the clients its manifest
 * records, so a join or a re-run writes nothing; otherwise what the repo has
 * pre-selects the prompt's answer.
 */
async function chooseClients(root: string, flags: InitFlags, prompter: Prompter | null): Promise<ClientName[]> {
  if (flags.clients !== null) return [...flags.clients];
  const { entries } = await readManifest(root);
  const recorded = CLIENTS.filter((client) => entries.some((entry) => entry.client === client));
  if (!prompter) return recorded.length > 0 ? recorded : [...CLIENTS];
  const has = async (file: string) => (await stat(path.join(root, file)).catch(() => null)) !== null;
  const claude = recorded.length > 0 ? recorded.includes('claude-code') : (await has('.claude')) || (await has('CLAUDE.md'));
  const codex = recorded.length > 0 ? recorded.includes('codex') : (await has('.codex')) || (await has('AGENTS.md'));
  const fallback = claude === codex ? 'both' : claude ? 'claude-code' : 'codex';
  const answer = await choose(prompter, 'Configure which agent clients?', ['both', 'claude-code', 'codex'] as const, fallback, { claude: 'claude-code' });
  return answer === 'both' ? [...CLIENTS] : [answer];
}

/** The excerpt mode a mint seeds: --excerpts, the prompt (default `excerpts`), or `facts` unasked. */
async function chooseMode(flags: InitFlags, prompter: Prompter | null, say: (text: string) => void): Promise<ExcerptMode> {
  if (flags.excerpts !== null) return flags.excerpts;
  if (!prompter) return 'facts';
  say(disclosureLines(null).slice(1).join('\n'));
  return choose(prompter, 'Excerpt mode for the new tracker?', ['excerpts', 'facts', 'none'] as const, 'excerpts');
}

/** The adapter doc block: written, offered, or declined (spec §11, Adapter doc and seeds). */
async function chooseAdapter(
  root: string,
  flags: InitFlags,
  previous: AdapterDecision | null,
  prompter: Prompter | null,
): Promise<{ placement: PointerOptions['adapter']; decision: AdapterDecision }> {
  const doc = await readTextIfExists(path.join(root, ADAPTER_DOC));
  const { begin } = markdownMarkers(ADAPTER_MARKER);
  if (doc === undefined) return { placement: 'end', decision: 'grimoire' };
  if (normalizedText(doc).split('\n').some((line) => line.trim() === begin)) {
    // The block is there: a superseding one stays superseding.
    const { entries } = await readManifest(root);
    const recorded = entries.find((entry) => entry.path === ADAPTER_DOC && entry.kind === 'marker-block' && entry.marker === ADAPTER_MARKER);
    return { placement: existingAdapterPlacement(doc, recorded?.created ?? null), decision: 'grimoire' };
  }
  if ((previous === 'declined' && !flags.adapter) || !prompter) return { placement: 'none', decision: 'declined' };
  const answer = await choose(
    prompter,
    `${ADAPTER_DOC} describes another tracker. Make grimoire the tracker (its block goes at the top and supersedes the rest), or decline (not asked again unless you run init --adapter)?`,
    ['make', 'decline'] as const,
    'decline',
  );
  return answer === 'make' ? { placement: 'top', decision: 'grimoire' } : { placement: 'none', decision: 'declined' };
}

/** The excerpt disclosure (spec §12 step 3), shown on every init. */
export function disclosureLines(mode: ExcerptMode | null): string[] {
  return [
    mode === null ? 'Excerpt mode: not known until this clone has the tracker.' : `Excerpt mode: ${mode}.`,
    'In `excerpts` mode, redacted excerpts of agent transcripts are committed to grimoire/tracker and pushed while the attempt is still open.',
    'Redaction is best-effort: a secret can slip through.',
    'Pushed history can’t be purged.',
    'The modes: `excerpts` (redacted excerpt text plus facts), `facts` (names, versions, hashes, times and statuses, never excerpt text) and `none` (never opens a transcript). A person changes it with `grimoire settings set excerpts <mode>` or in the dashboard.',
  ];
}

function storageNotices(remote: string | null): string[] {
  return [
    remote === null
      ? 'grimoire keeps the branch grimoire/tracker; once this clone has a remote, grimoire pushes it there.'
      : `grimoire pushes the branch grimoire/tracker to ${remote}.`,
    'Branch rulesets, required checks and preview deploys must exempt grimoire/tracker.',
    'Optional: a GitHub autolink for the prefix `gr-` turns issue ids in commits and PRs into links.',
  ];
}

/** The node an agent client finds on PATH, by its version, or null when none runs. */
function nodeOnPath(): string | null {
  const run = spawnSync('node', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  return run.status === 0 ? run.stdout.trim() : null;
}

function majorOf(version: string): number {
  return Number(/^v?(\d+)/.exec(version)?.[1] ?? 0);
}

/**
 * The MCP server command for any other client, as one shell line. The
 * bootstrap avoids `$ " \ % ^` and backticks, so double quotes carry it
 * unchanged through sh, cmd and PowerShell.
 */
function genericMcpCommand(): string {
  return ['node', ...MCP_ENTRY_ARGS].map((arg) => (/^[\w./-]+$/.test(arg) ? arg : `"${arg}"`)).join(' ');
}

/** A planned entry that keeps a grant the person changed or removed: reported, and restored only on request. */
function keepsGrant(entry: PlannedEntry): boolean {
  return entry.action === 'kept' || (entry.kept_grants?.length ?? 0) > 0;
}

function describeEntry(entry: PlannedEntry): string {
  const what = entry.item ?? entry.hook ?? entry.marker ?? entry.key?.join('.');
  return `${entry.action.padEnd(9)} ${entry.path}${what ? ` (${what})` : ''}${entry.why ? `: ${entry.why}` : ''}`;
}

function trackerLine(plan: TrackerPlan, remote: string | null, listing: RemoteListing | null): string {
  switch (plan.action) {
    case 'mint': {
      const then = !remote
        ? 'keep it sync-pending (no remote)'
        : listing?.reachable && listing.head === null
          ? `keep it sync-pending: ${remote} has no default branch yet`
          : `push it to ${remote}`;
      return `mint a new tracker with excerpt mode ${plan.mode}, then ${then}`;
    }
    case 'replace':
      return `mint a NEW tracker root with excerpt mode ${plan.mode}${plan.remoteTip && remote ? `, replacing grimoire/tracker on ${remote}` : ''}`;
    case 'adopt':
      return `adopt the existing tracker (root ${plan.root.slice(0, 12)})`;
    case 'present':
      return `use the tracker this checkout names (root ${plan.root.slice(0, 12)})`;
    case 'missing':
      return `the tracker this checkout names (root ${plan.root.slice(0, 12)}) isn't in this clone: everything else is set up, and init reports NOT_SYNCED`;
  }
}

/** Runs init; refusals throw before anything is written. */
export async function runInit(o: InitOptions): Promise<InitReport> {
  const { root, flags, version, prompter, say } = o;
  const dirs = await findGitDirs(root);
  if (!dirs) throw new GrimoireError('NO_REPO', `no git repository at ${root}`, { root });
  const store = new MachineLocalStore(dirs.commonDir);
  const existing = await readInstallConfig(root);

  // A checkout pinned to another version: that version's init is the one to run.
  if (existing !== null && existing.version !== null && existing.version !== version) {
    const command = joinCommand(existing.version);
    throw new GrimoireError(
      'INVALID',
      `this checkout pins grimoire ${existing.version}, and this is ${version}: run \`${command}\` (moving the pin is \`init --upgrade\`); nothing changed`,
      { pin: existing.version, running: version, command },
    );
  }

  const warnings: InitReport['warnings'] = [];
  const warn = (code: string, message: string) => warnings.push({ code, message });

  // 2. Preflight: the remote, what it holds, and the tracker refs here.
  const remotes = await readRemotes(root);
  const remote = await chooseRemote(root, remotes, prompter);
  let failure: RemoteFailure | null = null;
  let listing = remote.listing;
  if (remote.name !== null) {
    listing ??= await listRemote(root, remote.name, remotes);
    if (!listing.reachable) failure = listing.failure;
    else if (listing.tracker !== null) failure = await fetchTracker(root, remote.name, remotes);
  }
  const tips = await trackerTips(root, remote.name);
  const named = existing?.tracker_root ?? null;

  let trackerPlan: TrackerPlan;
  if (flags.newTracker) {
    if (!prompter) throw new GrimoireError('HUMAN_ONLY', 'init --new-tracker runs only at an interactive terminal, with a typed confirmation', {});
    if (failure && remote.name !== null) {
      throw new GrimoireError('NOT_SYNCED', `init couldn't reach ${remote.name} (${failure.message}); nothing changed`, { failure, remedy: 'rerun init --new-tracker when the remote is reachable' });
    }
    const remoteTip = listing?.reachable ? listing.tracker : null;
    const replaced = [tips.local, remoteTip].filter((tip): tip is string => tip !== null);
    const answer = await prompter.ask(
      [
        'init --new-tracker mints a new tracker root for this repo instead of adopting the tracker it has.',
        replaced.length > 0 ? `The tracker here${remoteTip && remote.name ? ` and grimoire/tracker on ${remote.name}` : ''} will be replaced; the old history stays in this clone's reflog and in other clones.` : '',
        'Every other clone must take the new .grimoire/config.yml by merge to follow it.',
        'Type new-tracker to confirm (anything else cancels): ',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    );
    if (answer?.trim() !== 'new-tracker') throw canceled('the new-tracker confirmation');
    trackerPlan = { action: 'replace', mode: 'facts', remoteTip };
  } else if (named !== null) {
    // Every tracker ref here must hold R: a sync would fold one with another root into it.
    const here = [tips.local, tips.remote].filter((tip): tip is string => tip !== null);
    const strays: string[] = [];
    for (const tip of here) if (!(await holds(root, tip, named))) strays.push(tip);
    if (here.length === 0) {
      trackerPlan = { action: 'missing', root: named, failure };
    } else if (strays.length === 0) {
      trackerPlan = { action: 'present', root: named };
    } else {
      const found = [...new Set(await Promise.all(strays.map((tip) => rootOf(root, tip))))];
      throw new GrimoireError(
        'NOT_SYNCED',
        `.grimoire/config.yml names the tracker with root ${named}, but ${strays.length === here.length ? 'this clone’s tracker refs hold' : strays[0] === tips.local ? 'this clone’s local tracker holds' : `${remote.name}’s tracker holds`} another (root ${found.join(', ')}); nothing changed`,
        { tracker_root: named, found, remedy: 'check out the branch whose config.yml names that tracker, or ask whoever ran init --new-tracker' },
      );
    }
  } else {
    if (failure && remote.name !== null) {
      // Unread, the remote might hold a tracker with another root than a kept local one: never "none".
      throw new GrimoireError(
        'NOT_SYNCED',
        `init couldn't see whether ${remote.name} holds a grimoire tracker (${failure.message}); a failed fetch never counts as "none", so nothing changed`,
        { remote: remote.name, failure, remedy: 'rerun init when the remote is reachable' },
      );
    }
    const localRoot = tips.local === null ? null : await rootOf(root, tips.local);
    const remoteRoot = tips.remote === null ? null : await rootOf(root, tips.remote);
    if (localRoot !== null && remoteRoot !== null && localRoot !== remoteRoot) {
      throw new GrimoireError(
        'NOT_SYNCED',
        `this clone keeps a local tracker (root ${localRoot}) and ${remote.name} holds another (root ${remoteRoot}); init stops rather than pick one, and nothing changed`,
        { local_root: localRoot, remote_root: remoteRoot, remedy: 'keep one: delete refs/grimoire/tracker to adopt the remote’s, or run init --new-tracker' },
      );
    }
    const adopted = localRoot ?? remoteRoot;
    trackerPlan = adopted !== null ? { action: 'adopt', root: adopted } : { action: 'mint', mode: 'facts' };
  }

  const minting = trackerPlan.action === 'mint' || trackerPlan.action === 'replace';
  if (o.person.email === null) {
    if (minting) {
      throw new GrimoireError('NO_GIT_IDENTITY', `git user.email is not set in ${root}, so init can't commit the new tracker; nothing changed`, {
        name: o.person.name,
        email: o.person.email,
      });
    }
    warn('NO_GIT_IDENTITY', `git user.email is not set in ${root}: grimoire's writes will fail until it is`);
  }

  // The questions, then the plan.
  const clients = await chooseClients(root, flags, prompter);
  let mode: ExcerptMode | null;
  if (trackerPlan.action === 'mint' || trackerPlan.action === 'replace') {
    mode = await chooseMode(flags, prompter, say);
    trackerPlan = { ...trackerPlan, mode };
  } else if (trackerPlan.action === 'missing') {
    mode = null;
  } else {
    const tracker = await openTracker(root);
    try {
      mode = storeExcerptMode(await tracker.read());
    } finally {
      await tracker.close();
    }
  }
  const adapter = await chooseAdapter(root, flags, existing?.adapter ?? null, prompter);
  const npmScript = (await stat(path.join(root, 'package.json')).catch(() => null))?.isFile() === true;
  const pointerOptions: PointerOptions = { clients, npmScript, adapter: adapter.placement };
  let filePlan: FilePlan = await planFiles(root, desiredEntries(pointerOptions));
  const kept = filePlan.entries.filter(keepsGrant);
  if (kept.length > 0 && prompter) {
    const restore = await choose(
      prompter,
      `These permission entries changed since grimoire wrote them: ${kept.map((entry) => `${entry.path} (${entry.item ?? entry.why})`).join('; ')}. Restore them?`,
      ['no', 'yes'] as const,
      'no',
      { n: 'no', y: 'yes' },
    );
    if (restore === 'yes') filePlan = await planFiles(root, desiredEntries(pointerOptions), { restoreGrants: true });
  }
  for (const entry of filePlan.entries) {
    if (entry.action === 'conflict') warn('CONFLICT', `${entry.path} left untouched: ${entry.why}`);
    if (keepsGrant(entry)) warn('GRANT_CHANGED', `${entry.path}: ${entry.why}; kept as it is (an interactive init offers to restore it)`);
  }

  // The machine side.
  const copyPresent = (await listCopies(store)).some((copy) => copy.version === version);
  const launcher = await inspectLauncher(store);
  const join = await readJoinRecord(store, version);
  const codexHash = clients.includes('codex') ? codexHookHash() : (join?.codex_hook_hash ?? null);
  const joinRecord: JoinRecord = { excerpt_mode: mode ?? 'unknown', codex_hook_hash: codexHash, joined_at: join?.joined_at ?? Date.now() };
  const joinAction: MachinePlan['join_record'] = !join ? 'write' : join.excerpt_mode !== joinRecord.excerpt_mode || join.codex_hook_hash !== codexHash ? 'update' : 'unchanged';
  const announceCodex = clients.includes('codex') && join?.codex_hook_hash !== codexHash;
  const machinePlan: MachinePlan = {
    copy: copyPresent ? 'present' : 'install',
    launcher: launcher.status === 'intact' && launcher.version >= LAUNCHER_VERSION ? 'keep' : launcher.status === 'missing' ? 'write' : 'replace',
    join_record: joinAction,
  };
  let excerptsMax: ExcerptMode | undefined;
  if (mode === 'excerpts' && !join && prompter) {
    const answer = await choose(prompter, 'The tracker captures excerpts. The most this machine’s sessions may capture?', ['excerpts', 'facts', 'none'] as const, 'excerpts');
    if (answer !== 'excerpts') excerptsMax = answer;
  }

  const config: InstallConfig = {
    version,
    install_format: INSTALL_FORMAT,
    tracker_root: trackerPlan.action === 'mint' || trackerPlan.action === 'replace' ? '' : trackerPlan.root,
    adapter: adapter.decision,
  };
  const configAction: InitReport['plan']['config'] = !existing ? 'create' : !minting && sameInstall(existing, config) ? 'unchanged' : 'update';

  // Checks that only warn.
  const running = process.version;
  const onPath = nodeOnPath();
  if (onPath === null) warn('NODE_PATH', 'no `node` runs from this PATH; agent clients start grimoire with `node`, so install Node 22 or newer where they find it');
  else if (majorOf(onPath) < 22) warn('NODE_PATH', `the \`node\` on this PATH is ${onPath}; grimoire needs Node 22 or newer where agent clients find it`);
  if (clients.includes('codex')) {
    if (await stat(path.join(root, 'AGENTS.override.md')).catch(() => null)) {
      warn('AGENTS_OVERRIDE', 'AGENTS.override.md at the repo root takes the place of AGENTS.md in Codex, so Codex won’t see grimoire’s AGENTS.md block');
    }
    const agents = filePlan.writes.find((write) => write.path === 'AGENTS.md')?.after ?? (await readTextIfExists(path.join(root, 'AGENTS.md')));
    if (agents !== undefined && Buffer.byteLength(agents, 'utf8') > 24 * 1024) {
      warn('AGENTS_SIZE', 'AGENTS.md is over 24 KiB; Codex reads only the first 32 KiB of project docs in all, so grimoire’s block may be cut');
    }
    if (dirs.gitDir !== dirs.commonDir && path.basename(dirs.commonDir) === '.git') {
      const main = await readTextIfExists(path.join(path.dirname(dirs.commonDir), '.codex', 'config.toml'));
      if (!main?.includes(tomlMarkers('grimoire').begin)) {
        warn('CODEX_MAIN_CHECKOUT', 'Codex runs the main checkout’s .codex/config.toml in every linked worktree, and it has no grimoire block yet: run init in the main checkout too');
      }
    }
  }

  // 3. The plan and the one consent.
  const disclosure = disclosureLines(mode);
  const notices = storageNotices(remote.name);
  const plannedFiles = [
    ...filePlan.writes.map((write) => write.path),
    ...(filePlan.manifestWrite ? [filePlan.manifestWrite.path] : []),
    ...(configAction !== 'unchanged' ? [CONFIG_PATH] : []),
  ];
  const anyWrite =
    minting ||
    plannedFiles.length > 0 ||
    remote.save ||
    machinePlan.copy === 'install' ||
    machinePlan.launcher !== 'keep' ||
    joinAction !== 'unchanged' ||
    excerptsMax !== undefined;
  const nextSteps = (written: readonly string[]): string[] => {
    const steps: string[] = [];
    if (written.length > 0) steps.push(`Commit what init wrote: ${written.join(', ')}.`);
    if (clients.includes('claude-code')) {
      steps.push(
        'Claude Code: trust this workspace once (start `claude` here and accept the trust prompt). Headless runs (`claude -p`, the SDK) ignore .claude/settings.json’s allow list in a folder never trusted: pass `--allowedTools mcp__grimoire`, add a user-level allow rule, or trust the folder once interactively.',
      );
    }
    if (clients.includes('codex')) {
      steps.push(
        `Codex: trust this project${announceCodex ? ', then approve grimoire’s hook in `/hooks`. Codex will skip grimoire’s hook until you approve it in `/hooks`, once per clone of this repo; Codex runs the main checkout’s .codex/ in every linked worktree' : ''}.`,
      );
    }
    steps.push(
      'Restart open Claude Code and Codex sessions so they load grimoire.',
      `Launch agent clients from the repo root (${root}).`,
      'Use `git stash -u`, never `git stash --all`: grimoire’s generated skill copies are git-ignored, and `--all` would stash them.',
    );
    return steps;
  };
  const tracker: InitReport['tracker'] = {
    action: trackerPlan.action === 'mint' ? 'minted' : trackerPlan.action === 'replace' ? 'replaced' : trackerPlan.action === 'adopt' ? 'adopted' : trackerPlan.action,
    root: trackerPlan.action === 'mint' || trackerPlan.action === 'replace' ? null : trackerPlan.root,
    excerpt_mode: mode,
  };
  if (tracker.action === 'missing' && failure) tracker.failure = failure;
  const report = (done: Pick<InitReport, 'written' | 'skipped' | 'machine' | 'next_steps'>): InitReport => ({
    version,
    root,
    ...(o.dryRun ? { dry_run: true } : {}),
    remote: { name: remote.name, url: remote.name === null ? null : (remotes.urls.get(remote.name) ?? null), saved: remote.save && !o.dryRun },
    tracker,
    clients,
    adapter: adapter.decision,
    disclosure: disclosureLines(mode),
    storage_notices: notices,
    plan: { files: [...filePlan.entries], config: configAction, machine: machinePlan },
    ...done,
    warnings,
    machine_checks: { node: { running, on_path: onPath } },
    generic_mcp: { command: 'node', args: [...MCP_ENTRY_ARGS] },
    docs: DOCS,
  });

  say(
    [
      `grimoire ${version} init in ${root}`,
      `Tracker: ${trackerLine(trackerPlan, remote.name, listing)}`,
      `This machine: ${machinePlan.copy === 'install' ? `install version copy ${version}` : `version copy ${version} is installed`}; launcher ${machinePlan.launcher}; join record ${joinAction}`,
      'Files:',
      ...filePlan.entries.map((entry) => `  ${describeEntry(entry)}`),
      `  ${configAction.padEnd(9)} ${CONFIG_PATH} (last)`,
      'Grants: Claude Code gets permissions.allow mcp__grimoire and enabledMcpjsonServers grimoire; Codex gets default_tools_approval_mode = "approve" for grimoire’s server.',
      'Excerpts:',
      ...disclosure.map((line) => `  ${line}`),
      'Storage:',
      ...notices.map((line) => `  ${line}`),
      'Next steps once it is done:',
      ...nextSteps(plannedFiles).map((step) => `  - ${step}`),
      ...(warnings.length > 0 ? ['Warnings:', ...warnings.map((w) => `  ${w.code}: ${w.message}`)] : []),
    ].join('\n'),
  );
  // `--json` without `--yes`: the plan as JSON, and nothing written.
  if (o.dryRun) return report({ written: [], skipped: [], machine: null, next_steps: nextSteps(plannedFiles) });
  if (anyWrite && prompter) {
    const answer = await prompter.ask('Go ahead? [y/N] ');
    if (!/^y(es)?$/i.test(answer?.trim() ?? '')) throw canceled('the consent');
  }

  const writeAll = async () => {
    // 4. The tracker.
    if (remote.save && remote.name !== null) await saveRemote(root, remote.name);
    if (trackerPlan.action === 'mint' || trackerPlan.action === 'replace') {
      const author: Person = { name: o.person.name ?? o.person.email!, email: o.person.email! };
      const actor = { kind: 'human' as const, client: 'cli', nonce: o.nonce };
      const trackerStore = await openTracker(root);
      try {
        const minted = await trackerStore.initialize({ author, actor }, { settings: seedStoreSettings(trackerPlan.mode), replace: trackerPlan.action === 'replace' });
        tracker.root = minted.root;
        if (!minted.created) {
          // Another init minted one meanwhile: adopt it, and show its mode.
          tracker.action = 'adopted';
          tracker.excerpt_mode = mode = storeExcerptMode(await trackerStore.read());
        }
        if (trackerPlan.action === 'replace' && trackerPlan.remoteTip !== null && remote.name !== null) {
          // The remote's branch must move with the local ref: a sync would fold the old history back in.
          const refused = await replaceRemoteTracker(root, remote.name, remotes, minted.root, trackerPlan.remoteTip);
          if (refused) {
            await restoreTrackerRef(root, tips.local, minted.root);
            throw new GrimoireError('NOT_SYNCED', `init couldn't replace grimoire/tracker on ${remote.name} (${refused.message}); the tracker here is back as it was, and nothing changed`, {
              failure: refused,
              remedy: 'rerun init --new-tracker once the remote takes the push (its branch may have moved: check what it holds first)',
            });
          }
          tracker.sync = 'pushed';
        } else {
          if (trackerPlan.action === 'replace' && remote.name !== null && tips.remote !== null) {
            // The remote holds no tracker, but this clone still tracks the old one: a sync would fold it back in.
            await dropStaleRemoteTracker(root, remote.name, tips.remote);
          }
          const outcome = await syncNow(trackerStore, { author, identity: { name: o.person.name, email: o.person.email }, actor, client: 'cli', surface: 'cli' });
          tracker.sync = outcome.state;
          if (outcome.reason) tracker.sync_reason = outcome.reason;
          if (outcome.failure) tracker.failure = outcome.failure;
        }
      } finally {
        await trackerStore.close();
      }
      if (tracker.sync === 'pending') {
        warn(
          'SYNC_PENDING',
          tracker.sync_reason === 'no-default-branch'
            ? `${remote.name} has no default branch yet, so grimoire won't push grimoire/tracker there before it has one; the tracker stays sync-pending and goes out with the next sync`
            : `the new tracker isn't on ${remote.name ?? 'a remote'} yet${tracker.failure ? ` (${tracker.failure.message})` : ''}; it stays sync-pending and goes out with the next sync (\`grimoire sync\`)`,
        );
      }
    }
    const finalConfig: InstallConfig = { ...config, tracker_root: tracker.root! };

    // 5. The version copy, the launcher and the join record.
    const copy = await installCopy(store, version, o.source);
    const launched = await installLauncher(store);
    const record: JoinRecord = { ...joinRecord, excerpt_mode: mode ?? 'unknown' };
    const joinWrite: MachineResult['join_record'] =
      !join ? 'written' : join.excerpt_mode !== record.excerpt_mode || join.codex_hook_hash !== record.codex_hook_hash ? 'updated' : 'unchanged';
    if (joinWrite !== 'unchanged') await writeJoinRecord(store, version, record);
    if (excerptsMax !== undefined) await putMachineSetting(dirs.commonDir, 'capture.excerpts_max', excerptsMax);

    // 6. The files, the manifest, then config.yml last.
    const applied = await applyFiles(filePlan);
    const written = [...applied.written];
    const skipped = [...applied.skipped];
    if (!sameInstall(existing, finalConfig)) {
      const why = await writePlanned(root, { path: CONFIG_PATH, before: existing?.text ?? null, after: serializeInstallConfig(finalConfig) });
      if (why === null) written.push(CONFIG_PATH);
      else skipped.push({ path: CONFIG_PATH, why });
    }
    return { copy, launched, joinWrite, written, skipped };
  };
  // From before its copy is installed until config.yml pins it, this process
  // counts as running `version`: no other process's pruning (every server's
  // upkeep prunes) takes that copy in between.
  const registration = await store.processes.register({ role: 'init', client: null, worktree: root, pin: version, pathSource: null }).catch(() => null);
  let wrote: Awaited<ReturnType<typeof writeAll>>;
  let upkeep: UpkeepReport;
  try {
    // The (live store, worktree) lease upkeep's per-worktree part and doctor --fix share: held through step 6.
    const worktreeLease = await holdWorktreeLease(store, root);
    if (!worktreeLease) {
      throw new GrimoireError('BUSY', `another grimoire process keeps working on ${root} (upkeep, doctor --fix or init); nothing changed, so run init again in a moment`, {});
    }
    try {
      wrote = await writeAll();
    } finally {
      await worktreeLease.release().catch(() => {});
    }
    // 7. Upkeep, every part now: it keeps the copy this init runs, whatever config.yml says.
    upkeep = await runUpkeep({ root, version, surface: 'cli', nonce: o.nonce, force: true });
  } finally {
    await registration?.unregister().catch(() => {});
  }
  const { copy, launched, joinWrite, written, skipped } = wrote;
  const pruneRun = upkeep.runs.find((run) => run.part === 'prune-copies' && run.status === 'ran');
  const removed = (pruneRun?.result as { removed?: unknown } | undefined)?.removed;
  const pruned = Array.isArray(removed) ? removed.filter((version): version is string => typeof version === 'string') : [];

  // 8. The report.
  const done = report({
    written,
    skipped,
    machine: {
      copy: copy.status,
      launcher: launched.action,
      join_record: joinWrite,
      ...(excerptsMax !== undefined ? { excerpts_max: excerptsMax } : {}),
      pruned,
    },
    next_steps: nextSteps(written),
  });
  done.upkeep = upkeep;
  if (tracker.action === 'missing') {
    done.error = new GrimoireError('NOT_SYNCED', `the tracker .grimoire/config.yml names (root ${tracker.root}) isn't in this clone yet; everything else is set up`, {
      tracker_root: tracker.root,
      remedy: remote.name
        ? `run \`git fetch ${remote.name} +refs/heads/grimoire/tracker:refs/remotes/${remote.name}/grimoire/tracker\` once ${remote.name} holds it (or \`grimoire sync\`), then rerun init`
        : 'add the remote that holds grimoire/tracker, then rerun init',
      ...(failure ? { failure } : {}),
    }).toBody();
  }
  say(
    [
      written.length > 0 ? `Wrote ${written.join(', ')}.` : 'No checkout files changed.',
      ...(skipped.length > 0 ? skipped.map((entry) => `Left alone: ${entry.path} (${entry.why}).`) : []),
      ...(done.error ? [`NOT_SYNCED: ${done.error.message}`] : []),
      ...(warnings.some((w) => w.code === 'SYNC_PENDING') ? [`SYNC_PENDING: ${warnings.find((w) => w.code === 'SYNC_PENDING')!.message}`] : []),
      ...upkeep.notices,
      'Next steps:',
      ...done.next_steps.map((step) => `  - ${step}`),
      `Other MCP clients: run this stdio server command from the repo root (also under generic_mcp in the JSON report): ${genericMcpCommand()}`,
    ].join('\n'),
  );
  return done;
}
