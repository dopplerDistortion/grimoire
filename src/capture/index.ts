// Capture (spec §2 module 4, §14): the client transcript readers (Claude Code, Codex), the format
// check, window selection and the excerpt pipeline. Binding evidence, transcript
// roots, fact extraction, session records and the attempt-end cut build on this.
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
