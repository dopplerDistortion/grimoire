// The client-neutral step model (spec §14 Readers): what every client's
// transcript reader normalizes into, and what windows and excerpts are cut from.
// Reasoning is never a step.

/** Where a step came from in its transcript: the line's timestamp and its id (Claude Code: the line uuid). */
export interface StepOrigin {
  readonly at: string;
  readonly ref: string;
}

/** A user prompt that opens a turn. */
export interface PromptStep extends StepOrigin {
  readonly kind: 'prompt';
  readonly text: string;
}

/** Visible assistant text. */
export interface AssistantStep extends StepOrigin {
  readonly kind: 'assistant';
  readonly text: string;
}

/** A tool call, with the model's own input. */
export interface ToolCallStep extends StepOrigin {
  readonly kind: 'tool_call';
  readonly id: string;
  readonly name: string;
  /**
   * The grimoire operation the call makes: the MCP tool's name (`claim`,
   * `show`, `chore_start`, …), or `cli` for a shell command running grimoire.
   * `null` for every other call.
   */
  readonly grimoire: string | null;
  readonly input: unknown;
}

/** A tool's result. `error` is false unless the client marked the result as failed. */
export interface ToolResultStep extends StepOrigin {
  readonly kind: 'tool_result';
  readonly id: string;
  readonly error: boolean;
  readonly text: string;
}

/** The summary a compaction left; the transcript continues after it. */
export interface CompactionStep extends StepOrigin {
  readonly kind: 'compaction';
  readonly text: string;
}

/** A call that launched a subagent (its own context, with its own transcript). */
export interface SubagentLaunchStep extends StepOrigin {
  readonly kind: 'subagent_launch';
  readonly id: string;
  readonly name: string;
  /** The subagent's type, when the launch names it. */
  readonly agentType: string | null;
  readonly input: unknown;
}

/** A subagent's result, back in the launching context. */
export interface SubagentResultStep extends StepOrigin {
  readonly kind: 'subagent_result';
  readonly id: string;
  /** The subagent's id, which names its own transcript, when the client recorded it. */
  readonly agentId: string | null;
  readonly error: boolean;
  readonly text: string;
}

export type Step =
  | PromptStep
  | AssistantStep
  | ToolCallStep
  | ToolResultStep
  | CompactionStep
  | SubagentLaunchStep
  | SubagentResultStep;

export type CallStep = ToolCallStep | SubagentLaunchStep;
export type ResultStep = ToolResultStep | SubagentResultStep;

export function isCall(step: Step): step is CallStep {
  return step.kind === 'tool_call' || step.kind === 'subagent_launch';
}

export function isResult(step: Step): step is ResultStep {
  return step.kind === 'tool_result' || step.kind === 'subagent_result';
}

/** What a reader made of one context's transcript. */
export interface Transcript {
  readonly client: { readonly name: string; readonly version: string | null };
  readonly reader: { readonly version: number };
  readonly session: string;
  /** `main` for the session's main line, otherwise the subagent's id. */
  readonly context: string;
  /** Every step, in transcript order. */
  readonly steps: readonly Step[];
  /**
   * How many leading steps are history a fork copied from another transcript.
   * They belong to the transcript they were copied from, never to this one.
   */
  readonly copiedSteps: number;
  /** The latest timestamp on any line read: how far the transcript was flushed. */
  readonly flushedTo: string | null;
  readonly lines: {
    readonly read: number;
    /** Lines of a type, or with content, the reader doesn't know: skipped and counted. */
    readonly unknown: number;
    /** Lines that aren't JSON, before the last line: skipped and counted. A torn last line is ignored. */
    readonly malformed: number;
  };
}
