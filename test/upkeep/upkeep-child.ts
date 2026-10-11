// A separate process that runs one upkeep pass, for the cross-process lease
// tests (bundled by bundleCallProcess). argv[2] is JSON {root, goAt}: the
// child waits until goAt so several start together, then prints its report.
import { runUpkeep } from '../../src/upkeep';

const { root, goAt } = JSON.parse(process.argv[2]!) as { root: string; goAt: number };

async function main(): Promise<void> {
  const wait = goAt - Date.now();
  if (wait > 20) await new Promise((resolve) => setTimeout(resolve, wait - 20));
  while (Date.now() < goAt) {
    // spin for the last few milliseconds, so every child starts together
  }
  const report = await runUpkeep({ root });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
