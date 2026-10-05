/**
 * @vscode/test-cli configuration for the Spike A extension-host rail.
 * Downloads a throwaway VS Code stable, loads THIS extension from out/
 * (extensionDevelopmentPath defaults to this file's directory), and runs the
 * compiled scenarios in test/e2e inside the real extension host with a fresh
 * profile under .vscode-test/. Kept out of `npm run build` on purpose.
 */
export default {
  tests: [
    {
      label: 'spike-a',
      files: 'out-e2e/**/*.e2e.js',
      // Empty scratch folder, not the repo: the suite opens a real window and
      // must not drag the entire workspace through the extension host.
      workspaceFolder: 'temp/e2e-workspace',
      launchArgs: ['--disable-workspace-trust', '--disable-updates'],
      // ui MUST be stated: @vscode/test-cli's runner defaults to 'tdd'
      // (suite/test), and a bdd file then dies with "describe is not defined"
      // (bit us 2026-10-05; the same trap reads like an ESM loader bug).
      // Same trap family: keep fixtures wire-accurate — a fixture that splits
      // a tool name "proved" a bug vLLM cannot produce (name is sent whole,
      // exactly once). The mock lying is worse than the mock missing.
      mocha: { ui: 'bdd', timeout: 240000 },
    },
  ],
};
