# grimoire

An issue tracker that agents talk to natively. It is installed into a repo, runs
entirely on the local machine, and uses git as its only sync layer. Its knowledge
layer compiles the experience of working issues into an evolving wiki and set of
skills.

Package: `@goksening/grimoire` (bin `grimoire`). It is not released yet.

## Installing

`npx @goksening/grimoire init` in a repo installs grimoire, or joins it on a new
machine, and prints its next steps.

Evolved skills reach agents as generated files nobody commits: a copy of each
skill in `.grimoire/skills/<name>/`, and a stub for each client in
`.claude/skills/grimoire-<name>/` and `.agents/skills/grimoire-<name>/`. Every
one of these folders ignores itself. **`git stash --all` is unsupported while
copies exist**, because it stashes ignored files too; `git stash -u` is fine.

## Contributing

### Requirements

- Node 22 or later.
- git 2.32 or later on the PATH. The tests run real git.
- Windows, macOS or Linux. Nothing may assume POSIX paths or a POSIX shell.

### Commands

```sh
npm ci              # install the dev toolchain (grimoire has no runtime dependencies)
npm run check       # the full local check, the CI equivalent (below)
npm test            # Vitest only
npm run typecheck   # tsc, for the Node side and the dashboard
npm run build       # dist/grimoire.mjs, dist/launch.mjs + dist/chunks/ (esbuild) and dist/dashboard/ (Vite)
```

`npm run check` runs four steps in order and prints a summary: `typecheck`,
`test`, `build` (both builds) and `check:deps` (zero runtime dependencies). It
runs every step even after a failure, and exits non-zero if any step failed. Run
it before every commit.

**No runtime dependencies.** The package manifest has no `dependencies` field,
and `check:deps` fails if one appears, or if `optionalDependencies`,
`peerDependencies` or `bundleDependencies` appears. Everything the package uses
is a devDependency, bundled into `dist/` at build time. The CLI build also fails
if the bundle imports anything other than a Node builtin. Each verb's heavy code
is a dynamic `import()`, which esbuild splits into `dist/chunks/`, so a verb
loads only its own code: `--version` never loads the MCP SDK, and `grimoire mcp`
answers its opening before the core loads.

### Layout

Each module is a deep module, tested through its public interface (spec §2):

| Module | Folder |
| -- | -- |
| Core operations | `src/core/` |
| Tracker store | `src/tracker/` |
| Machine-local store | `src/machine-local/` |
| Capture | `src/capture/` |
| Scanner | `src/scanner/` |
| Knowledge engine | `src/knowledge/` |
| Generated output | `src/generated/` |
| Runner | `src/runner/` |
| Installer | `src/installer/` |
| Upkeep | `src/upkeep/` |
| Surfaces | `src/surfaces/{mcp,cli,hooks,start,dashboard}/` |

Two shared pieces sit below the modules: `src/git/` (git processes run with a
clean `GIT_*` environment and no hooks, one long-lived `cat-file --batch`
reader per repo, and in-process object writes) and `src/errors.ts` (the error
envelope, spec §9). Core operations are called as
`createCore().call(name, input, callContext)`; the tracker store is
`openTracker(root)`.

A folder is created by the first ticket that puts code in it. The bin entry is
`src/surfaces/cli/main.ts`. Every core op is a CLI verb (`<noun> <verb>` for an
op `<noun>_<verb>`), driven by the op's input schema: the input is a JSON object
on stdin (`--input -`), flags and arguments are sugar for its plain fields (a
field that isn't plain takes JSON on its flag), and stdout is always one JSON object (exit 0, 1 with an `error` object, 2 for a
usage error). `grimoire <verb> --help` prints the schema and flags. A human-only
verb's typed confirmation is registered in `src/surfaces/cli/gate.ts`.

Agent clients never run the bin. Every client entry runs the frozen bootstrap
(`src/installer/bootstrap.ts`), which requires the clone's launcher
(`src/installer/launcher.cjs`, written to `<git-common-dir>/grimoire/`), which
imports the pinned version copy's `dist/launch.mjs` (`src/surfaces/launch.ts`);
the committed shell shim (`src/installer/run.cjs`) does the same for CLI verbs.
Run directly, the bin hands every verb but `init`, `leave` and `uninstall` to
that copy too (`src/surfaces/delegate.ts`), or exits 3 with the join command.
A hook verb always exits 0 and swallows its own failures; set `GRIMOIRE_DEBUG=1`
to see them on stderr.

`init` (`src/installer/init.ts`, its verb in `src/surfaces/cli/init.ts`) installs
or joins: a read-only preflight (remote, explicit tracker fetch, Node, identity),
the plan with the grants and the excerpt disclosure and one consent, then the
tracker (adopted, or minted with its settings seeded and pushed), the version
copy, launcher and join record, the pointer files and the manifest
(`src/installer/{pointers,writer,manifest}.ts`), and `.grimoire/config.yml`
last. `--yes` takes the safe defaults; `--json` alone prints the plan and
writes nothing.

Generated output (`src/generated/`) writes the evolved-skill copies and stubs in
every worktree on the process's pin, byte for byte from the served set
(`readServedSet`): upkeep's `skill-reconcile` part per worktree, its
`generated-removal` part for worktrees that pin no release, the refresh a
served-set change asks for (`createCore({ refreshSkills })`: in-process by
default, a forced upkeep pass in long-lived processes), and the SessionStart
hook's fast path, which only writes what is missing.

The dashboard (Preact) lives in
`src/surfaces/dashboard/`, and `npm run dev:dashboard` serves it.

Tests are `*.test.ts` files, either next to the module they test or under `test/`.
They test at the spec's three seams, in Testing Decisions: core operations
against real temporary git repos, the client contract against fixtures, and one
thin end-to-end check per surface.

### Test harness: `import … from '#harness'`

The harness is in `test/harness/`. Import it as `#harness` from any test. It
makes real git repos cheap. Nothing mocks git.

```ts
import { expect } from 'vitest';
import { gitTest as test } from '#harness';

test('a push from clone a reaches clone b', async ({ world }) => {
  const sha = await world.a.commitFile('notes.txt', 'hi\n', 'add notes');
  await world.a.git(['push', 'origin', 'HEAD:main']);
  await world.b.git(['fetch', 'origin']);
  expect(await world.b.git(['rev-parse', 'origin/main'])).toBe(sha);
});
```

- **`gitTest`** is Vitest's `test` with a fresh `world` for each test, removed
  afterwards. A world has:
  - a bare remote (`world.remote` is its path, `world.remoteUrl` its `file://` URL), whose `main` holds one empty commit;
  - two clones, `world.a` (committing as Alice) and `world.b` (committing as Bob). The identity is in each clone's local config.

  Outside the fixture, call `createGitWorld()` and then `world.cleanup()`.
- **`clone.addWorktree(name)`** adds a linked worktree on a new branch `name`,
  sharing the clone's git common directory.
- **`checkout.git(args)`** runs git in that checkout. It returns trimmed stdout
  and throws `GitError` on a non-zero exit. `checkout.gitResult(args)` returns
  `{ code, stdout, stderr }` and never throws. `checkout.commitFile(path, content, message?)`
  writes, stages and commits a file, and returns the sha. To run git in any
  directory, use `git(cwd, args)` and `gitResult(cwd, args)`.
- **Isolation.** A setup file runs before each test file. It removes every
  inherited `GIT_*` variable, hides the system git config, and makes
  `test/harness/gitconfig` the global config. That file sets `main` as the
  default branch, `autocrlf=false`, no signing and no auto-gc. Code under test
  that spawns git with `process.env` gets the same isolation. Never run
  `git config --global` in a test. `vi.stubEnv` changes are undone after each test.
- **`runCommand(command, args, { cwd, env, input })`** runs an executable
  without a shell. To run node, use `process.execPath`.
- **`makeTempDir()` and `removeDir(dir)`** create and remove other temp trees.
  The removal is safe on Windows: it retries on busy files and handles read-only git objects.
- **Fixtures** for client-contract tests are loaded with `fixturePath`,
  `readFixture`, `readFixtureBytes` and `readFixtureJson`. Fixtures must be real,
  sanitized client artifacts. The rules and the layout are in
  [`test/fixtures/README.md`](test/fixtures/README.md).
