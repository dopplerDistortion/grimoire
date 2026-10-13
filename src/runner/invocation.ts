// The command lines the runner starts (spec §16 Claude and Codex invocations,
// as spike D (C3) confirmed and spike F (C4 fallback, P7) and spike E
// (`web_search`) adjusted them).
import type { RunnerConfig } from './config';

/**
 * `claude -p`: the answer is the `--json-schema` structured output; no tools,
 * no MCP servers, no hooks, no session file. The schema goes inline and
 * minified: it counts toward Windows' 32,767-character command line (C3).
 */
export function claudeArgs(config: Pick<RunnerConfig, 'model'>, schema: Record<string, unknown>, procedureFile: string): string[] {
  return [
    '-p',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    '--setting-sources',
    'user',
    '--strict-mcp-config',
    '--settings',
    '{"disableAllHooks":true}',
    '--tools',
    '',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--max-turns',
    '3',
    '--no-session-persistence',
    '--append-system-prompt-file',
    procedureFile,
    ...(config.model ? ['--model', config.model] : []),
  ];
}

/** `claude auth status`, run with the child's exact env and cwd (P6). */
export const CLAUDE_AUTH_ARGS = ['auth', 'status', '--json'] as const;

/**
 * The user-config overrides every Codex runner command carries (C4 fallback):
 * the user config stays (a keyring login needs it), so everything in it that
 * could run a program, start a server, reach the prompt or choose who bills is
 * switched off one key at a time. Verified against Codex 0.162.1.
 */
export const CODEX_CONFIG_FLAGS: readonly string[] = [
  '-c',
  'features.apps=false',
  '-c',
  'features.plugins=false',
  '-c',
  'features.hooks=false',
  '-c',
  'notify=[]',
  '-c',
  'developer_instructions=""',
  '-c',
  'features.shell_tool=false',
  '-c',
  'web_search="disabled"',
  '-c',
  'skills.include_instructions=false',
  '-c',
  'model_provider="openai"',
];

/** The Codex release the override list was verified against (said at enable time). */
export const CODEX_VERIFIED_VERSION = '0.162.1';

/** A TOML key part: bare when it can be, else a basic string. */
function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

/** `codex exec`: the bundle on stdin and no prompt argument; the answer is the `-o` file, shaped by the strict `--output-schema`. */
export function codexArgs(config: Pick<RunnerConfig, 'model'>, files: { cwd: string; schema: string; out: string }, mcpServers: readonly string[]): string[] {
  return [
    'exec',
    '--json',
    '--ephemeral',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--cd',
    files.cwd,
    '--sandbox',
    'read-only',
    '--output-schema',
    files.schema,
    '-o',
    files.out,
    ...CODEX_CONFIG_FLAGS,
    ...mcpServers.flatMap((name) => ['-c', `mcp_servers.${tomlKey(name)}.enabled=false`]),
    ...(config.model ? ['-m', config.model] : []),
  ];
}

/** `codex mcp list --json`, with the exec's overrides, run in the exec's cwd and env: the servers to switch off. */
export const CODEX_MCP_LIST_ARGS: readonly string[] = [...CODEX_CONFIG_FLAGS, 'mcp', 'list', '--json'];

/** `codex login status`: which login the exec would use. */
export const CODEX_LOGIN_ARGS = ['login', 'status'] as const;

type JsonSchema = Record<string, unknown>;

const DROPPED_KEYWORDS = new Set(['maxLength', 'minLength', 'maxItems', 'minItems', 'pattern']);

/**
 * The schema Codex sends as a `strict: true` json_schema (spike F): every
 * property required and `additionalProperties: false` everywhere, an
 * optional property made nullable instead, `oneOf` as `anyOf`, `const` as a
 * one-value `enum`, and length limits left to grimoire's own checks at submit.
 */
export function strictSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DROPPED_KEYWORDS.has(key)) continue;
    if (key === 'const') out.enum = [value];
    else if (key === 'oneOf' || key === 'anyOf') out.anyOf = (value as JsonSchema[]).map(strictSchema);
    else if (key === 'items') out.items = strictSchema(value as JsonSchema);
    else if (key !== 'properties' && key !== 'required' && key !== 'additionalProperties') out[key] = value;
  }
  const properties = schema.properties as Record<string, JsonSchema> | undefined;
  if (properties !== undefined) {
    const required = new Set((schema.required as string[] | undefined) ?? []);
    const strict: Record<string, JsonSchema> = {};
    for (const [name, property] of Object.entries(properties)) {
      const converted = strictSchema(property);
      strict[name] = required.has(name) || allowsNull(property) ? converted : nullable(converted);
    }
    out.properties = strict;
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  return out;
}

function allowsNull(schema: JsonSchema): boolean {
  const type = schema.type;
  return type === 'null' || (Array.isArray(type) && type.includes('null'));
}

function nullable(schema: JsonSchema): JsonSchema {
  return { anyOf: [schema, { type: 'null' }] };
}

/**
 * A strict answer as the submit path takes it: a null where the original
 * schema had an optional property that doesn't allow null means "absent".
 */
export function fromStrict(value: unknown, schema: JsonSchema): unknown {
  if (Array.isArray(value)) {
    const items = schema.items as JsonSchema | undefined;
    return items ? value.map((item) => fromStrict(item, items)) : value;
  }
  if (value === null || typeof value !== 'object') return value;
  const variants = [schema, ...(((schema.oneOf ?? schema.anyOf) as JsonSchema[] | undefined) ?? [])];
  const properties: Record<string, JsonSchema> = {};
  const required = new Set<string>();
  for (const variant of variants) {
    Object.assign(properties, (variant.properties as Record<string, JsonSchema> | undefined) ?? {});
    for (const name of (variant.required as string[] | undefined) ?? []) required.add(name);
  }
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(value as Record<string, unknown>)) {
    const property = properties[name];
    if (field === null && property !== undefined && !required.has(name) && !allowsNull(property)) continue;
    out[name] = property ? fromStrict(field, property) : field;
  }
  return out;
}
