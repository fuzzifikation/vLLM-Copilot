#!/usr/bin/env node

/**
 * Package the extension from a STAGED COPY of the working tree.
 *
 * VSCE has no option to read the license from anywhere but the package root
 * (`--skip-license` is the only alternative, and it drops the license entirely),
 * so packaging has always meant putting an MIT `LICENSE` at the repository root
 * for the duration of the child process and putting the BUSL one back after.
 * `finally` covers a clean exit and a thrown error. It does NOT cover a hard
 * kill, and the self-heal on the next run protects the SECOND run, not a commit
 * made in between: the window between the kill and the next package still ends
 * with the MIT text staged for git.
 *
 * The only way to close that window is to stop writing to the tracked file at
 * all, so that is what this does. The working tree is copied to a temp
 * directory, the runtime dependencies are copied in, the MIT license lands in
 * the COPY, and VSCE runs with its cwd inside the copy. The repository root
 * LICENSE is never modified, so a killed run only leaves a temporary folder.
 *
 * Copying the tree (minus .git, node_modules and scratch) rather than
 * maintaining a file list is deliberate. A hand-written payload list is a second
 * source of truth for what ships, and it rots silently the first time a new
 * shipped directory appears. `.vscodeignore` stays the only thing that decides
 * what is included, exactly as before, and the runtime dependencies come from
 * package.json rather than being hardcoded here.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buslPath = join(root, 'licenses', 'LICENSE-BUSL-1.1.txt');
const mitPath = join(root, 'licenses', 'LICENSE-MIT.txt');
const vsceEntry = join(root, 'node_modules', '@vscode', 'vsce', 'vsce');

const busl = readFileSync(buslPath, 'utf8');
if (!busl.includes('Business Source License 1.1')) {
  throw new Error(`Refusing to package: ${buslPath} is not the expected BUSL-1.1 source license.`);
}

const mit = readFileSync(mitPath, 'utf8');
if (!mit.includes('MIT License')) {
  throw new Error(`Refusing to package: ${mitPath} is not an MIT license.`);
}

const rootLicense = join(root, 'LICENSE');
if (!existsSync(rootLicense) || readFileSync(rootLicense, 'utf8') !== busl) {
  throw new Error(`Refusing to package: root LICENSE does not match ${buslPath}. Resolve the difference before packaging; no files were changed.`);
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const runtimeDeps = Object.keys(manifest.dependencies ?? {});

/** Never copied: VCS metadata, the dependency tree (rebuilt below), scratch. */
const SKIP = new Set(['.git', 'node_modules', 'temp', '.tools']);
const stage = mkdtempSync(join(tmpdir(), 'vllm-copilot-vsce-'));
let exitCode = 1;

try {
  // The build hook runs HERE, in the real tree, where the full development
  // dependency tree exists. VSCE would otherwise run it a second time inside the
  // stage, which holds only the shipping dependencies and therefore cannot
  // compile. The stage's manifest drops the hook entirely (below), so it never
  // fires there and `out/` arrives already fresh.
  if (manifest.scripts?.['vscode:prepublish']) {
    // npm's CLI entry point, invoked through the same Node binary. The
    // location depends on how Node itself was installed, so every real layout
    // is probed: `node_modules` beside the binary (Windows installer, fnm,
    // volta), `lib/node_modules` one level up (nvm, Homebrew on Apple Silicon
    // and /usr/local, tarball installs), and `node_modules` one level up
    // (some Linux distro layouts). The previous single probe pointed at one
    // level above the binary and missed the Windows installer layout, so the
    // script fell into the shell path on every Windows run.
    //
    // Spawning `npm.cmd` needs a shell on Windows (Node rejects .cmd shims
    // without one), and shell:true with an argument LIST is exactly what
    // Node's DEP0190 warns about. The last resort is therefore a single
    // fixed command string - no variables, no user input, nothing to escape.
    const exeDir = dirname(process.execPath);
    const npmCli = [
      join(exeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      join(exeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      join(exeDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ].find(candidate => existsSync(candidate));
    const build = npmCli
      ? spawnSync(process.execPath, [npmCli, 'run', 'vscode:prepublish'], { cwd: root, stdio: 'inherit' })
      : spawnSync('npm run vscode:prepublish', { cwd: root, stdio: 'inherit', shell: true });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error('vscode:prepublish failed; not packaging.');
  }

  cpSync(root, stage, {
    recursive: true,
    filter: (src) => {
      const name = basename(src);
      if (name.endsWith('.vsix')) return false;
      return !(SKIP.has(name) && src !== root);
    },
  });

  // The dependencies that actually ship, taken from package.json so a new one
  // is picked up without editing this script. Only these are copied, not the
  // 160 MB development tree, because `.vscodeignore` packs only these.
  mkdirSync(join(stage, 'node_modules'), { recursive: true });
  for (const dep of runtimeDeps) {
    const from = join(root, 'node_modules', dep);
    if (!existsSync(from)) throw new Error(`Runtime dependency ${dep} is not installed.`);
    cpSync(from, join(stage, 'node_modules', dep), { recursive: true });
  }

  // The stage cannot build, so it must not claim to. This is the one byte the
  // shipped manifest loses: an inert build-time hook that VS Code never runs on
  // an installed extension. test/packageStaging.test.ts pins the licensing
  // invariants around it, so the difference stays deliberate and visible.
  const stagedManifestPath = join(stage, 'package.json');
  const stagedManifest = JSON.parse(readFileSync(stagedManifestPath, 'utf8'));
  if (stagedManifest.scripts) delete stagedManifest.scripts['vscode:prepublish'];
  writeFileSync(stagedManifestPath, JSON.stringify(stagedManifest, null, 2) + '\n');

  // The MIT license goes in the COPY. VSCE renames a root LICENSE to
  // extension/LICENSE.txt, and the exclusion line is dropped so it is packed.
  writeFileSync(join(stage, 'LICENSE'), mit);
  const stagedIgnore = join(stage, '.vscodeignore');
  writeFileSync(
    stagedIgnore,
    readFileSync(stagedIgnore, 'utf8')
      .split(/\r?\n/)
      .filter(line => line.trim() !== 'LICENSE')
      .join('\n') + '\n',
  );

  const outFile = join(root, `${manifest.name}-${manifest.version}.vsix`);
  const result = spawnSync(process.execPath, [vsceEntry, 'package', '--out', outFile], {
    cwd: stage,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  exitCode = result.status ?? 1;
} finally {
  rmSync(stage, { recursive: true, force: true });
}

process.exitCode = exitCode;
