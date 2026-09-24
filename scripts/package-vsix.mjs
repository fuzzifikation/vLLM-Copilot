#!/usr/bin/env node

/**
 * Package the extension with the MIT license that applies to the distributed
 * VSIX, while leaving the repository's canonical BUSL-1.1 LICENSE untouched.
 *
 * VSCE deliberately does not know about this repository's dual-license split:
 * the manifest says MIT, but the root LICENSE is the BUSL source license. The
 * wrapper therefore swaps in the extension license only for the child package
 * process, removes the root LICENSE exclusion from a temporary ignore file, and
 * restores the original bytes in `finally` on success or failure.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const licensePath = join(root, 'LICENSE');
const ignorePath = join(root, '.vscodeignore');
const mitTemplatePath = join(root, 'scripts', 'extension-license-mit.txt');
const vsceEntry = join(root, 'node_modules', '@vscode', 'vsce', 'vsce');

const originalLicense = readFileSync(licensePath);
const originalLicenseText = originalLicense.toString('utf8');
if (!originalLicenseText.includes('Business Source License 1.1')) {
  throw new Error('Refusing to package: root LICENSE is not the expected BUSL-1.1 source license.');
}

const mitLicense = readFileSync(mitTemplatePath);
if (!mitLicense.toString('utf8').includes('MIT License')) {
  throw new Error('Refusing to package: scripts/extension-license-mit.txt is not an MIT license.');
}

const packageIgnore = readFileSync(ignorePath, 'utf8')
  .split(/\r?\n/)
  .filter(line => line.trim() !== 'LICENSE')
  .join('\n') + '\n';

const tempDir = mkdtempSync(join(tmpdir(), 'vllm-copilot-vsce-'));
const tempIgnorePath = join(tempDir, '.vscodeignore');
let exitCode = 1;

try {
  // VSCE needs both the MIT manifest license and a real LICENSE file to package
  // without prompting. The temporary ignore file re-includes that file; the
  // canonical .vscodeignore remains unchanged for direct/manual packaging.
  writeFileSync(tempIgnorePath, packageIgnore);
  writeFileSync(licensePath, mitLicense);

  const result = spawnSync(process.execPath, [vsceEntry, 'package', '--ignoreFile', tempIgnorePath], {
    cwd: root,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  exitCode = result.status ?? 1;
} finally {
  // Restore the source-repository license even when VSCE fails or is cancelled.
  writeFileSync(licensePath, originalLicense);
  rmSync(tempDir, { recursive: true, force: true });
}

process.exitCode = exitCode;
