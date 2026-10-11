// Spike D (GOK-129) throwaway: write a probe-claude.mjs config for one case.
// Usage (from a scratch dir outside any repo, after make-inputs.mjs): node mkcfg.mjs <case-name> '<json-overrides>'
// Overrides: model, format, verbose, noSchema, schemaFile, maxTurns, noProcedure, extra[], stdin, stripSession, set{}, remove[].
// The binary is $CLAUDE_BIN, else ~/.local/bin/claude.exe (the native installer's path).
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
const [name, overridesJson = '{}'] = process.argv.slice(2);
const o = JSON.parse(overridesJson);
const root = resolve('.');
const schema = readFileSync(join(root, 'inputs', o.schemaFile ?? 'schema.json'), 'utf8').trim();
const base = ['-p', '--output-format', o.format ?? 'json'];
if (o.verbose) base.push('--verbose');
if (!o.noSchema) base.push('--json-schema', schema);
base.push('--setting-sources', 'user', '--strict-mcp-config', '--settings', '{"disableAllHooks":true}', '--tools', '', '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--max-turns', String(o.maxTurns ?? 3), '--no-session-persistence');
if (!o.noProcedure) base.push('--append-system-prompt-file', join(root, 'inputs', 'procedure.md'));
if (o.model) base.push('--model', o.model);
if (o.extra) base.push(...o.extra);
const cfg = {
  bin: process.env.CLAUDE_BIN ?? join(homedir(), '.local', 'bin', 'claude.exe'),
  args: o.argsOverride ?? base,
  stdinFile: o.stdin === null ? undefined : join(root, 'inputs', o.stdin ?? 'bundle-small.txt'),
  env: { stripSession: o.stripSession ?? true, remove: ['CLAUDE_CODE_SIMPLE', ...(o.remove ?? [])], set: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ...(o.set ?? {}) } },
  outDir: join(root, 'out'),
};
writeFileSync(join(root, 'out', `${name}.cfg.json`), JSON.stringify(cfg, null, 2));
console.log(join(root, 'out', `${name}.cfg.json`));
