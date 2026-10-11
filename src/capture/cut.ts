import { createScanner, bundledRules, type SecretScanner } from '../scanner';
import { buildExcerpt } from './excerpt';
import { pathRewriter, type PathSpellings } from './paths';
import { isCall, isResult, type Step, type StepOrigin, type Transcript } from './steps';

// Cutting one bound context's transcript (spec §14 Window, Readers' format
// check, The excerpt): client-neutral, over the steps a client's reader made.

/** A binding call the evidence says this context made: its call id, and when grimoire saw it. */
export interface BindingCall {
  readonly id: string;
  readonly at: string;
}

export interface CutEvidence {
  /** The issue the attempt is on, e.g. `gr-1`. */
  readonly issue: string;
  readonly attemptOpenedAt: string;
  /** Absent while the attempt is open: the window then runs to the transcript's end. */
  readonly attemptEndedAt?: string;
  /** Every binding call (claim, ending call, `update` or `comment` naming the attempt) this context made. */
  readonly bindingCalls: readonly BindingCall[];
  /**
   * The context bound only through `update` or `comment` writes: its window
   * ends with its last turn naming the issue.
   */
  readonly writeOnly?: boolean;
  /** Call ids already in another excerpt of the same trace: each call id lands in at most one. */
  readonly claimedCallIds?: readonly string[];
}

export interface CutOptions {
  readonly evidence: CutEvidence;
  /** The home folder and the repo root, rewritten to `~` and `<repo>` in every spelling. */
  readonly paths: PathSpellings;
  /** Defaults to the bundled rules. A scanner that can't run gives `unscanned`. */
  readonly scanner?: SecretScanner;
}

/**
 * - `cut`: the window was found and the excerpt made;
 * - `not_found`: there is no transcript for the context;
 * - `unreadable`: a binding call the evidence names is missing from the parsed transcript;
 * - `unscanned`: the scanner couldn't run, so the excerpt was dropped.
 */
export type ExcerptStatus = 'cut' | 'not_found' | 'unreadable' | 'unscanned';

/** `tail_unflushed`: a binding call is past the flushed end, so the cut stops there. */
export type ExcerptNote = 'tail_unflushed';

export interface Cut {
  readonly status: ExcerptStatus;
  readonly notes: readonly ExcerptNote[];
  readonly client: { readonly name: string; readonly version: string | null };
  readonly reader: { readonly version: number };
  readonly session: string;
  readonly context: string;
  /** The window's first and last step. `null` when no window was found. */
  readonly window: { readonly start: StepOrigin; readonly end: StepOrigin } | null;
  /** How far the cut reached: its last step. A later cut replaces this one only if it reaches strictly further. */
  readonly reach: StepOrigin | null;
  readonly counts: {
    readonly stepsInWindow: number;
    /** Steps shown in the excerpt. */
    readonly stepsKept: number;
    /** The excerpt's length. */
    readonly characters: number;
  };
  readonly lines: Transcript['lines'];
  /** The window's steps, unredacted, for fact scans. Empty unless the status is `cut` or `unscanned`. */
  readonly steps: readonly Step[];
  /** The call ids in the window, which no other excerpt of the trace may hold. */
  readonly callIds: readonly string[];
  /** The excerpt text. `null` unless the status is `cut`. */
  readonly excerpt: string | null;
}

const bundled = createScanner(bundledRules);

/** Cuts a context's transcript into its window and excerpt, checking it against the binding evidence first. */
export function cutTranscript(transcript: Transcript, options: CutOptions): Cut {
  const { evidence } = options;
  const steps = transcript.steps.slice(transcript.copiedSteps);
  const base = {
    client: transcript.client,
    reader: transcript.reader,
    session: transcript.session,
    context: transcript.context,
    lines: transcript.lines,
  };

  // The format check: every binding call must be found. One missing inside the
  // parsed range means the reader can't be trusted; one past the flushed end
  // just hasn't been written yet.
  const callAt = new Map<string, number>();
  steps.forEach((step, index) => {
    if (isCall(step) && !callAt.has(step.id)) callAt.set(step.id, index);
  });
  const notes: ExcerptNote[] = [];
  for (const call of evidence.bindingCalls) {
    if (callAt.has(call.id)) continue;
    if (!pastFlushedEnd(call, transcript)) return unreadable(base);
    if (!notes.includes('tail_unflushed')) notes.push('tail_unflushed');
  }

  const claimed = new Set(evidence.claimedCallIds ?? []);
  const window = selectWindow(steps, evidence, claimed);
  const excluded = excludedCallIds(window, claimed);
  const kept = window.filter((step) => !((isCall(step) || isResult(step)) && excluded.has(step.id)));
  const first = kept[0];
  const last = kept.at(-1);
  const callIds = kept.filter(isCall).map((step) => step.id);

  const excerpt = buildExcerpt(kept, {
    header: {
      client: transcript.client,
      reader: transcript.reader,
      session: transcript.session,
      context: transcript.context,
      window: first && last ? { start: first.at, end: last.at } : null,
    },
    scanner: options.scanner ?? bundled,
    rewritePaths: pathRewriter(options.paths),
  });

  return {
    ...base,
    status: excerpt.status,
    notes,
    window: first && last ? { start: origin(first), end: origin(last) } : null,
    reach: last ? origin(last) : null,
    counts: {
      stepsInWindow: kept.length,
      stepsKept: excerpt.status === 'cut' ? excerpt.stepsKept : 0,
      characters: excerpt.status === 'cut' ? excerpt.text.length : 0,
    },
    steps: kept,
    callIds,
    excerpt: excerpt.status === 'cut' ? excerpt.text : null,
  };
}

/** A context with no transcript. */
export function notFound(transcript: Pick<Transcript, 'client' | 'reader' | 'session' | 'context'>): Cut {
  return {
    ...transcript,
    status: 'not_found',
    notes: [],
    window: null,
    reach: null,
    counts: { stepsInWindow: 0, stepsKept: 0, characters: 0 },
    lines: { read: 0, unknown: 0, malformed: 0 },
    steps: [],
    callIds: [],
    excerpt: null,
  };
}

function unreadable(base: Pick<Cut, 'client' | 'reader' | 'session' | 'context' | 'lines'>): Cut {
  return {
    ...base,
    status: 'unreadable',
    notes: [],
    window: null,
    reach: null,
    counts: { stepsInWindow: 0, stepsKept: 0, characters: 0 },
    steps: [],
    callIds: [],
    excerpt: null,
  };
}

/**
 * A binding call missing from the transcript is past its flushed end when grimoire
 * saw it after the latest line was written, and nothing unparsable could hold it.
 */
function pastFlushedEnd(call: BindingCall, transcript: Transcript): boolean {
  if (transcript.lines.malformed > 0) return false;
  if (transcript.flushedTo === null) return true;
  const at = Date.parse(call.at);
  return Number.isFinite(at) && at > Date.parse(transcript.flushedTo);
}

/**
 * The window (spec §14): from the prompt opening the turn that holds the
 * context's first grimoire call naming the issue, at or after the attempt
 * opened (for the claiming context, the claim itself), to the attempt's end or
 * the transcript's end; for a write-only context, to the end of its last turn
 * naming the issue. Compactions inside are crossed. A call another excerpt of
 * the trace holds never opens the window (T5's fallback for a fork whose copied
 * history wasn't detected).
 */
function selectWindow(steps: readonly Step[], evidence: CutEvidence, claimed: ReadonlySet<string>): Step[] {
  const binding = new Set(evidence.bindingCalls.map((call) => call.id));
  const opened = Date.parse(evidence.attemptOpenedAt);
  const ended = evidence.attemptEndedAt === undefined ? Infinity : Date.parse(evidence.attemptEndedAt);
  const anchors = (step: Step): boolean =>
    isCall(step) &&
    !claimed.has(step.id) &&
    (binding.has(step.id) ||
      (step.kind === 'tool_call' && namesIssue(step, evidence.issue) && Date.parse(step.at) >= opened));

  const anchor = steps.findIndex(anchors);
  if (anchor < 0) return [];
  let start = anchor;
  while (start > 0 && steps[start]!.kind !== 'prompt') start--;
  if (steps[start]!.kind !== 'prompt') start = 0;

  let end = steps.findIndex((step, index) => index > anchor && Date.parse(step.at) > ended);
  if (end < 0) end = steps.length;
  if (evidence.writeOnly) {
    let lastAnchor = anchor;
    for (let i = anchor; i < end; i++) if (anchors(steps[i]!)) lastAnchor = i;
    const nextPrompt = steps.findIndex((step, index) => index > lastAnchor && step.kind === 'prompt');
    if (nextPrompt >= 0 && nextPrompt < end) end = nextPrompt;
  }
  return steps.slice(start, end);
}

/** A grimoire call naming the issue: an MCP call with the id as an argument value, or a CLI command with it as a word. */
function namesIssue(step: Step & { kind: 'tool_call' }, issue: string): boolean {
  if (step.grimoire === null || step.grimoire.startsWith('chore_')) return false;
  if (step.grimoire === 'cli') {
    const word = new RegExp(`(?<![\\w-])${escapeRegExp(issue)}(?![\\w-])`);
    return word.test(JSON.stringify(step.input));
  }
  return hasValue(step.input, issue);
}

function hasValue(value: unknown, wanted: string): boolean {
  if (value === wanted) return true;
  if (Array.isArray(value)) return value.some((item) => hasValue(item, wanted));
  if (value !== null && typeof value === 'object') return Object.values(value).some((item) => hasValue(item, wanted));
  return false;
}

/**
 * Calls kept out of the excerpt, with their results: chore calls and the
 * `grimoire-chores` subagents (spec §14), and calls another excerpt of the
 * trace already holds.
 */
function excludedCallIds(window: readonly Step[], claimed: ReadonlySet<string>): Set<string> {
  const excluded = new Set(claimed);
  for (const step of window) {
    if (step.kind === 'tool_call' && step.grimoire?.startsWith('chore_')) excluded.add(step.id);
    if (step.kind === 'subagent_launch' && step.agentType === CHORES_AGENT) excluded.add(step.id);
  }
  return excluded;
}

const CHORES_AGENT = 'grimoire-chores';

function origin(step: Step): StepOrigin {
  return { at: step.at, ref: step.ref };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
