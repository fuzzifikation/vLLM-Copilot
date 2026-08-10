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
        // VS Code/subprocess orchestration surfaces (refactor-plan §2.4/§2.5:
        // diagnostics and views are deferred, NOT split in the P1 refactor).
        // Unit tests on these buy no behavioral protection; their logic is
        // either deferred or surfaced as extracted, measured modules later.
        'src/diagnostics.ts',     // Subprocess exec (PowerShell/curl/openssl), network orchestration
        'src/dashboard.ts',       // Webview/tree UI, known-bugs P2, deferred
        'src/deepDiveView.ts',    // Webview view provider, known-bugs P2, deferred
        // Public command-registration facade (sibling of commands.ts). Its
        // children (presets/hfDiscovery/serverAuth/addServerFlow/byok) are
        // extracted and measured individually during the refactor.
        'src/autoConfig.ts',
      ],
      thresholds: {
        // Truthful floors below measured coverage (see Step 0 of refactor-plan.md).
        // Set ~10pp under the reclassified baseline so the gate catches real
        // regressions (new untested modules) without tripping on noise. Enforced
        // via `npm run build` so it cannot rot silently again.
        lines: 60,
        functions: 60,
        branches: 50,
        statements: 60,
      },
    },
  },
});
