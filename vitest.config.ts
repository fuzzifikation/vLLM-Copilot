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
        // VS Code-bound surfaces: require Extension Host or real VS Code instance.
        'src/extension.ts',       // Activation, command registration, lifecycle
        'src/provider.ts',        // LanguageModelChatProvider, stream orchestration
        'src/config.ts',          // Settings access, config validation
        'src/types.ts',           // Type definitions only
        // Hard-to-unit-test modules: depend on VS Code APIs, subprocess, or file system.
        'src/commands.ts',        // User-facing VS Code commands (showInformationMessage, QuickPick)
        'src/sessionManager.ts',  // Subprocess (Python/SQLite), file system manipulation
      ],
      thresholds: {
        // Thresholds match current coverage of the testable files.
        // Raise these as test coverage improves — see known-bugs.md for tracking.
        lines: 50,
        functions: 50,
        branches: 43,
        statements: 50,
      },
    },
  },
});
