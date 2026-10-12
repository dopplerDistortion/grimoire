// Opening the person's browser at a sign-in URL (`start`, `open`). The URL
// carries a single-use code in its fragment, so it goes to the browser as one
// argument and never through a shell. `GRIMOIRE_BROWSER` names another
// opener: an executable's path, or a JSON array of argv (the URL is appended).
import { spawn } from 'node:child_process';

function openerOf(url: string, env: NodeJS.ProcessEnv): [string, string[]] {
  const chosen = env.GRIMOIRE_BROWSER?.trim();
  if (chosen) {
    if (chosen.startsWith('[')) {
      const argv: unknown = JSON.parse(chosen);
      if (Array.isArray(argv) && argv.length > 0 && argv.every((part) => typeof part === 'string')) {
        return [argv[0] as string, [...(argv.slice(1) as string[]), url]];
      }
      throw new Error('GRIMOIRE_BROWSER must be an executable path or a JSON array of strings');
    }
    return [chosen, [url]];
  }
  if (process.platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  if (process.platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

/** Starts the browser at `url`, detached; false when no opener could be started. */
export function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return new Promise((resolve) => {
    let command: string;
    let args: string[];
    try {
      [command, args] = openerOf(url, env);
    } catch {
      return resolve(false);
    }
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true, shell: false, env });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}
