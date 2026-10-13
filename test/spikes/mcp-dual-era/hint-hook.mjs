// Spike B (GOK-127): a stand-in for grimoire's `hook pre-tool-use` (spec §8, §14).
// Claude Code runs it as a PreToolUse hook on the probe's tools. It copies the
// session, transcript path, tool-use id and subagent fields into the reserved key
// through `updatedInput`, never returning a `permissionDecision`, and records the
// payload it got and the output it gave in the capture directory (argv[2]).
//
//   node hint-hook.mjs <capture-dir>     (payload on stdin, as Claude Code sends it)
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const RESERVED_KEY = '_grimoire';
const captureDir = process.argv[2];

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  try {
    const payload = JSON.parse(raw);
    const hint = {
      session_id: payload.session_id,
      transcript_path: payload.transcript_path,
      tool_use_id: payload.tool_use_id,
      ...(payload.agent_id !== undefined && { agent_id: payload.agent_id }),
      ...(payload.agent_type !== undefined && { agent_type: payload.agent_type }),
    };
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ...payload.tool_input, [RESERVED_KEY]: hint },
      },
    };
    if (captureDir) {
      mkdirSync(captureDir, { recursive: true });
      appendFileSync(path.join(captureDir, 'hook-input.jsonl'), `${raw.trim()}\n`);
      appendFileSync(path.join(captureDir, 'hook-output.jsonl'), `${JSON.stringify(output)}\n`);
    }
    process.stdout.write(JSON.stringify(output));
  } catch {
    // Fail silently with exit 0, as grimoire's hook does (spec §14).
  }
});
