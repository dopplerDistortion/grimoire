// The CLI's grammar (spec §10): verbs are op names, `<noun> <verb>` is an
// alias for the op `<noun>_<verb>`, the op's input is a JSON object on stdin
// (`--input -`), and flags and positionals are sugar for its scalar fields. A
// field that isn't scalar takes a JSON literal on its flag (`--fields
// '{"title": "theirs"}'`): a human-only op's input can't come on the stdin of
// the terminal it confirms at, so every field needs a flag.
// Everything here is driven by the ops' JSON Schemas, so an op a later slice
// adds to the registry is a verb with flags and `--help` at once.
import type { OpDescriptor } from '../../core';
import { confirmationHelp } from './gate';

/** A malformed command line: exit 2, before anything runs. */
export class UsageError extends Error {
  override readonly name = 'UsageError';

  constructor(
    message: string,
    /** The verb as typed, when one was recognized: its `--help` names the fix. */
    readonly verb?: string,
  ) {
    super(message);
  }
}

/** Verbs that aren't `<op>` or `<noun> <verb>` for an op `<noun>_<verb>` (spec §10, Runtime). */
const VERB_ALIASES: Readonly<Record<string, string>> = { settings: 'settings_get' };

/** How a verb is shown in help: the spec's spelling. */
export function verbOf(op: Pick<OpDescriptor, 'name'>): string {
  const alias = Object.entries(VERB_ALIASES).find(([, name]) => name === op.name);
  return alias ? alias[0] : op.name.replaceAll('_', ' ');
}

/** Positionals an op takes when its required scalar fields aren't the right ones. */
const POSITIONALS: Readonly<Record<string, readonly string[]>> = {
  settings_get: ['key'],
  // A page by its slug; a trace goes by `--trace <handle>`.
  quarantine: ['page', 'reason'],
  unquarantine: ['page'],
  // One stray edit by its id; `--skill <name>` or `--all true` for many.
  skill_discard: ['stray'],
};

/**
 * Human-only verbs whose input past their subject comes from the person's
 * editor (spec §15 `skill edit`, §17 `wiki edit`): the subject, as the one
 * argument, is all their command line takes.
 */
export const EDITOR_VERBS: Readonly<Record<string, string>> = { skill_edit: 'name', wiki_edit: 'slug' };

type JsonSchema = Record<string, unknown>;

function propertiesOf(op: OpDescriptor): Record<string, JsonSchema> {
  return (op.inputSchema.properties ?? {}) as Record<string, JsonSchema>;
}

function requiredOf(op: OpDescriptor): readonly string[] {
  return (op.inputSchema.required ?? []) as string[];
}

const SCALAR_TYPES = new Set(['string', 'integer', 'number', 'boolean', 'null']);

/** A string, number, boolean or null schema, or a choice among them. */
function isScalar(schema: JsonSchema): boolean {
  if (Array.isArray(schema.anyOf)) return (schema.anyOf as JsonSchema[]).every(isScalar);
  return typeof schema.type === 'string' && SCALAR_TYPES.has(schema.type);
}

/** An array of scalars: its flag may repeat, one item each. */
function isScalarArray(schema: JsonSchema): boolean {
  return schema.type === 'array' && typeof schema.items === 'object' && isScalar(schema.items as JsonSchema);
}

/** The positional arguments of an op, in order: its required scalar fields, unless listed above. */
export function positionalsOf(op: OpDescriptor): readonly string[] {
  const listed = POSITIONALS[op.name];
  if (listed) return listed;
  const edited = EDITOR_VERBS[op.name];
  if (edited) return [edited];
  const properties = propertiesOf(op);
  return requiredOf(op).filter((field) => properties[field] && isScalar(properties[field]!));
}

/** Whether `raw` (a command-line word) can stand for a value of `schema`, and as what. */
function accept(schema: JsonSchema, raw: string): { value: unknown } | null {
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf as JsonSchema[];
    // `null` clears a nullable field, so it is tried before any string branch.
    const nullable = branches.find((branch) => branch.type === 'null');
    if (nullable && raw === 'null') return { value: null };
    for (const branch of branches) {
      const accepted = accept(branch, raw);
      if (accepted) return accepted;
    }
    return null;
  }
  switch (schema.type) {
    case 'string':
      return !Array.isArray(schema.enum) || (schema.enum as unknown[]).includes(raw) ? { value: raw } : null;
    case 'integer':
      return /^-?\d+$/.test(raw) ? { value: Number(raw) } : null;
    case 'number':
      return /^-?\d+(\.\d+)?$/.test(raw) ? { value: Number(raw) } : null;
    case 'boolean':
      return raw === 'true' || raw === 'false' ? { value: raw === 'true' } : null;
    case 'null':
      return raw === 'null' ? { value: null } : null;
    default:
      return null;
  }
}

/** A command-line word as a value of `schema`: converted when it can be, else kept as text for the core to refuse. */
function convert(schema: JsonSchema, raw: string): unknown {
  // Not `?.value ?? raw`: an accepted null (clearing a nullable field) is a value.
  const accepted = accept(schema, raw);
  return accepted ? accepted.value : raw;
}

/** The value of a flag for a field that isn't a plain value (an object, a list of objects): a JSON literal. */
function jsonFlag(name: string, raw: string, verb: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new UsageError(`--${name} takes the field’s value as JSON, and what follows it isn’t valid JSON`, verb);
  }
}

/** `--idempotency-key` and `--idempotency_key` both name `idempotency_key`. */
function fieldOfFlag(flag: string): string {
  return flag.replaceAll('-', '_');
}

function flagOf(field: string): string {
  return `--${field.replaceAll('_', '-')}`;
}

export interface Command {
  readonly op: OpDescriptor;
  /** The verb as typed (`outcome set`, `release`). */
  readonly verb: string;
  /** Fields given as flags or positionals, converted to their schema types. */
  readonly fields: Record<string, unknown>;
  /** `--input -`: the op's JSON object comes on stdin. */
  readonly stdinInput: boolean;
  /** `--from <dir>`: where the host repo search starts (default: the cwd). */
  readonly from: string | null;
  /** `sync --background`: the detached sync child. */
  readonly background: boolean;
}

export type Parsed =
  | { readonly kind: 'help'; readonly op: OpDescriptor | null }
  | ({ readonly kind: 'call' } & Command);

/** Finds the op the leading words name: `<noun> <verb>` first, then `<verb>`, then the aliases. */
function resolveVerb(words: readonly string[], ops: readonly OpDescriptor[]): { op: OpDescriptor; used: number } | null {
  const byName = new Map(ops.map((op) => [op.name, op]));
  const [first, second] = words;
  if (first === undefined) return null;
  if (second !== undefined) {
    const pair = byName.get(`${first}_${second}`);
    if (pair) return { op: pair, used: 2 };
  }
  const single = byName.get(first) ?? byName.get(VERB_ALIASES[first] ?? '');
  return single ? { op: single, used: 1 } : null;
}

/**
 * Parses a command line against the ops: `grimoire <verb> [positionals]
 * [--field value]… [--input -] [--from <dir>] [--help]`.
 */
export function parseCommand(argv: readonly string[], ops: readonly OpDescriptor[]): Parsed {
  const help = argv.includes('--help') || argv.includes('-h');
  const leading: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith('-')) break;
    leading.push(arg);
  }
  if (leading.length === 0 || (leading[0] === 'help' && leading.length === 1)) {
    if (help || leading[0] === 'help') return { kind: 'help', op: null };
    throw new UsageError(argv.length === 0 ? 'name a verb' : `expected a verb before ${argv[0]}`);
  }
  const helpTarget = leading[0] === 'help' ? leading.slice(1) : null;
  const resolved = resolveVerb(helpTarget ?? leading, ops);
  if (!resolved) throw new UsageError(`there is no verb ${(helpTarget ?? leading).slice(0, 2).join(' ')}`);
  const { op } = resolved;
  if (help || helpTarget) return { kind: 'help', op };

  const verb = leading.slice(0, resolved.used).join(' ');
  const rest = argv.slice(resolved.used);
  const properties = propertiesOf(op);
  const positionals = positionalsOf(op);
  const fields: Record<string, unknown> = {};
  const given = new Set<string>();
  const words: string[] = [];
  let stdinInput = false;
  let from: string | null = null;
  let background = false;

  const set = (field: string, value: unknown, how: string) => {
    if (given.has(field)) throw new UsageError(`${field} is given twice (${how})`, verb);
    given.add(field);
    fields[field] = value;
  };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--') {
      words.push(...rest.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--') || arg === '--') {
      words.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    const inline = eq < 0 ? undefined : arg.slice(eq + 1);
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`--${name} needs a value`, verb);
      i++;
      return next;
    };
    if (name === 'input') {
      if (value() !== '-') throw new UsageError('--input takes - (the JSON object comes on stdin)', verb);
      stdinInput = true;
      continue;
    }
    if (name === 'from') {
      from = value();
      continue;
    }
    if (name === 'background' && op.name === 'sync') {
      background = true;
      continue;
    }
    const negated = name.startsWith('no-') && !(fieldOfFlag(name) in properties);
    const field = fieldOfFlag(negated ? name.slice(3) : name);
    const schema = properties[field];
    if (!schema) throw new UsageError(`${verb} has no flag --${name}`, verb);
    if (schema.type === 'boolean') {
      if (negated) {
        if (inline !== undefined) throw new UsageError(`--${name} takes no value`, verb);
        set(field, false, `--${name}`);
      } else {
        set(field, inline === undefined ? true : convert(schema, inline), `--${name}`);
      }
      continue;
    }
    if (negated) throw new UsageError(`${verb} has no flag --${name}`, verb);
    if (isScalarArray(schema)) {
      const items = (fields[field] as unknown[] | undefined) ?? [];
      items.push(convert(schema.items as JsonSchema, value()));
      fields[field] = items;
      given.add(field);
      continue;
    }
    // A human-only op's input can't come on a terminal's stdin, so every field has a flag.
    set(field, isScalar(schema) ? convert(schema, value()) : jsonFlag(name, value(), verb), `--${name}`);
  }

  if (words.length > positionals.length) {
    const shown = positionals.length === 0 ? 'none' : positionals.map((p) => `<${p}>`).join(' ');
    throw new UsageError(`too many arguments: ${verb} takes ${shown}; give other fields as flags`, verb);
  }
  words.forEach((word, i) => {
    const field = positionals[i]!;
    set(field, convert(properties[field]!, word), `as an argument and as ${flagOf(field)}`);
  });
  if (background && (stdinInput || Object.keys(fields).length > 0)) {
    throw new UsageError('sync --background takes nothing else', verb);
  }
  const edited = EDITOR_VERBS[op.name];
  if (edited !== undefined && (stdinInput || fields[edited] === undefined || Object.keys(fields).length > 1)) {
    throw new UsageError(`usage: grimoire ${verb} <${edited}> (the rest comes from your editor)`, verb);
  }
  return { kind: 'call', op, verb, fields, stdinInput, from, background };
}

/** Merges the op's JSON object from stdin with the fields given on the command line. */
export function mergeInput(command: Pick<Command, 'fields' | 'verb'>, stdin: unknown): Record<string, unknown> {
  if (stdin === undefined) return { ...command.fields };
  if (typeof stdin !== 'object' || stdin === null || Array.isArray(stdin)) {
    throw new UsageError('stdin must hold one JSON object (the op’s input)', command.verb);
  }
  const input = { ...(stdin as Record<string, unknown>) };
  for (const [field, value] of Object.entries(command.fields)) {
    if (Object.hasOwn(input, field)) throw new UsageError(`${field} is given twice (on stdin and on the command line)`, command.verb);
    input[field] = value;
  }
  return input;
}

/** `--help` for one verb: the op's input schema, positionals and flags, as one JSON object. */
export function verbHelp(op: OpDescriptor): Record<string, unknown> {
  const properties = propertiesOf(op);
  const required = new Set(requiredOf(op));
  const positionals = positionalsOf(op);
  const verb = verbOf(op);
  const edited = EDITOR_VERBS[op.name];
  const flagged = Object.entries(properties).filter(([field]) => edited === undefined || field === edited);
  const flags = flagged.map(([field, schema]) => {
    const json = !isScalar(schema) && !isScalarArray(schema);
    return {
      flag: json ? `${flagOf(field)} <json>` : schema.type === 'boolean' ? flagOf(field) : `${flagOf(field)} <value>`,
      field,
      required: required.has(field),
      ...(isScalarArray(schema) ? { repeatable: true } : {}),
      ...(positionals.includes(field) ? { positional: positionals.indexOf(field) + 1 } : {}),
      ...(json ? { json: true } : {}),
      ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
    };
  });
  const usage = [`grimoire ${verb}`, ...positionals.map((p) => `<${p}>`), ...(edited === undefined ? ['[flags]', '[--input -]'] : [])].join(' ');
  const confirmation = confirmationHelp(op, verb);
  return {
    verb,
    op: op.name,
    description: op.description,
    kind: op.kind,
    policy: op.policy,
    usage,
    positionals,
    flags,
    input_schema: op.inputSchema,
    ...(confirmation !== null ? { confirmation } : {}),
    ...(edited !== undefined ? { interactive: 'opens your git editor on a temp copy outside every worktree, then shows the diff before you confirm' } : {}),
  };
}

/** The runtime verbs that aren't core ops (spec §10 Runtime): each has its own `--help`. */
const RUNTIME_VERBS = [
  { verb: 'init', kind: 'write', policy: 'human-only', description: 'Install grimoire into this host repo, or join this clone to the version its checkout pins.' },
  { verb: 'leave', kind: 'write', policy: 'human-only', description: 'Remove grimoire from this clone on this machine: generated output, the machine-local store, version copies and launcher, and the local tracker ref once the remote holds its tip.' },
  { verb: 'status', kind: 'read', policy: 'agent', description: 'What to know about this checkout now: sync, refreshed pointer files, Node, stale claims, the excerpt mode, the Codex hook. Writes nothing.' },
  { verb: 'doctor', kind: 'read', policy: 'agent', description: 'A report on the store, the install and capture statistics; --fix makes the single-answer repairs (content pointer files, stale locks); --readers adds the transcript readers’ structure statistics.' },
] as const;

/** `grimoire --help`: every verb, the input and output rules and the exit codes. */
export function globalHelp(ops: readonly OpDescriptor[]): Record<string, unknown> {
  return {
    usage: 'grimoire <verb> [arguments] [--field value]… [--input -]',
    input:
      'the op’s JSON object on stdin with --input -; flags and arguments are sugar for its plain fields, and a field that isn’t a plain value takes JSON on its flag',
    repo: 'the host repo is the first directory at or above the cwd (or --from <dir>) that holds .git',
    output: 'stdout is always exactly one JSON object: the result, or {"error": {code, message, retryable, details}}',
    exit_codes: { 0: 'success', 1: 'stdout carries an error object', 2: 'usage error', 3: 'grimoire isn’t set up on this machine' },
    verbs: [...ops.map((op) => ({ verb: verbOf(op), op: op.name, kind: op.kind, policy: op.policy, description: op.description })), ...RUNTIME_VERBS],
    help: 'grimoire <verb> --help prints a verb’s input schema and flags',
  };
}
