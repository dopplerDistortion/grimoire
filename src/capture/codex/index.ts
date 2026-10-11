import { stat } from 'node:fs/promises';
import { cutTranscript, emptyCut, notFound, type Cut, type CutOptions } from '../cut';
import { CODEX_READER_VERSION, readCodexTranscript, type CodexReadResult } from './reader';
import { findCodexTranscript } from './roots';

export { CODEX_READER_VERSION, readCodexTranscript, type CodexReadResult, type CodexUnreadable } from './reader';

export interface CodexCutInput extends CutOptions {
  /**
   * The context: the thread that made the binding calls (`_meta.threadId`). Its
   * own rollout is cut, a subagent thread's included (T4).
   */
  readonly context: string;
  /**
   * The session (`_meta.sessionId`, the root thread), named in the cut when no
   * transcript is found. Defaults to the context.
   */
  readonly session?: string;
  /**
   * The thread's rollout when known: a hook's `transcript_path` (an extended
   * `\\?\` path is fine) or one a sweep recorded. If it has moved (archived,
   * compressed) or is another thread's, the thread is searched for by id.
   */
  readonly transcript?: string;
  /** `$CODEX_HOME` or `~/.codex`, searched by thread id. Defaults to the home `transcript` lives in. */
  readonly codexHome?: string;
  /** Epoch milliseconds after which the search gives up with status `budget`. */
  readonly deadline?: number;
}

/**
 * Cuts one bound Codex context: finds and reads its rollout, checks it against
 * the evidence, and makes its excerpt. Capture problems are statuses, never errors.
 */
export async function cutCodex(input: CodexCutInput): Promise<Cut> {
  const identity = {
    client: { name: 'codex', version: null },
    reader: { version: CODEX_READER_VERSION },
    session: input.session ?? input.context,
    context: input.context,
  };

  let read: CodexReadResult | null = null;
  const given = input.transcript === undefined ? null : await existingRollout(plainPath(input.transcript));
  if (given !== null) {
    const result = await readCodexTranscript(given);
    if (!result.found || sameThread(result.transcript.context, input.context)) read = result;
  }
  if (read === null || (!read.found && read.unreadable === undefined)) {
    const codexHome =
      input.codexHome ?? (input.transcript === undefined ? null : codexHomeOf(plainPath(input.transcript)));
    if (codexHome !== null) {
      const found = await findCodexTranscript({
        codexHome,
        context: input.context,
        existedAt: latest(input.evidence.bindingCalls.map((call) => call.at)),
        deadline: input.deadline,
      });
      if (found.status === 'budget') return emptyCut(identity, 'budget');
      if (found.status === 'found') read = await readCodexTranscript(found.file);
    }
  }

  if (read === null || (!read.found && read.unreadable === undefined)) return notFound(identity);
  if (!read.found) return emptyCut(identity, 'unreadable');
  return cutTranscript(read.transcript, input);
}

/** A Windows extended-length path (`\\?\C:\…`, `\\?\UNC\server\share\…`) in its ordinary spelling. */
function plainPath(file: string): string {
  if (file.startsWith('\\\\?\\UNC\\')) return `\\\\${file.slice(8)}`;
  if (file.startsWith('\\\\?\\')) return file.slice(4);
  return file;
}

/** The rollout at `file`, or the `.zst` Codex compressed it into. */
async function existingRollout(file: string): Promise<string | null> {
  for (const candidate of [file, `${file}.zst`]) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Not there.
    }
  }
  return null;
}

/** The Codex home a rollout path lives in: the folder holding its `sessions/YYYY/MM/DD/` or `archived_sessions/`. */
function codexHomeOf(file: string): string | null {
  const match = /^(.*?)[\\/]+(?:sessions[\\/]+\d{4}[\\/]+\d{2}[\\/]+\d{2}|archived_sessions)[\\/]+[^\\/]+$/.exec(file);
  return match && match[1] !== '' ? match[1]! : null;
}

function sameThread(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function latest(times: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const at of times) if (best === undefined || Date.parse(at) > Date.parse(best)) best = at;
  return best;
}
