import path from 'node:path';
import { cutTranscript, notFound, type Cut, type CutOptions } from '../cut';
import { CLAUDE_CODE_READER_VERSION, readClaudeCodeTranscript } from './reader';

export { CLAUDE_CODE_READER_VERSION, readClaudeCodeTranscript, type ReadClaudeCodeOptions, type ReadResult } from './reader';

export interface ClaudeCodeCutInput extends CutOptions {
  /** The session's main transcript, `<projects>/<slug>/<session>.jsonl`. */
  readonly transcript: string;
  /** The subagent that made the binding calls, when one did: its own transcript is cut. */
  readonly agentId?: string;
}

/** Cuts one bound Claude Code context: reads its transcript, checks it against the evidence, and makes its excerpt. */
export async function cutClaudeCode(input: ClaudeCodeCutInput): Promise<Cut> {
  const read = await readClaudeCodeTranscript(input.transcript, { agentId: input.agentId });
  if (!read.found) {
    return notFound({
      client: { name: 'claude-code', version: null },
      reader: { version: CLAUDE_CODE_READER_VERSION },
      session: path.basename(input.transcript).replace(/\.jsonl$/i, ''),
      context: input.agentId ?? 'main',
    });
  }
  return cutTranscript(read.transcript, input);
}
