// Completes UPGRADE_REQUIRED (spec §5): stores report the marker, why and
// `requires`; the core adds what the call knows — the running release, the
// checkout's pin — and the ordered remedies.
import { access } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from '../git/run';
import { VERSION } from '../version';
import type { CallContext } from './context';

export const PACKAGE = '@goksening/grimoire';

export interface Remedy {
  readonly kind: 'rebase' | 'upgrade' | 'join' | 'init' | 'restart';
  readonly text: string;
  readonly command?: string;
}

/** Compares two semvers: negative, zero or positive. A pre-release sorts before its release. */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    return match ? { nums: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return Number.NaN;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i]! - y.nums[i]!;
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * The pin committed on the remote default branch: a no-network blob read of
 * `origin/HEAD:.grimoire/config.yml`. Null (never guessed) when origin/HEAD is
 * unset or the blob is missing.
 */
async function defaultBranchPin(root: string): Promise<{ branch: string; pin: string } | null> {
  const head = await runGit(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (head.code !== 0) return null;
  const ref = head.stdout.toString('utf8').trim();
  const blob = await runGit(root, ['cat-file', 'blob', `${ref}:.grimoire/config.yml`]);
  if (blob.code !== 0) return null;
  const pin = /^version:[ \t]*["']?([^"'\s#]+)/m.exec(blob.stdout.toString('utf8'))?.[1];
  return pin ? { branch: ref.replace(/^refs\/remotes\//, ''), pin } : null;
}

/** Whether this machine has the complete version copy `pkg/<version>/` (spec §6, §11). */
async function hasCopy(commonDir: string, version: string): Promise<boolean> {
  try {
    await access(path.join(commonDir, 'grimoire', 'pkg', version, '.complete'));
    return true;
  } catch {
    return false;
  }
}

/** UPGRADE_REQUIRED's details (spec §5, §9): one shape on every path. */
export interface UpgradeRequiredDetails {
  readonly marker: 'store' | 'machine' | 'install';
  readonly why: 'newer' | 'older';
  readonly running: string;
  readonly pin: string | null;
  readonly requires: string | null;
  readonly remedies: readonly Remedy[];
}

/** Where an UPGRADE_REQUIRED was met, for its remedies. */
export interface UpgradePlace {
  /** The checkout's root: the remote default branch's pin is read there. */
  readonly root: string;
  /** The checkout's pin. */
  readonly pin: string | null;
  /** The clone's git common dir (whether this machine has a version copy), when known. */
  readonly commonDir: string | null;
  /** The running release (default: this one). */
  readonly running?: string;
  /**
   * A one-shot verb (`uninstall`) met it, not a session: for an `install`
   * refusal the remedy is running that verb with a release that understands
   * the checkout, not restarting a session.
   */
  readonly verb?: string;
}

/**
 * Completes UPGRADE_REQUIRED for a call (a store or the install check met it):
 * the running release, the checkout's pin, and the ordered remedies.
 */
export async function completeUpgradeDetails(
  details: Readonly<Record<string, unknown>>,
  ctx: CallContext,
  commonDir: string | null,
): Promise<Record<string, unknown>> {
  return { ...(await upgradeRequiredDetails(details, { root: ctx.repo.root, pin: ctx.repo.pin, commonDir })) };
}

/**
 * UPGRADE_REQUIRED's details from what was met (`marker`, `why`, `requires`)
 * and where: the one shape the core and the installer give, with the ordered
 * remedies of spec §5.
 */
export async function upgradeRequiredDetails(details: Readonly<Record<string, unknown>>, place: UpgradePlace): Promise<UpgradeRequiredDetails> {
  const marker = details.marker === 'store' || details.marker === 'machine' ? details.marker : 'install';
  const why = details.why === 'newer' ? 'newer' : 'older';
  const { pin, commonDir } = place;
  // For `install`, `requires` is the checkout's pin (spec §5), unless a one-shot verb names the release it needs.
  const requires = typeof details.requires === 'string' ? details.requires : marker === 'install' && place.verb === undefined ? pin : null;
  const running = place.running ?? VERSION;
  const remedies: Remedy[] = [];
  if (marker === 'install' && place.verb !== undefined) {
    // A one-shot verb: run it again with a release that understands this checkout.
    const command = `npx ${PACKAGE}@${requires ?? 'latest'} ${place.verb}`;
    const release = requires ? `grimoire ${requires}` : 'the latest release';
    remedies.push({ kind: 'upgrade', command, text: `run \`${command}\` here: ${release} understands what this checkout holds` });
  } else if (marker === 'install') {
    // The checkout's own files are newer or older than this process: the release
    // the checkout pins is the one that understands them (spec §5).
    remedies.push({
      kind: 'restart',
      text: `restart this session, so it runs the release this checkout pins${pin ? ` (grimoire ${pin})` : ''}`,
    });
    if (pin && (!commonDir || !(await hasCopy(commonDir, pin)))) {
      const join = `npx ${PACKAGE}@${pin} init`;
      remedies.push({ kind: 'join', command: join, text: `join grimoire ${pin} on this machine first: \`${join}\`` });
    }
  } else if (why === 'newer') {
    const onDefault = await defaultBranchPin(place.root);
    const rebase = onDefault && requires && compareSemver(onDefault.pin, requires) >= 0 ? onDefault : null;
    if (rebase) {
      remedies.push({
        kind: 'rebase',
        text: `merge or rebase onto ${rebase.branch}, which pins grimoire ${rebase.pin}`,
      });
    }
    const target = rebase?.pin ?? requires;
    if (target) {
      const upgrade = `npx ${PACKAGE}@${target} init --upgrade`;
      remedies.push({ kind: 'upgrade', command: upgrade, text: `run \`${upgrade}\` in this checkout, then commit` });
      if (!commonDir || !(await hasCopy(commonDir, target))) {
        const join = `npx ${PACKAGE}@${target} init`;
        remedies.push({ kind: 'join', command: join, text: `join grimoire ${target} on this machine: \`${join}\`` });
      }
    }
  } else {
    const at = pin ?? running;
    const command = `npx ${PACKAGE}@${at} init`;
    remedies.push({
      kind: 'init',
      command,
      text: `a human runs \`${command}\` here (a join, or \`init --upgrade\` at the current pin)`,
    });
  }
  return { marker, why, running, pin, requires, remedies };
}
