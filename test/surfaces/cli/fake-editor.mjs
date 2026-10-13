// A stand-in for the user's git editor. git runs `$GIT_EDITOR <file>`; this
// takes the next step of the plan in $FAKE_EDITOR_PLAN, logs the file it was
// given and what it held to $FAKE_EDITOR_LOG, and saves the step's text.
//
// A step is {write: text} (replace everything), {replace: [from, to]}, or {}
// (save unchanged).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const file = String(process.argv[2]);
const planFile = String(process.env.FAKE_EDITOR_PLAN);
const logFile = String(process.env.FAKE_EDITOR_LOG);
/** @type {{ write?: string, replace?: [string, string] }[]} */
const plan = JSON.parse(readFileSync(planFile, 'utf8'));
const step = plan.shift() ?? {};
writeFileSync(planFile, JSON.stringify(plan));
const before = readFileSync(file, 'utf8');
appendFileSync(logFile, `${JSON.stringify({ file, before })}\n`);
/** @type {string} */
let after = before;
if (step.write !== undefined) after = step.write;
if (step.replace) after = before.split(step.replace[0]).join(step.replace[1]);
writeFileSync(file, after);
