import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig(({ mode }) => ({
  test: {
    include: ['test/**/*.test.ts'],
    // Many src files import `vscode`; alias it to a lightweight stub for unit tests.
    alias: {
      vscode: path.resolve(__dirname, 'test/__mocks__/vscode.ts'),
    },
    // The live-server gate, set INSIDE the harness (CR-67): the old npm script
    // used POSIX `VLLM_INTEGRATION=1 …` prefix syntax, which cmd.exe parses as a
    // command name — the suite was unrunnable on Windows through its own
    // documented entry point. `npm run test:integration` now runs
    // `vitest run --mode integration`; unit-test modes never see the flag.
    env: mode === 'integration' ? { VLLM_INTEGRATION: '1' } : {},
  },
}));
