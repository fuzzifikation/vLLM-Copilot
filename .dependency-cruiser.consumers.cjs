/**
 * dependency-cruiser config — CONSUMER truth (orphans).
 *
 * Pre-compilation edges: a file imported ONLY via `import type` still has
 * consumers (delete it and those files stop compiling). This cruise asks
 * "does anything read this module at all", so type-only imports count.
 * Cycle/layer rules live in .dependency-cruiser.cjs (runtime truth).
 *
 * Run: npm run dep:consumers
 */
module.exports = {
  forbidden: [
    {
      name: 'no-orphans',
      severity: 'error',
      comment:
        'Nothing imports this module, not even as a type. Either wire it up, absorb it into its (missing) consumer, or delete it. Reuse-or-absorb law, file level.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)extension\\.ts$', // VS Code entry point (package.json main)
          '\\.d\\.ts$',
        ],
      },
      to: {},
    },
    {
      name: 'core-no-host',
      severity: 'error',
      comment:
        'Pre-compilation variant of the runtime core-no-host rule: a type-only import from src/core into host source still couples the packed core to the extension. Move the type into core (or consume the core one) instead. Runtime edges are guarded in .dependency-cruiser.cjs.',
      from: { path: '^src/core/' },
      to: { path: '^src/(?!core/)' },
    },
    {
      name: 'core-no-undeclared-deps',
      severity: 'error',
      comment:
        'Pre-compilation variant of the package gate: `import type` from an editor/harness package counts here — ambient editor types are exactly what the Node-only package gate must not carry. Core may import only eventsource-parser, jsonrepair, best-effort-json-parser; `vscode` shows up as npm-dev via @types/vscode (verified 2026-10-03).',
      from: { path: '^src/core/' },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-no-pkg', 'npm-unknown'],
        pathNot: 'node_modules[/\\\\](eventsource-parser|jsonrepair|best-effort-json-parser)[/\\\\]',
      },
    },
    {
      name: 'copilot-not-harness',
      severity: 'error',
      comment:
        'Pre-compilation variant of the layering rule in .dependency-cruiser.cjs: a type-only import between src/vscode/copilot/ and src/vscode/harness/ still welds the two interfaces together even though the edge vanishes at runtime. They share src/core and src/vscode/state, nothing else.',
      from: { path: '^src/vscode/copilot/' },
      to: { path: '^src/vscode/harness/' },
    },
    {
      name: 'harness-not-copilot',
      severity: 'error',
      comment:
        'Pre-compilation mirror: the harness may not import the Copilot provider, not even for types. Shared logic goes down (src/core or src/vscode/state), never sideways.',
      from: { path: '^src/vscode/harness/' },
      to: { path: '^src/vscode/copilot/' },
    },
    {
      name: 'harness-node-only',
      severity: 'error',
      comment:
        'Pre-compilation variant: harness modules other than the three editor-glue files (harness.ts, settings.ts, editor-tools.ts) run in plain Node from scripts/ and the unit tests, so a type-only import of host source would still drag the editor into their graph. src/core and their own directory are fine.',
      from: { path: '^src/vscode/harness/', pathNot: '^src/vscode/harness/(harness|settings|editor-tools)\\.ts$' },
      to: { path: '^src/(?!core/|vscode/harness/)' },
    },
    {
      name: 'harness-node-only-no-packages',
      severity: 'error',
      comment:
        'Pre-compilation package gate for the same Node-only modules: no npm dependency of any kind, which is also how `vscode` is banned — it resolves to node_modules/@types/vscode as npm-dev (same trick as core-no-undeclared-deps).',
      from: { path: '^src/vscode/harness/', pathNot: '^src/vscode/harness/(harness|settings|editor-tools)\\.ts$' },
      to: { dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-no-pkg', 'npm-unknown'] },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
  },
};
