// Vitest setup file (vitest.config.ts → test.setupFiles): runs before each test file.
import { isolateGitEnvironment } from './git';

isolateGitEnvironment();
