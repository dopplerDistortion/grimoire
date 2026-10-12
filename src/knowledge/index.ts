// The knowledge engine (spec §2 module 6), so far its skill half: the skill
// ledger, skill versions and the derivation of what is current and served.
export {
  MAX_SKILL_NAME,
  RESERVED_SKILL_NAMES,
  STUB_PREFIX,
  normalizeSkillText,
  parseSkillText,
  serializeSkillText,
  skillNameProblem,
  skillVersionOf,
  SkillTextError,
  type SkillParts,
} from './skill-text';
export {
  ledgerRecordId,
  ledgerRecordProblem,
  parseLedgerRecord,
  serializeLedgerRecord,
  type LedgerEntry,
  type LedgerKind,
  type LedgerRecord,
} from './ledger';
export { deriveSkills, type ContestedDecision, type SkillState, type SkillStatus } from './derive';
export { proposalSignals, proposalStates, targetedPatterns, viewProposalStates, type ProposalState, type ProposalStatus } from './proposals';
export { changeLines, diffLines, linesOf, normalizedLines, similarity, type LineDiff } from './line-diff';
export {
  readSkills,
  writeSkillChange,
  type ChangeAuthor,
  type ServedSkill,
  type SkillBook,
  type SkillChange,
  type WrittenChange,
} from './book';
