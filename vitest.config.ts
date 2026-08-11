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
        // src/autoConfig.ts is a thin re-export facade (refactor-plan §2.2) —
        // all logic now lives in src/commands/* (presets, hfDiscovery,
        // serverAuth, byok, addServerFlow, autoConfigureFlow), each measured.
        // No exclusion needed: a pure re-export barrel hides nothing.
        // (Step-4 §4.0 tracked debt resolved 2026-08-10.)
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
