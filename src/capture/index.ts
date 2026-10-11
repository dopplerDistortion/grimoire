// Capture (spec §2 module 4, §14): binding evidence, bindings and seen-here
// rows, revealed transcript roots, the client transcript readers (Claude Code,
// Codex), the format check, window selection and the excerpt pipeline. Fact
// extraction, session records and the attempt-end cut build on this.
export {
  boundContexts,
  readBindings,
  workerKindOf,
  type Binding,
  type BoundContext,
} from './bindings';
export { idValue, mcpCallEvidence, observedEvidence, MAIN_CONTEXT, type CallEvidence, type EvidenceSource } from './evidence';
export { noteCutReach, recordSeenHere, seenHereRows, sessionKey, SEEN_HERE, type BindingSeen, type SeenHereRow } from './seen-here';
export { recordRevealedRoot, revealedRoot, revealedRoots, TRANSCRIPT_ROOTS, type RevealedRoot } from './transcript-roots';
export {
  cutClaudeCode,
  readClaudeCodeTranscript,
  CLAUDE_CODE_READER_VERSION,
  type ClaudeCodeCutInput,
  type ReadClaudeCodeOptions,
  type ReadResult,
} from './claude-code';
export {
  cutCodex,
  readCodexTranscript,
  CODEX_READER_VERSION,
  type CodexCutInput,
  type CodexReadResult,
  type CodexUnreadable,
} from './codex';
export {
  cutTranscript,
  type BindingCall,
  type BindingCallById,
  type BindingCallByTime,
  type Cut,
  type CutEvidence,
  type CutOptions,
  type ExcerptNote,
  type ExcerptStatus,
} from './cut';
export { EXCERPT_LIMIT } from './excerpt';
export { pathRewriter, type PathRewriter, type PathSpellings } from './paths';
export type {
  AssistantStep,
  CallStep,
  CompactionStep,
  PromptStep,
  ResultStep,
  Step,
  StepOrigin,
  SubagentLaunchStep,
  SubagentResultStep,
  ToolCallStep,
  ToolResultStep,
  Transcript,
} from './steps';
