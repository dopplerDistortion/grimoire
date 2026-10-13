// Spike D (GOK-129) throwaway: a SessionStart hook command that records which agent markers its process sees.
// Usage in a throwaway repo's .claude/settings.json: "command": "node <abs>/dump-env.mjs <abs>/hook-env.json"
import { writeFileSync } from 'node:fs';
const keys = Object.keys(process.env).filter((k) => /^(AI_AGENT|CLAUDE|CODEX)/.test(k)).sort();
writeFileSync(process.argv[2], JSON.stringify({ keys, AI_AGENT: process.env.AI_AGENT ?? null, CLAUDE_CODE_CHILD_SESSION: process.env.CLAUDE_CODE_CHILD_SESSION ?? null, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT ?? null }, null, 1));
