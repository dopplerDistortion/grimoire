// The hook verbs (spec §10, §11): `hook session-start` and `hook pre-tool-use`.
// A hook always exits 0, whatever happens, an unknown event included (v1
// tolerance, §21): a failing hook would only show the user an error, or make
// Codex drop the session line. Each event's code loads only for that event.
import { hookFailed } from './debug';

type Stdin = NodeJS.ReadableStream & { readonly isTTY?: boolean };

async function readAll(stdin: Stdin): Promise<string> {
  // A person running a hook by hand at a terminal sends no payload.
  if (stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

export interface HookIo {
  readonly stdin: Stdin;
  readonly stdout: NodeJS.WritableStream;
}

export interface HookOptions {
  /** session-start: how long into the hook its fast path may start work (default 7 s); a test seam. */
  readonly fastPathBudgetMs?: number;
}

/** Runs `hook <event>` started in `startDir`; the exit code is always 0. */
export async function runHook(event: string | undefined, startDir: string, io: HookIo = { stdin: process.stdin, stdout: process.stdout }, options: HookOptions = {}): Promise<0> {
  try {
    let output = '';
    if (event === 'session-start') {
      const { sessionStart } = await import('./session-start');
      output = await sessionStart(await readAll(io.stdin), { startDir, ...options });
    } else if (event === 'pre-tool-use') {
      const { preToolUse } = await import('./pre-tool-use');
      output = await preToolUse(await readAll(io.stdin), { startDir });
    }
    // Flushed before the hook returns: its process may end right after (../entry.ts exitWith).
    if (output !== '') await new Promise<void>((resolve) => io.stdout.write(output, () => resolve()));
  } catch (error) {
    // Never a failed hook: say nothing instead.
    hookFailed(error);
  }
  return 0;
}
