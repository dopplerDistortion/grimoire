// What `init` writes in a checkout (spec §11, Pointer files; The dotfolder):
// each client's pointer files and the dotfolder's own files, as the entries
// the manifest records. Pure: the writer (./writer.ts) compares them with the
// checkout and writes what differs.
import { MCP_ENTRY_ARGS, claudeHookArgs, codexHookCommand } from './bootstrap';
import { canonicalJson, sha256, type ClientName, type EntryKind } from './manifest';
import { SHIM_PATH, shimText } from './shim';
import {
  ADAPTER_DOC,
  ADAPTER_MARKER,
  AGENTS_MARKER,
  TRIAGE_LABELS_DOC,
  adapterBlockBody,
  agentsBlockBody,
  instructionRulesText,
  triageLabelsText,
} from './texts';
import { tomlArray, tomlString } from './toml';

interface EntryBase {
  /** POSIX path relative to the checkout root. */
  readonly path: string;
  readonly kind: EntryKind;
  readonly client?: ClientName;
}

/** A whole file grimoire owns (`file`), or one it writes only when absent and then leaves to the repo (`seeded-file`). */
export interface FileEntry extends EntryBase {
  readonly kind: 'file' | 'seeded-file';
  readonly text: string;
}

/** A key of a JSON file (`json-key`), or `package.json`'s script (`npm-script`). */
export interface JsonKeyEntry extends EntryBase {
  readonly kind: 'json-key' | 'npm-script';
  readonly key: readonly string[];
  readonly value: unknown;
}

/** One item of an array in a JSON file: a plain value (`item`) or a hook group (`hook`). */
export interface JsonItemEntry extends EntryBase {
  readonly kind: 'json-array-item';
  readonly key: readonly string[];
  readonly value: unknown;
  readonly item?: string;
  readonly hook?: string;
  readonly permission?: boolean;
}

/** A marked block of a Markdown file: `top` puts a new block first, else it is appended (or makes a new file). */
export interface MarkerBlockEntry extends EntryBase {
  readonly kind: 'marker-block';
  readonly marker: string;
  readonly body: string;
  readonly placement: 'top' | 'end';
}

/** grimoire's marked block of TOML tables, appended at the end of the file; `grants` are its permission-bearing keys. */
export interface TomlBlockEntry extends EntryBase {
  readonly kind: 'toml-table';
  readonly marker: string;
  readonly body: string;
  readonly grants: readonly { readonly key: readonly string[]; readonly value: unknown }[];
}

export type DesiredEntry = FileEntry | JsonKeyEntry | JsonItemEntry | MarkerBlockEntry | TomlBlockEntry;

/** `.codex/config.toml`'s block marker name. */
export const CODEX_MARKER = 'grimoire';

/** The variables Codex passes through to grimoire's server (spec §11; spike E finding 4). */
export const CODEX_ENV_VARS: readonly string[] = [
  'HOME',
  'XDG_CONFIG_HOME',
  'GIT_CONFIG_GLOBAL',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'SSH_AUTH_SOCK',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
];

/** The SessionStart hook's timeout in Codex (seconds); part of the trust hash. */
const CODEX_HOOK_TIMEOUT = 10;

/** The tables of grimoire's `.codex/config.toml` block. */
export function codexBlockBody(): string {
  return [
    '[mcp_servers.grimoire]',
    `command = ${tomlString('node')}`,
    `args = ${tomlArray(MCP_ENTRY_ARGS)}`,
    `env_vars = ${tomlArray(CODEX_ENV_VARS)}`,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 120',
    `default_tools_approval_mode = ${tomlString('approve')}`,
    '',
    '[[hooks.SessionStart]]',
    '[[hooks.SessionStart.hooks]]',
    `type = ${tomlString('command')}`,
    `command = ${tomlString(codexHookCommand())}`,
    `timeout = ${CODEX_HOOK_TIMEOUT}`,
    '',
  ].join('\n');
}

/** A Codex hook group's definition, as Codex hashes it for trust. */
export interface CodexHookGroup {
  /** The snake_case event, e.g. `session_start`. */
  readonly event_name: string;
  readonly matcher?: string | null;
  readonly hooks: readonly { readonly type: string; readonly command: string; readonly timeout: number; readonly async: boolean }[];
}

/**
 * The hash Codex trusts a hook group under (spike E, P4; Codex 0.162.1
 * hook_hash): `sha256:` over compact JSON with sorted keys of
 * {event_name, matcher (only when set), hooks}.
 */
export function codexHookGroupHash(group: CodexHookGroup): string {
  const { matcher, ...rest } = group;
  return sha256(canonicalJson(matcher === null || matcher === undefined ? rest : { ...rest, matcher }));
}

/**
 * The hash Codex trusts grimoire's SessionStart group under. The join record
 * keeps the one last announced, so a change asks for `/hooks` approval again.
 */
export function codexHookHash(): string {
  return codexHookGroupHash({
    event_name: 'session_start',
    hooks: [{ type: 'command', command: codexHookCommand(), timeout: CODEX_HOOK_TIMEOUT, async: false }],
  });
}

/** Claude Code's exec-form hook group for `event`. */
function claudeHookGroup(event: 'pre-tool-use' | 'session-start'): Record<string, unknown> {
  const handler = { type: 'command', command: 'node', args: claudeHookArgs(event), timeout: event === 'pre-tool-use' ? 5 : 10 };
  return event === 'pre-tool-use' ? { matcher: 'mcp__grimoire__.*', hooks: [handler] } : { hooks: [handler] };
}

/** Whether a Claude Code hook group is the one grimoire writes for `hook` (a handler that runs `hook <hook>`). */
export function isGrimoireHookGroup(group: unknown, hook: string): boolean {
  if (group === null || typeof group !== 'object') return false;
  const handlers = (group as { hooks?: unknown }).hooks;
  if (!Array.isArray(handlers)) return false;
  return handlers.some((handler) => {
    const args = (handler as { args?: unknown } | null)?.args;
    if (!Array.isArray(args)) return false;
    const at = args.indexOf('hook');
    return at >= 0 && args[at + 1] === hook;
  });
}

export interface PointerOptions {
  readonly clients: readonly ClientName[];
  /** `package.json` exists, so the npm script is written. */
  readonly npmScript: boolean;
  /**
   * The adapter doc block: `none` (declined, or nothing to do), `end` (a new
   * doc, or the block already there), `top` (made the tracker over a doc that
   * describes another one).
   */
  readonly adapter: 'none' | 'end' | 'top';
}

/** Every entry `init` wants in the checkout, in write order. */
export function desiredEntries(options: PointerOptions): DesiredEntry[] {
  const entries: DesiredEntry[] = [
    { path: '.grimoire/.gitattributes', kind: 'file', text: '* text=auto eol=lf\n' },
    { path: SHIM_PATH, kind: 'file', text: shimText() },
  ];
  if (options.clients.includes('claude-code')) {
    const client = 'claude-code' as const;
    entries.push(
      { path: '.mcp.json', kind: 'json-key', key: ['mcpServers', 'grimoire'], value: { command: 'node', args: [...MCP_ENTRY_ARGS] }, client },
      { path: '.claude/settings.json', kind: 'json-array-item', key: ['permissions', 'allow'], item: 'mcp__grimoire', value: 'mcp__grimoire', permission: true, client },
      { path: '.claude/settings.json', kind: 'json-array-item', key: ['enabledMcpjsonServers'], item: 'grimoire', value: 'grimoire', permission: true, client },
      { path: '.claude/settings.json', kind: 'json-array-item', key: ['hooks', 'PreToolUse'], hook: 'pre-tool-use', value: claudeHookGroup('pre-tool-use'), client },
      { path: '.claude/settings.json', kind: 'json-array-item', key: ['hooks', 'SessionStart'], hook: 'session-start', value: claudeHookGroup('session-start'), client },
      { path: '.claude/rules/grimoire.md', kind: 'file', text: instructionRulesText(), client },
    );
  }
  if (options.clients.includes('codex')) {
    const client = 'codex' as const;
    entries.push(
      {
        path: '.codex/config.toml',
        kind: 'toml-table',
        marker: CODEX_MARKER,
        body: codexBlockBody(),
        grants: [{ key: ['mcp_servers', 'grimoire', 'default_tools_approval_mode'], value: 'approve' }],
        client,
      },
      { path: 'AGENTS.md', kind: 'marker-block', marker: AGENTS_MARKER, body: agentsBlockBody(), placement: 'end', client },
    );
  }
  if (options.adapter !== 'none') {
    entries.push({
      path: ADAPTER_DOC,
      kind: 'marker-block',
      marker: ADAPTER_MARKER,
      body: adapterBlockBody({ supersedes: options.adapter === 'top' }),
      placement: options.adapter,
    });
  }
  entries.push({ path: TRIAGE_LABELS_DOC, kind: 'seeded-file', text: triageLabelsText() });
  if (options.npmScript) {
    entries.push({ path: 'package.json', kind: 'npm-script', key: ['scripts', 'grimoire'], value: 'node .grimoire/run.cjs' });
  }
  return entries;
}
