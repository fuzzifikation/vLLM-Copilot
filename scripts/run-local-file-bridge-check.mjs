/**
 * Launcher for the local-file-bridge live check, `npm run test:bridge`.
 *
 * It starts a REAL VS Code extension host against a disposable profile and runs
 * test/integration/remoteLocalFileBridge.live.cjs, then requires the runner to
 * leave a PASS artifact on disk. See docs/remote-local-file-bridge.md.
 *
 * Two things this launcher refuses to do, both learned the hard way:
 *   - It does not trust an exit code alone. On Windows, launching the GUI binary
 *     without waiting returns immediately, so a naive harness can print exit code
 *     0 while the workbench is still starting and the profile gets deleted
 *     underneath it. We wait, then demand the result file.
 *   - It does not touch the developer's normal VS Code profile. Isolated
 *     user-data and extensions directories mean no settings, no extensions, and
 *     no state are read or written outside the temp directory.
 *
 * Not part of `npm test`: it needs an installed desktop VS Code, which CI and
 * headless environments do not have.
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const liveTest = join(repoRoot, 'test', 'integration', 'remoteLocalFileBridge.live.cjs');

if (!existsSync(liveTest)) {
  console.error(`Missing ${liveTest}.`);
  process.exit(1);
}

function findVsCodeExecutable() {
  const envPath = process.env.VSCODE_EXECUTABLE_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  // A stock macOS install puts the CLI INSIDE the app bundle and puts nothing
  // on PATH, so the Linux list alone left `npm run test:bridge` unable to find
  // a perfectly normal installation. Both bundle locations are checked: a
  // user-local install in ~/Applications is as standard as the system one.
  //
  // The binary is NOT always called `code`. The Insiders build ships
  // `bin/code-insiders`, so a single `code` name silently misses an Insiders-
  // only machine, which is exactly the developer most likely to run this.
  const macBundle = (app, bin = 'code') =>
    [join('/Applications', app, 'Contents/Resources/app/bin', bin),
     join(process.env.HOME ?? '', 'Applications', app, 'Contents/Resources/app/bin', bin)];
  const candidates =
    process.platform === 'win32'
      ? [
          join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe'),
          join(process.env.ProgramFiles ?? '', 'Microsoft VS Code', 'Code.exe'),
        ]
      : process.platform === 'darwin'
        ? [
            ...macBundle('Visual Studio Code.app'),
            ...macBundle('Visual Studio Code.app', 'code-insiders'),
            ...macBundle('Visual Studio Code - Insiders.app', 'code-insiders'),
            ...macBundle('Visual Studio Code - Insiders.app'),
            ...macBundle('VSCodium.app', 'codium'),
            '/usr/local/bin/code',
            '/opt/homebrew/bin/code',
          ]
        : ['/usr/bin/code', '/usr/local/bin/code', '/snap/bin/code'];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

const executable = findVsCodeExecutable();
if (!executable) {
  console.error('No VS Code executable found. Set VSCODE_EXECUTABLE_PATH to your installed build.');
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), 'vllm-copilot-bridge-'));
const extensionsDir = join(root, 'extensions');
const userDataDir = join(root, 'user-data');
const extensionDir = join(root, 'harness');
const resultFile = join(root, 'result.json');

for (const directory of [extensionsDir, userDataDir, extensionDir]) {
  mkdirSync(directory, { recursive: true });
}

copyFileSync(liveTest, join(extensionDir, 'live-test.cjs'));
writeFileSync(
  join(extensionDir, 'package.json'),
  `${JSON.stringify({
    name: 'vllm-copilot-bridge-harness',
    version: '0.0.1',
    publisher: 'harness',
    private: true,
    engines: { vscode: '^1.128.0' },
    main: './noop.js',
    extensionKind: ['workspace'],
  }, null, 2)}\n`,
  'utf8',
);
writeFileSync(join(extensionDir, 'noop.js'), 'module.exports = { activate() {}, deactivate() {} };\n', 'utf8');

const args = [
  '--no-sandbox',
  '--disable-gpu-sandbox',
  '--disable-updates',
  '--skip-welcome',
  '--skip-release-notes',
  '--no-cached-data',
  '--disable-workspace-trust',
  `--extensions-dir=${extensionsDir}`,
  `--user-data-dir=${userDataDir}`,
  `--extensionDevelopmentPath=${extensionDir}`,
  `--extensionTestsPath=${join(extensionDir, 'live-test.cjs')}`,
];

console.log(`Launching ${executable} for the local-file-bridge check.`);
console.log('This is a manual opt-in check and launches a real VS Code window.\n');

const child = spawn(executable, args, {
  env: { ...process.env, CONFIG_BRIDGE_PROBE_LIVE_RESULT: resultFile },
  stdio: ['ignore', 'ignore', 'ignore'],
  windowsHide: true,
});

const exitCode = await new Promise((resolveExit, rejectExit) => {
  child.on('error', rejectExit);
  child.on('exit', code => resolveExit(code ?? 1));
});

let failed = false;
if (!existsSync(resultFile)) {
  console.error('FAIL: the runner produced no result artifact, so the check cannot be trusted.');
  failed = true;
} else {
  const result = JSON.parse(readFileSync(resultFile, 'utf8'));
  if (result.liveVscodeProvider !== 'PASS') {
    console.error(`FAIL: ${JSON.stringify(result, null, 2)}`);
    failed = true;
  } else {
    console.log(`PASS: ${JSON.stringify(result, null, 2)}`);
  }
}

if (exitCode !== 0) {
  console.error(`FAIL: VS Code exited with code ${exitCode}.`);
  failed = true;
}

rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
