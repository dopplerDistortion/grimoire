import type { SecretRule } from './rules';

/** One secret found in a text: the rule that matched and its span, `[start, end)` in UTF-16 code units. */
export interface SecretHit {
  readonly rule: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Why a scan could not run. Callers drop the text: an unscanned text is never
 * written.
 * - `invalid-input`: the input is not a string.
 * - `ruleset-invalid`: a rule failed to compile, so no text can be scanned.
 * - `scan-error`: scanning threw.
 */
export type ScanFailureReason = 'invalid-input' | 'ruleset-invalid' | 'scan-error';

/** The scan could not run. It carries no hits and no text, so it can't pass for "nothing found". */
export interface ScanFailure {
  readonly status: 'unscanned';
  readonly reason: ScanFailureReason;
  /** A diagnostic for logs. It never quotes the scanned text. */
  readonly detail: string;
}

export type SecretScan =
  | { readonly status: 'scanned'; readonly hits: readonly SecretHit[] }
  | ScanFailure;

export type Redaction =
  | { readonly status: 'scanned'; readonly text: string; readonly hits: readonly SecretHit[] }
  | ScanFailure;

export interface SecretScanner {
  /** Finds every secret. */
  scan(text: string): SecretScan;
  /** Finds every secret and replaces each with a marker naming its rule. */
  redact(text: string): Redaction;
}

/** The marker that replaces a redacted secret: `[REDACTED:<rule id>]`. */
export function redactionMarker(rule: string): string {
  return `[REDACTED:${rule}]`;
}

interface CompiledRule {
  readonly id: string;
  readonly regex: RegExp;
  readonly secretGroup: number;
  readonly keywords: readonly string[];
  readonly entropy: number;
  readonly allow: readonly RegExp[];
  readonly stopwords: readonly string[];
}

/**
 * A scanner over `rules`. A rule that fails to compile doesn't throw here: it
 * makes every scan return `unscanned`, so a broken ruleset fails closed.
 */
export function createScanner(rules: readonly SecretRule[]): SecretScanner {
  let compiled: CompiledRule[] | ScanFailure;
  try {
    if (rules.length === 0) throw new Error('the ruleset is empty');
    compiled = rules.map(compileRule);
  } catch (error) {
    compiled = failure('ruleset-invalid', errorMessage(error));
  }

  function scan(text: string): SecretScan {
    if (!Array.isArray(compiled)) return compiled;
    if (typeof text !== 'string') return failure('invalid-input', `expected a string, got ${describe(text)}`);
    try {
      return { status: 'scanned', hits: findHits(compiled, text) };
    } catch (error) {
      return failure('scan-error', errorMessage(error));
    }
  }

  function redact(text: string): Redaction {
    const result = scan(text);
    if (result.status !== 'scanned') return result;
    try {
      let out = '';
      let at = 0;
      for (const hit of result.hits) {
        out += text.slice(at, hit.start) + redactionMarker(hit.rule);
        at = hit.end;
      }
      return { status: 'scanned', text: out + text.slice(at), hits: result.hits };
    } catch (error) {
      return failure('scan-error', errorMessage(error));
    }
  }

  return { scan, redact };
}

function compileRule(rule: SecretRule): CompiledRule {
  try {
    const secretGroup = rule.secretGroup ?? 0;
    return {
      id: rule.id,
      regex: new RegExp(rule.regex, `g${secretGroup > 0 ? 'd' : ''}${rule.flags ?? ''}`),
      secretGroup,
      keywords: (rule.keywords ?? []).map((keyword) => keyword.toLowerCase()),
      entropy: rule.entropy ?? 0,
      allow: (rule.allow ?? []).map((source) => new RegExp(source)),
      stopwords: (rule.stopwords ?? []).map((word) => word.toLowerCase()),
    };
  } catch (error) {
    throw new Error(`rule ${rule.id}: ${errorMessage(error)}`);
  }
}

interface Candidate extends SecretHit {
  /** The rule's index in the ruleset; lower wins when hits overlap. */
  readonly priority: number;
}

function findHits(rules: readonly CompiledRule[], text: string): SecretHit[] {
  const lowered = text.toLowerCase();
  const candidates: Candidate[] = [];
  rules.forEach((rule, priority) => {
    if (rule.keywords.length > 0 && !rule.keywords.some((keyword) => lowered.includes(keyword))) return;
    for (const match of text.matchAll(rule.regex)) {
      const span = rule.secretGroup > 0 ? match.indices?.[rule.secretGroup] : undefined;
      const [start, end] = span ?? [match.index, match.index + match[0].length];
      if (end <= start || !isSecret(rule, text.slice(start, end))) continue;
      candidates.push({ rule: rule.id, start, end, priority });
    }
  });
  return mergeOverlaps(candidates);
}

function isSecret(rule: CompiledRule, secret: string): boolean {
  if (rule.entropy > 0 && shannonEntropy(secret) < rule.entropy) return false;
  if (rule.allow.some((pattern) => pattern.test(secret))) return false;
  const lowered = secret.toLowerCase();
  return !rule.stopwords.some((word) => lowered.includes(word));
}

/** Bits per character. */
function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  const length = [...counts.values()].reduce((sum, count) => sum + count, 0);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Overlapping candidates become one hit spanning them all, named after the
 * highest-priority rule among them, so every hit is disjoint and a redaction
 * replaces each secret exactly once.
 */
function mergeOverlaps(candidates: Candidate[]): SecretHit[] {
  candidates.sort((a, b) => a.start - b.start || a.priority - b.priority);
  const merged: Candidate[] = [];
  for (const next of candidates) {
    const last = merged.at(-1);
    if (last && next.start < last.end) {
      const winner = next.priority < last.priority ? next : last;
      merged[merged.length - 1] = {
        rule: winner.rule,
        priority: winner.priority,
        start: last.start,
        end: Math.max(last.end, next.end),
      };
    } else {
      merged.push(next);
    }
  }
  return merged.map(({ rule, start, end }) => ({ rule, start, end }));
}

function failure(reason: ScanFailureReason, detail: string): ScanFailure {
  return { status: 'unscanned', reason, detail };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Buffer.isBuffer(value)) return 'a Buffer';
  return typeof value;
}
