// Path rewriting for excerpts (spec §14 The excerpt): the home folder becomes
// `~` and the repo root `<repo>`, in every spelling a session writes them. On
// Windows that is (spike A):
// - `C:\Users\…`, and `C:\\Users\\…` inside JSON text;
// - `C:/Users/…` (`pwd -W`);
// - `/c/Users/…` (Git Bash, typed by agents) and `/mnt/c/Users/…` (WSL);
// - `/tmp/…` for a folder under Git Bash's temp mount (`%TEMP%`);
// - the Claude Code project slug, each character other than a letter or a digit
//   replaced by `-` (`C--Users-…`).
// Paths are parsed by hand, never with `node:path`, so a Windows session's paths
// are rewritten the same on every OS.

export interface PathSpellings {
  /** The home folder, e.g. `C:\Users\ada` or `/home/ada`. */
  readonly home: string;
  /** The repo root the session worked in. */
  readonly repo: string;
  /** The temp folder Git Bash mounts as `/tmp` (`%TEMP%`), when the session ran on Windows. */
  readonly tmp?: string;
}

export type PathRewriter = (text: string) => string;

/** A rewriter for `spellings`: every spelling of the repo root first, then every spelling of the home folder. */
export function pathRewriter(spellings: PathSpellings): PathRewriter {
  const rules: { pattern: RegExp; replacement: string }[] = [];
  const add = (sources: string[], replacement: string, flags: string) => {
    for (const source of sources) {
      rules.push({
        // Not inside a longer name on either side.
        pattern: new RegExp(`(?<![A-Za-z0-9_])${source}(?![A-Za-z0-9_])`, `g${flags}`),
        replacement,
      });
    }
  };
  for (const [folder, replacement] of [
    [spellings.repo, '<repo>'],
    [spellings.home, '~'],
  ] as const) {
    const windows = parseWindows(folder);
    if (windows) {
      const sources = windowsSources(windows);
      const underTmp = spellings.tmp ? relativeTo(windows, parseWindows(spellings.tmp)) : null;
      if (underTmp && underTmp.length > 0) sources.push(['/tmp', ...underTmp].map(escapeRegExp).join('/'));
      add(sources, replacement, 'i');
    } else if (folder.length > 1) {
      const posix = folder.replace(/\/+$/, '');
      add([escapeRegExp(posix), escapeRegExp(slug(posix))], replacement, '');
    }
  }
  return (text) => rules.reduce((out, rule) => out.replace(rule.pattern, rule.replacement), text);
}

interface WindowsPath {
  readonly drive: string;
  readonly segments: readonly string[];
}

function parseWindows(folder: string): WindowsPath | null {
  const match = /^([A-Za-z]):[\\/]*(.*)$/.exec(folder);
  if (!match) return null;
  return { drive: match[1]!, segments: match[2]!.split(/[\\/]+/).filter((segment) => segment !== '') };
}

function windowsSources({ drive, segments }: WindowsPath): string[] {
  const parts = segments.map(escapeRegExp);
  // A JSON-escaped backslash, a backslash or a slash: one separator.
  const sep = '(?:\\\\\\\\|\\\\|/)';
  const native = [`${drive}:`, ...parts].join(sep);
  const msys = [`/${drive}`, ...parts].join('/');
  const wsl = [`/mnt/${drive}`, ...parts].join('/');
  const projectSlug = escapeRegExp(slug([`${drive}:`, ...segments].join('\\')));
  return segments.length > 0 ? [wsl, native, msys, projectSlug] : [wsl, native, msys];
}

/** `folder`'s segments under `base`, compared without case, or `null` if it isn't under it. */
function relativeTo(folder: WindowsPath, base: WindowsPath | null): string[] | null {
  if (!base || base.drive.toLowerCase() !== folder.drive.toLowerCase()) return null;
  if (base.segments.length > folder.segments.length) return null;
  const same = base.segments.every((segment, i) => segment.toLowerCase() === folder.segments[i]!.toLowerCase());
  return same ? folder.segments.slice(base.segments.length) : null;
}

/** Claude Code's project folder name for a working directory. */
function slug(folder: string): string {
  return folder.replace(/[^A-Za-z0-9]/g, '-');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
