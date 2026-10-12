// Vitest setup file (vitest.config.ts → test.setupFiles): runs before each test file.
import { installLeakGuard } from './children';
import { isolateGitEnvironment } from './git';

isolateGitEnvironment();
// A test (or a file's beforeAll) that leaves a process it started running fails, and the process tree is killed.
installLeakGuard();
