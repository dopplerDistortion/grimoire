// Whether Codex runs grimoire's SessionStart hook (spec §21, Codex
// re-approval; spike E finding 6): Codex trusts a hook group per user, per
// declaring file, per position among that event's groups and per hash of its
// definition, so `status` and `doctor` compare the hash and position of
// grimoire's group in the main checkout's `.codex/config.toml` with what the
// user's `$CODEX_HOME/config.toml` trusts. The recipe is Codex-internal
// (0.162.1), so the join record's last-announced hash stays the fallback:
// "announce on change".
import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { GitDirs } from '../machine-local';
import { readTextIfExists } from '../machine-local';
import { normalizedText } from './manifest';
import { CODEX_MARKER, codexHookGroupHash, codexHookHash } from './pointers';
import { parseToml, sessionStartGroups } from './toml';
import { tomlMarkers } from './writer';

/**
 * `approved`: the user's trust holds this definition at this position;
 * `needs-approval`: no trust at this position (a new clone, a new user, or a
 * group moved); `modified`: trust for another definition (grimoire's hook
 * changed); `missing`: the main checkout has no grimoire group; `unknown`:
 * the user's Codex config couldn't be read.
 */
export type CodexTrust = 'approved' | 'needs-approval' | 'modified' | 'missing' | 'unknown';

export interface CodexHookState {
  /** The main checkout's `.codex/config.toml`: Codex runs its hooks in every linked worktree. */
  readonly declaring_file: string;
  /** Grimoire's group index among the file's `[[hooks.SessionStart]]` groups; null when there is none. */
  readonly position: number | null;
  /** Whether it is the last SessionStart group, as `init` appends it. */
  readonly last: boolean | null;
  /** The hash this release's group has. */
  readonly expected_hash: string;
  /** The hash of the group as declared; null when there is none. */
  readonly declared_hash: string | null;
  /** The key Codex keeps the trust under: `<file>:session_start:<position>:0`. */
  readonly key: string | null;
  readonly trust: CodexTrust;
  /** The hash this machine's join record last announced (the fallback when the trust can't be read). */
  readonly announced_hash: string | null;
  /** One line for `status` and `doctor`. */
  readonly summary: string;
}

/** Where Codex keeps the user's config. */
export function codexHome(env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME && env.CODEX_HOME.trim() !== '' ? env.CODEX_HOME : path.join(os.homedir(), '.codex');
}

/** The checkout whose `.codex/` Codex reads: the main checkout of a linked worktree, else this one. */
export function mainCheckout(root: string, dirs: GitDirs): string {
  return dirs.gitDir !== dirs.commonDir && path.basename(dirs.commonDir) === '.git' ? path.dirname(dirs.commonDir) : root;
}

/** A TOML key as written: bare, 'literal' or "basic". */
const KEY = String.raw`(?:'([^']*)'|"((?:[^"\\]|\\.)*)")`;

/** `hooks.state.<key>.trusted_hash` of a user's Codex config, by key. Lenient: it reads the two shapes Codex writes. */
export function trustedHashes(text: string): Map<string, string> {
  const found = new Map<string, string>();
  const unquote = (literal: string | undefined, basic: string | undefined) => literal ?? (JSON.parse(`"${basic ?? ''}"`) as string);
  let table: string | null = null;
  let inState = false;
  for (const raw of normalizedText(text).split('\n')) {
    const line = raw.trim();
    const header = /^\[\s*([^\]]+?)\s*\]\s*(#.*)?$/.exec(line);
    if (header && !line.startsWith('[[')) {
      const keyed = new RegExp(String.raw`^hooks\s*\.\s*state\s*\.\s*${KEY}$`).exec(header[1]!);
      table = keyed ? unquote(keyed[1], keyed[2]) : null;
      inState = /^hooks\s*\.\s*state$/.test(header[1]!);
      continue;
    }
    if (line.startsWith('[[')) {
      table = null;
      inState = false;
      continue;
    }
    if (table !== null) {
      const hash = /^trusted_hash\s*=\s*"([^"]*)"/.exec(line);
      if (hash) found.set(table, hash[1]!);
    } else if (inState) {
      const inline = new RegExp(String.raw`^${KEY}\s*=\s*\{.*trusted_hash\s*=\s*"([^"]*)"`).exec(line);
      if (inline) found.set(unquote(inline[1], inline[2]), inline[3]!);
    }
  }
  return found;
}

/** Codex's hash of the group as the block declares it (its handler's type, command, timeout and async; Codex defaults the timeout to 600). */
function declaredHash(body: string): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(body);
  } catch {
    return null;
  }
  const groups = (parsed.hooks as { SessionStart?: unknown } | undefined)?.SessionStart;
  const group = Array.isArray(groups) ? (groups[0] as { matcher?: unknown; hooks?: unknown } | undefined) : undefined;
  const handlers = Array.isArray(group?.hooks) ? (group!.hooks as Record<string, unknown>[]) : [];
  if (handlers.length === 0) return null;
  return codexHookGroupHash({
    event_name: 'session_start',
    matcher: typeof group?.matcher === 'string' ? group.matcher : null,
    hooks: handlers.map((handler) => ({
      type: String(handler.type ?? 'command'),
      command: String(handler.command ?? ''),
      timeout: typeof handler.timeout === 'number' ? handler.timeout : 600,
      async: handler.async === true,
    })),
  });
}

function summaryOf(state: Omit<CodexHookState, 'summary'>): string {
  switch (state.trust) {
    case 'approved':
      return 'Codex runs grimoire’s SessionStart hook: it is approved for this clone';
    case 'needs-approval':
      return 'Codex skips grimoire’s SessionStart hook until you approve it in `/hooks` (once per clone of this repo)';
    case 'modified':
      return 'Codex skips grimoire’s SessionStart hook: its definition changed since it was approved; approve it again in `/hooks`';
    case 'missing':
      return `${state.declaring_file} has no grimoire hook group: run grimoire init in the main checkout`;
    case 'unknown':
      return state.announced_hash === state.expected_hash
        ? 'grimoire can’t read your Codex config to tell whether its hook is approved; it was announced for approval on this machine'
        : 'grimoire’s hook changed since it was last announced: approve it in Codex’s `/hooks`';
  }
}

/** The state of grimoire's Codex hook for the checkout at `root`. Reads only. */
export async function codexHookState(root: string, dirs: GitDirs, env: NodeJS.ProcessEnv, announcedHash: string | null): Promise<CodexHookState> {
  const main = mainCheckout(root, dirs);
  const file = path.join(await realpath(main).catch(() => main), '.codex', 'config.toml');
  const base = { declaring_file: file, expected_hash: codexHookHash(), announced_hash: announcedHash };
  const done = (state: Omit<CodexHookState, 'summary' | 'declaring_file' | 'expected_hash' | 'announced_hash'>): CodexHookState => {
    const full = { ...base, ...state };
    return { ...full, summary: summaryOf(full) };
  };
  const text = await readTextIfExists(file);
  const { begin, end } = tomlMarkers(CODEX_MARKER);
  const lines = text === undefined ? [] : normalizedText(text).split('\n');
  const start = lines.findIndex((line) => line.trim() === begin);
  const stop = lines.findIndex((line, i) => i > start && line.trim() === end);
  if (start < 0 || stop < 0) return done({ position: null, last: null, declared_hash: null, key: null, trust: 'missing' });
  const body = lines.slice(start + 1, stop).join('\n');
  const position = sessionStartGroups(lines.slice(0, start).join('\n'));
  const last = sessionStartGroups(lines.join('\n')) === position + sessionStartGroups(body);
  const declared = declaredHash(body);
  if (declared === null) return done({ position: null, last: null, declared_hash: null, key: null, trust: 'missing' });
  const key = `${file}:session_start:${position}:0`;
  const userConfig = path.join(codexHome(env), 'config.toml');
  let trusted: Map<string, string>;
  try {
    const userText = await readTextIfExists(userConfig);
    trusted = userText === undefined ? new Map() : trustedHashes(userText);
  } catch {
    return done({ position, last, declared_hash: declared, key, trust: 'unknown' });
  }
  const fold = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const hash = [...trusted].find(([candidate]) => fold(candidate) === fold(key))?.[1];
  const trust: CodexTrust = hash === undefined ? 'needs-approval' : hash === declared ? 'approved' : 'modified';
  return done({ position, last, declared_hash: declared, key, trust });
}
