// A small input-schema builder: each schema validates an op's input (field
// errors keyed by path) and describes itself as JSON Schema for MCP tool
// listings and CLI `--help`.
import { invalid } from '../errors';

export interface Schema<T, Optional extends boolean = boolean> {
  readonly json: Record<string, unknown>;
  readonly optional: Optional;
  /** The value, or undefined after recording problems in `errors`. */
  parse(value: unknown, path: string, errors: Record<string, string>): T | undefined;
}

interface StringRules {
  /** Rejects strings that are empty or only whitespace. */
  readonly nonBlank?: boolean;
  /** Rejects CR and LF. */
  readonly singleLine?: boolean;
  readonly description?: string;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function string(rules: StringRules = {}): Schema<string, false> {
  return {
    json: { type: 'string', ...(rules.description ? { description: rules.description } : {}) },
    optional: false,
    parse(value, path, errors) {
      if (typeof value !== 'string') errors[path] = 'must be a string';
      // A lone surrogate can't round-trip through UTF-8, so stored bytes would differ.
      else if (LONE_SURROGATE.test(value)) errors[path] = 'must be valid Unicode text';
      else if (rules.nonBlank && value.trim() === '') errors[path] = 'must not be empty';
      else if (rules.singleLine && /[\r\n]/.test(value)) errors[path] = 'must be one line';
      else return value;
      return undefined;
    },
  };
}

function array<T>(item: Schema<T, false>, description?: string): Schema<T[], false> {
  return {
    json: { type: 'array', items: item.json, ...(description ? { description } : {}) },
    optional: false,
    parse(value, path, errors) {
      if (!Array.isArray(value)) {
        errors[path] = 'must be an array';
        return undefined;
      }
      const before = Object.keys(errors).length;
      const items = value.map((v: unknown, i) => item.parse(v, `${path}[${i}]`, errors));
      return Object.keys(errors).length === before ? (items as T[]) : undefined;
    },
  };
}

function optional<T>(schema: Schema<T, false>): Schema<T, true> {
  return { ...schema, optional: true };
}

type Shape = Record<string, Schema<any>>;
type ValueOf<S> = S extends Schema<infer T> ? T : never;
type ObjectOf<S extends Shape> = {
  [K in keyof S as S[K]['optional'] extends true ? never : K]: ValueOf<S[K]>;
} & {
  [K in keyof S as S[K]['optional'] extends true ? K : never]?: ValueOf<S[K]>;
};

/** An object with exactly these keys: unknown keys are rejected, so typos surface. */
function object<S extends Shape>(shape: S): Schema<ObjectOf<S>, false> {
  const required = Object.keys(shape).filter((key) => !shape[key]!.optional);
  return {
    json: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(shape).map(([key, schema]) => [key, schema.json])),
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
    optional: false,
    parse(value, path, errors) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        errors[path || 'input'] = 'must be an object';
        return undefined;
      }
      const record = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const before = Object.keys(errors).length;
      for (const key of Object.keys(record)) {
        if (!(key in shape)) errors[path ? `${path}.${key}` : key] = 'is not a known field';
      }
      for (const [key, schema] of Object.entries(shape)) {
        const field = path ? `${path}.${key}` : key;
        if (record[key] === undefined) {
          if (!schema.optional) errors[field] = 'is required';
          continue;
        }
        out[key] = schema.parse(record[key], field, errors);
      }
      return Object.keys(errors).length === before ? (out as ObjectOf<S>) : undefined;
    },
  };
}

export const s = { string, array, optional, object };

/** Parses an op's input, or throws INVALID with every field error. */
export function parseInput<T>(schema: Schema<T>, input: unknown): T {
  const errors: Record<string, string> = {};
  const value = schema.parse(input ?? {}, '', errors);
  if (value === undefined || Object.keys(errors).length > 0) throw invalid(errors);
  return value;
}
