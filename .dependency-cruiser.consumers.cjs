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
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { exportsFields: ['exports'], conditionNames: ['import', 'require', 'node', 'default'] },
  },
};
