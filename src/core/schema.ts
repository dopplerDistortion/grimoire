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
  /** Rejects the empty string (whitespace alone is fine). */
  readonly nonEmpty?: boolean;
  /** Rejects CR and LF. */
  readonly singleLine?: boolean;
  readonly description?: string;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function withDescription(json: Record<string, unknown>, description?: string): Record<string, unknown> {
  return description ? { ...json, description } : json;
}

function string(rules: StringRules = {}): Schema<string, false> {
  return {
    json: withDescription({ type: 'string' }, rules.description),
    optional: false,
    parse(value, path, errors) {
      if (typeof value !== 'string') errors[path] = 'must be a string';
      // A lone surrogate can't round-trip through UTF-8, so stored bytes would differ.
      else if (LONE_SURROGATE.test(value)) errors[path] = 'must be valid Unicode text';
      else if (rules.nonBlank && value.trim() === '') errors[path] = 'must not be empty';
      else if (rules.nonEmpty && value === '') errors[path] = 'must not be empty';
      else if (rules.singleLine && /[\r\n]/.test(value)) errors[path] = 'must be one line';
      else return value;
      return undefined;
    },
  };
}

function boolean(description?: string): Schema<boolean, false> {
  return {
    json: withDescription({ type: 'boolean' }, description),
    optional: false,
    parse(value, path, errors) {
      if (typeof value === 'boolean') return value;
      errors[path] = 'must be true or false';
      return undefined;
    },
  };
}

function integer(rules: { min: number; max: number; description?: string }): Schema<number, false> {
  return {
    json: withDescription({ type: 'integer', minimum: rules.min, maximum: rules.max }, rules.description),
    optional: false,
    parse(value, path, errors) {
      if (typeof value !== 'number' || !Number.isInteger(value)) errors[path] = 'must be a whole number';
      else if (value < rules.min || value > rules.max) errors[path] = `must be from ${rules.min} to ${rules.max}`;
      else return value;
      return undefined;
    },
  };
}

/** One of a fixed set of strings. */
function literal<const V extends string>(values: readonly V[], description?: string): Schema<V, false> {
  return {
    json: withDescription({ type: 'string', enum: [...values] }, description),
    optional: false,
    parse(value, path, errors) {
      if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as V;
      errors[path] = `must be ${values.length === 1 ? '' : 'one of '}${values.map((v) => JSON.stringify(v)).join(', ')}`;
      return undefined;
    },
  };
}

/** The value, or null. */
function nullable<T>(schema: Schema<T, false>, description?: string): Schema<T | null, false> {
  return {
    json: withDescription({ anyOf: [schema.json, { type: 'null' }] }, description),
    optional: false,
    parse(value, path, errors) {
      return value === null ? null : schema.parse(value, path, errors);
    },
  };
}

/** A value `a` accepts, else one `b` accepts (with `b`'s errors when neither does). */
function either<A, B>(a: Schema<A, false>, b: Schema<B, false>, description?: string): Schema<A | B, false> {
  return {
    json: withDescription({ anyOf: [a.json, b.json] }, description),
    optional: false,
    parse(value, path, errors) {
      const first: Record<string, string> = {};
      const parsed = a.parse(value, path, first);
      if (parsed !== undefined && Object.keys(first).length === 0) return parsed;
      return b.parse(value, path, errors);
    },
  };
}

function array<T>(item: Schema<T, false>, description?: string): Schema<T[], false> {
  return {
    json: withDescription({ type: 'array', items: item.json }, description),
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
function object<S extends Shape>(shape: S, description?: string): Schema<ObjectOf<S>, false> {
  const required = Object.keys(shape).filter((key) => !shape[key]!.optional);
  return {
    json: withDescription(
      {
        type: 'object',
        properties: Object.fromEntries(Object.entries(shape).map(([key, schema]) => [key, schema.json])),
        ...(required.length > 0 ? { required } : {}),
        additionalProperties: false,
      },
      description,
    ),
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

type Variants = Record<string, Shape>;
type VariantOf<K extends string, V extends Variants> = {
  [T in keyof V & string]: { [P in K]: T } & ObjectOf<V[T]>;
}[keyof V & string];

/**
 * Objects told apart by the string field `tag`: each variant lists the other
 * fields it takes, and is checked like `object`.
 */
function tagged<const K extends string, const V extends Variants>(
  tag: K,
  variants: V,
  description?: string,
): Schema<VariantOf<K, V>, false> {
  const schemas = new Map(
    Object.entries(variants).map(([name, shape]) => [name, object({ [tag]: literal([name]), ...shape })]),
  );
  const names = [...schemas.keys()].map((name) => JSON.stringify(name)).join(', ');
  return {
    json: withDescription({ anyOf: [...schemas.values()].map((schema) => schema.json) }, description),
    optional: false,
    parse(value, path, errors) {
      const kind = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[tag] : undefined;
      const schema = typeof kind === 'string' ? schemas.get(kind) : undefined;
      if (!schema) {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) errors[path || 'input'] = 'must be an object';
        else errors[path ? `${path}.${tag}` : tag] = `must be one of ${names}`;
        return undefined;
      }
      return schema.parse(value, path, errors) as VariantOf<K, V> | undefined;
    },
  };
}

export const s = { string, boolean, integer, literal, nullable, either, array, optional, object, tagged };

/** Parses an op's input, or throws INVALID with every field error. */
export function parseInput<T>(schema: Schema<T>, input: unknown): T {
  const errors: Record<string, string> = {};
  const value = schema.parse(input ?? {}, '', errors);
  if (value === undefined || Object.keys(errors).length > 0) throw invalid(errors);
  return value;
}
