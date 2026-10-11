// node mkrepo.mjs <dir> [--dashdash] [--groups-before N] [--extra-hook]
// A throwaway git repo with <git-common-dir>/grimoire/launcher.cjs and a
// committed .codex/config.toml whose last [[hooks.SessionStart]] group runs
// `node -e "<bootstrap>" [--] hook session-start` (spec §11, Codex block).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [dir, ...flags] = process.argv.slice(2);
if (dir === undefined) {
  console.error('usage: node mkrepo.mjs <dir> [--dashdash] [--groups-before N] [--extra-hook]');
  process.exit(2);
}
const before = Number(flags.includes('--groups-before') ? flags[flags.indexOf('--groups-before') + 1] : 0);
const bootstrap = readFileSync(path.join(here, 'bootstrap.txt'), 'utf8');
/** @param {...string} a */
const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });

mkdirSync(dir, { recursive: true });
git('init', '-q', '.');
mkdirSync(path.join(dir, '.git', 'grimoire'), { recursive: true });
copyFileSync(path.join(here, 'launcher.cjs'), path.join(dir, '.git', 'grimoire', 'launcher.cjs'));

/** @param {boolean} dashdash */
export function hookCommand(dashdash) {
  return `node -e "${bootstrap}"${dashdash ? ' --' : ''} hook session-start`;
}
/** @param {string} s */
const tomlString = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

let toml = '';
for (let n = 0; n < before; n++) {
  toml += `[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = ${tomlString(`node -e "process.stdout.write('other group ${n}')"`)}\ntimeout = 10\n\n`;
}
toml += '# >>> grimoire (managed block)\n';
toml += `[[hooks.SessionStart]]\n[[hooks.SessionStart.hooks]]\ntype = "command"\ncommand = ${tomlString(hookCommand(flags.includes('--dashdash')))}\ntimeout = 10\n`;
toml += '# <<< grimoire\n';
mkdirSync(path.join(dir, '.codex'), { recursive: true });
writeFileSync(path.join(dir, '.codex', 'config.toml'), toml);
git('add', '.codex/config.toml');
git('-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '-m', 'codex config');
console.log(path.join(dir, '.codex', 'config.toml'));
