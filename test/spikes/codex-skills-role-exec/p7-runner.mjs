// Spike F (GOK-131) P7 + runner fixtures: the spec's Codex runner invocation,
// read-only, on native Windows, without prefer_mxc. The served bundle goes on
// stdin and carries the scripted model's PLAN.
//
//   node p7-runner.mjs <scratch-dir> <variant>
//     success   one read command, one write attempt, then a schema-shaped answer
//     http400   the model API answers 400 (a model-side failure)
//     nologin   no stand-in at all: the default OpenAI provider with no login
//     mxc       the success plan with -c features.prefer_mxc=true, to compare
//     notools   the success plan with the shell tool, web search and the skills block turned off
//
// The throwaway CODEX_HOME also holds a personal AGENTS.md and a personal skill,
// to see whether they reach the runner's prompt under --ignore-user-config.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { plan, providerArgs, readRequests, runCodex, startMock, writeFile } from './kit.mjs';

const [scratch = '.', variant = 'success'] = process.argv.slice(2);
const R = path.resolve(scratch, 'runs', `p7-${variant}`);
rmSync(R, { recursive: true, force: true });
const home = path.join(R, 'home');
mkdirSync(home, { recursive: true });
// A fresh, empty temp directory outside any git repo, as the runner makes.
const tmp = path.join(os.tmpdir(), `gok131-runner-${variant}-${process.pid}`);
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp);
const schemaFile = path.join(R, 'schema.json');
const outFile = path.join(R, 'last-message.txt');
writeFileSync(
  schemaFile,
  JSON.stringify({
    type: 'object',
    properties: { verdict: { type: 'string' }, pairs: { type: 'array', items: { type: 'string' } } },
    required: ['verdict', 'pairs'],
    additionalProperties: false,
  }),
);
const answer = JSON.stringify({ verdict: 'no_pattern', pairs: ['pair-1'] });
const steps =
  variant === 'http400'
    ? [{ http: 400, error: 'scripted model-side failure' }]
    : [
        { call: 'exec_command', args: { cmd: 'Get-ChildItem -Force -Name; Get-Content $env:GOK131_READ_PROBE' } },
        { call: 'exec_command', args: { cmd: "Set-Content -Path written-by-runner.txt -Value 'x'" } },
        { say: answer },
      ];
writeFileSync(path.join(R, 'read-probe.txt'), 'read probe content\n');
writeFile(path.join(home, 'AGENTS.md'), 'GRIM-P7-PERSONAL-AGENTS-MD\n');
writeFile(path.join(home, 'skills', 'personal-skill', 'SKILL.md'), '---\nname: personal-skill\ndescription: GRIM-P7-PERSONAL-SKILL marker.\n---\n\nbody\n');
const bundle = `grimoire chore bundle (stand-in)\n\n${plan(steps)}\n`;

const mock = variant === 'nologin' ? null : await startMock(path.join(R, 'mock'));
const args = [
  'exec',
  '--json',
  '--ephemeral',
  '--ignore-user-config',
  '--ignore-rules',
  '--skip-git-repo-check',
  '--cd',
  tmp,
  '--sandbox',
  'read-only',
  '--output-schema',
  schemaFile,
  '-o',
  outFile,
  '-c',
  'features.apps=false',
  '-c',
  'features.plugins=false',
  ...(mock ? providerArgs(mock.port) : []),
  ...(variant === 'mxc' ? ['-c', 'features.prefer_mxc=true'] : []),
  ...(variant === 'notools'
    ? ['-c', 'features.shell_tool=false', '-c', 'web_search="disabled"', '-c', 'skills.include_instructions=false']
    : []),
];
const result = await runCodex(args, {
  cwd: tmp,
  home,
  stdin: bundle,
  env: { GOK131_READ_PROBE: path.join(R, 'read-probe.txt') },
  timeoutMs: 300_000,
});
mock?.stop();
writeFileSync(path.join(R, 'args.json'), JSON.stringify(args, null, 2));
writeFileSync(path.join(R, 'stdout.jsonl'), result.stdout);
writeFileSync(path.join(R, 'stderr.txt'), result.stderr);
const written = existsSync(path.join(tmp, 'written-by-runner.txt'));
const leftovers = readdirSync(tmp);
const first = mock ? JSON.stringify(readRequests(path.join(R, 'mock'))[0]?.body ?? {}) : '';
console.log(
  JSON.stringify({
    variant,
    code: result.code,
    ms: result.ms,
    written,
    leftovers,
    out: existsSync(outFile) ? readFileSync(outFile, 'utf8') : null,
    personalAgentsMd: first.includes('GRIM-P7-PERSONAL-AGENTS-MD'),
    personalSkill: first.includes('GRIM-P7-PERSONAL-SKILL'),
    skillsBlock: first.includes('<skills_instructions>'),
  }),
);
console.log('--- stdout');
console.log(result.stdout);
console.log('--- stderr');
console.log(result.stderr.split('\n').slice(-30).join('\n'));
rmSync(tmp, { recursive: true, force: true });
