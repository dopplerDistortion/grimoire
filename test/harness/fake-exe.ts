// Stand-in executables: a real native program by an absolute path, never a
// shell shim, that runs a Node script with exactly the argv, stdin, env and
// cwd it was given. Code that must spawn a platform binary directly (the
// runner: no `.cmd`, never `shell: true`) runs against these.
//
// On Windows a stand-in is a tiny C# launcher compiled once per machine with
// the .NET Framework's `csc.exe` (part of every Windows 10 and 11). It passes
// the rest of its own raw command line to `node <script>` untouched, so the
// script parses argv exactly as the real program's C runtime would, and it
// inherits stdin, stdout, stderr and the environment. Elsewhere a stand-in
// is a `#!/bin/sh` script that `exec`s node.
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from './process';

const LAUNCHER = `using System;
using System.Diagnostics;
using System.IO;

static class FakeLauncher
{
    static int Main()
    {
        string self = Process.GetCurrentProcess().MainModule.FileName;
        string[] target = File.ReadAllLines(Path.ChangeExtension(self, ".fake"));
        string line = Environment.CommandLine;
        int i = 0;
        if (line.Length > 0 && line[0] == '"')
        {
            int close = line.IndexOf('"', 1);
            i = close < 0 ? line.Length : close + 1;
        }
        else
        {
            while (i < line.Length && line[i] != ' ' && line[i] != '\\t') i++;
        }
        string rest = line.Substring(i).TrimStart(' ', '\\t');
        ProcessStartInfo start = new ProcessStartInfo(target[0], "\\"" + target[1] + "\\" " + rest);
        start.UseShellExecute = false;
        using (Process child = Process.Start(start))
        {
            child.WaitForExit();
            return child.ExitCode;
        }
    }
}
`;

function cscPath(): string {
  const windir = process.env.WINDIR ?? process.env.SystemRoot ?? 'C:\\Windows';
  return path.join(windir, 'Microsoft.NET', process.arch === 'ia32' ? 'Framework' : 'Framework64', 'v4.0.30319', 'csc.exe');
}

let compiled: Promise<string> | null = null;

/** The compiled launcher, built once per machine (cached under the temp dir by the source's hash). */
function launcher(): Promise<string> {
  compiled ??= (async () => {
    const hash = createHash('sha256').update(LAUNCHER).digest('hex').slice(0, 12);
    const dir = path.join(os.tmpdir(), `grimoire-test-fake-launcher-${hash}`);
    const exe = path.join(dir, 'launcher.exe');
    if (await stat(exe).then(() => true, () => false)) return exe;
    await mkdir(dir, { recursive: true });
    const unique = `${process.pid}-${Date.now()}`;
    const source = path.join(dir, `launcher-${unique}.cs`);
    const out = path.join(dir, `launcher-${unique}.exe`);
    await writeFile(source, LAUNCHER);
    const result = await runCommand(cscPath(), ['-nologo', '-optimize', `-out:${out}`, source], { timeoutMs: 60_000 });
    if (result.code !== 0) throw new Error(`csc failed to build the stand-in launcher: ${result.stdout}${result.stderr}`);
    // Another worker may have won the race: either copy works.
    await rename(out, exe).catch(async (error: NodeJS.ErrnoException) => {
      if (!(await stat(exe).then(() => true, () => false))) throw error;
    });
    return exe;
  })();
  return compiled;
}

/**
 * Makes `<dir>/<name>` (`<name>.exe` on Windows) run `node <dir>/<name>.mjs`,
 * a copy of `source`, and returns its absolute path. The script finds its
 * own folder and name from its path (`process.argv[1]`).
 */
export async function fakeExecutable(dir: string, name: string, source: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const script = path.join(dir, `${name}.mjs`);
  await copyFile(source, script);
  if (process.platform === 'win32') {
    const exe = path.join(dir, `${name}.exe`);
    await copyFile(await launcher(), exe);
    await writeFile(path.join(dir, `${name}.fake`), `${process.execPath}\r\n${script}\r\n`);
    return exe;
  }
  const file = path.join(dir, name);
  await writeFile(file, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  await chmod(file, 0o755);
  return file;
}
