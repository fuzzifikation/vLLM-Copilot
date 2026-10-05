/**
 * dependency-cruiser config — RUNTIME GRAPH truth (cycles + layering).
 *
 * Companion to docs/complexity-audit.md (the reuse-or-absorb law lives at
 * function level there; this file guards the FILE level). Post-compilation
 * edges only: `import type` vanishes at runtime, so phantom cycles
 * (config.ts <-> serverRegistry.ts) must not count here. Orphan detection
 * lives in .dependency-cruiser.consumers.cjs (pre-compilation, because a
 * type-only import IS a consumer when the question is "does anything read me").
 *
 * Run: npm run dep:check    Graph: npm run dep:graph
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular VALUE imports mean the runtime graph lies. Type-only edges do not exist at runtime (e.g. serverRegistry imports ServerType from serverCore.ts, serverCore would import its functions back - one of those edges is erased at compile time). src/core/types.ts is the sanctioned seam for shared wire types.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'types-ts-stays-pure',
      severity: 'error',
      comment:
        'src/core/types.ts holds wire-format types and SSE events ONLY (repo convention). No runtime imports — it exists to break cycles, not to join them.',
      from: { path: '^src/core/types\\.ts$' },
      to: { pathNot: ['\\.json$'] },
    },
    {
      name: 'core-no-host',
      severity: 'error',
      comment:
        'src/core/ is the Node-only product boundary (core restructuring, complete 2026-10-05): no runtime imports back into host source (vscode/copilot/, vscode/state/, vscode/ui/, vscode/commands/, vscode/migrations/, vscode/logging/, extension.ts). The type-only variant lives in .dependency-cruiser.consumers.cjs — both must fire together.',
      from: { path: '^src/core/' },
      to: { path: '^src/(?!core/)' },
    },
    {
      name: 'core-no-undeclared-deps',
      severity: 'error',
      comment:
        'Core may import only its declared runtime deps (eventsource-parser, jsonrepair, best-effort-json-parser). This also owns the editor-package ban: `vscode` resolves to node_modules/@types/vscode as npm-dev (verified 2026-10-03 — a `^vscode$` path rule can never match it). The phase-8 proof installs the packed core outside this repo, where an undeclared bare import that works here detonates for every consumer.',
      from: { path: '^src/core/' },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-no-pkg', 'npm-unknown'],
        pathNot: 'node_modules[/\\\\](eventsource-parser|jsonrepair|best-effort-json-parser)[/\\\\]',
      },
    },
    {
      name: 'state-layer-no-ui-or-commands',
      severity: 'error',
      comment:
        'The state layer (src/vscode/state/: config, configStore, usage and personality wrappers) and the boot migrations (src/vscode/migrations/) are read by everyone and depend on nobody above them - no commands, no UI, no copilot pipeline, not even the file logger. If this fires, the state layer grew a reach into a layer above it - inversion, fix by moving the consumer logic down (a pure connection fact belongs in core serverCore). KNOWN EXCEPTION: migrations/outputLengthMigration -> commands/presets is logged as P5-2 in docs/complexity-audit.md (keep/defer); it is allowed below and dies when that finding executes.',
      from: {
        path: '^src/vscode/(state|migrations)/[^/]+\\.ts$',
      },
      to: {
        path: '^src/vscode/(commands/|ui/|copilot/|logging/)',
        pathNot: ['^src/vscode/commands/presets\\.(ts|js)$'],
      },
    },
    {
      name: 'copilot-no-ui',
      severity: 'error',
      comment:
        'The request pipeline (src/vscode/copilot/) must never reach into dashboard/webview/metrics/diagnostics UI surfaces or command modules. It may read state (src/vscode/state/) - that is data, not views.',
      from: { path: '^src/vscode/copilot/[^/]+\\.ts$' },
      to: {
        path: '^src/vscode/(ui|commands)/',
      },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    doNotFollow: { path: 'node_modules' },
    // Post-compilation edges: type-only imports vanish at runtime, so the cycle
    // check must not count them (config.ts <-> serverRegistry.ts is one such
    // phantom cycle: the return edge is `import type`).
    tsPreCompilationDeps: false,
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
    reporterOptions: {
      dot: { collapsePattern: 'node_modules/(@[^/]+/[^/]+|[^/]+)' },
    },
  },
};
