// Vitest setup file (vitest.config.ts → test.setupFiles): runs before each test file.
import { afterAll } from 'vitest';
import { installLeakGuard } from './children';
import { removeWorldTemplates } from './git-world';
import { isolateAgentClients } from './clients';
import { isolateGitEnvironment } from './git';

isolateGitEnvironment();
isolateAgentClients();
// A test (or a file's beforeAll) that leaves a process it started running fails, and the process tree is killed.
installLeakGuard();
// The git worlds this file's worlds were copied from: a Vitest worker's exit handlers don't run.
afterAll(() => removeWorldTemplates());
