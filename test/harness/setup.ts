// Vitest setup file (vitest.config.ts → test.setupFiles): runs before each test file.
import { isolateAgentClients } from './clients';
import { isolateGitEnvironment } from './git';

isolateGitEnvironment();
isolateAgentClients();
