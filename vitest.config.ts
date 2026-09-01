import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Many src files import `vscode`; alias it to a lightweight stub for unit tests.
    alias: {
      vscode: path.resolve(__dirname, 'test/__mocks__/vscode.ts'),
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        // Only files the unit suite genuinely cannot execute belong here.
        // Everything else is measured, including modules that lean on the mocked
        // vscode API — those tests do run and do assert real behavior.
        'src/extension.ts',      // Activation wiring: needs a real Extension Host
        'src/types.ts',          // Type definitions only — compiles away to nothing
        'src/sessionManager.ts', // Python/SQLite subprocess + file system; only pure helpers are unit-testable
      ],
      thresholds: {
        // Floors sit well under the measured baseline (84% stmts / 76% branches /
        // 83% funcs / 85% lines with the honest exclusion list above), so the gate
        // catches a new untested module rather than noise. Raise them if you dare.
        // Enforced via `npm run build` so it cannot rot silently again.
        lines: 60,
        functions: 60,
        branches: 50,
        statements: 60,
      },
    },
  },
});
