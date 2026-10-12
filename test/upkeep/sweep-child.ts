// A separate process that runs one upkeep pass of the excerpt sweep alone, for
// the cross-process lease test (bundled by bundleScript). argv[2] is JSON
// {root, goAt, capture, clock}: the child waits until goAt so several start
// together, then prints its report.
import { runUpkeep } from '../../src/upkeep';
import { excerptSweep } from '../../src/upkeep/sweep';

const { root, goAt, capture, clock } = JSON.parse(process.argv[2]!) as {
  root: string;
  goAt: number;
  capture: { claudeConfigDir: string; codexHome: string; home: string };
  clock: string;
};

async function main(): Promise<void> {
  const wait = goAt - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  const report = await runUpkeep({ root, parts: [excerptSweep({ capture, clock: () => new Date(clock), sync: false })] });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
