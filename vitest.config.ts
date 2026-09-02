import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Many src files import `vscode`; alias it to a lightweight stub for unit tests.
    alias: {
      vscode: path.resolve(__dirname, 'test/__mocks__/vscode.ts'),
    },
  },
});
