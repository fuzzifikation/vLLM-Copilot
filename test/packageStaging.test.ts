import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/**
 * TRIPWIRE for the dual-license split, because the failure mode is a COMMIT.
 *
 * Packaging used to overwrite the tracked root LICENSE with the MIT text and
 * restore it afterwards. A hard kill cannot restore it, and the self-heal on the
 * next packaging run does not help a commit made in between: the wrong license
 * lands in permanent history. The wrapper now packages from a staged copy, so
 * the root file is never written, and this test fails if anyone reintroduces a
 * direct edit of it.
 */
describe('dual-license invariants', () => {
  // One `vsce ls` costs 4.6-4.7 s on an idle machine (measured 2026-11-11),
  // and Vitest's default budget is 5000 ms: the tripwire went red from load
  // alone, on a subprocess whose speed is not what the assertion is about.
  // Everything the packager must hand to the runtime is asserted in THIS one
  // run, because a second `vsce ls` would double the cost for no new signal.
  it('includes the runtime update page and the harness payload in the actual VSCE payload list', { timeout: 30_000 }, () => {
    const result = spawnSync(process.execPath, [
      join(ROOT, 'node_modules', '@vscode', 'vsce', 'vsce'), 'ls', '--no-dependencies',
    ], { cwd: ROOT, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.split(/\r?\n/);
    expect(lines).toContain('resources/update.md');
    // The harness is a feature of this extension now, and it runs from files
    // outside out/: the plugin dsh loads, the shared helpers the extension
    // imports at runtime, the certified version pin and the status-bar font.
    // A `.vscodeignore` edit that drops one ships a harness that cannot start,
    // with every unit test still green.
    for (const required of [
      'dsh/dsh.json',
      'dsh/plugin/index.js',
      'dsh/plugin/adapter.js',
      'dsh/plugin/package.json',
      'dsh/plugin/cordis.patch.yml',
      'dsh/shared/overlay.mjs',
      'dsh/shared/core-staging.mjs',
      'resources/dsh-icons.woff2',
    ]) {
      expect(lines, `${required} missing from the VSIX payload`).toContain(required);
    }
    // Type-only and never loaded: the `**/*.d.mts` rule must keep it out.
    expect(lines).not.toContain('dsh/shared/overlay.d.mts');
  });

  it('keeps the root LICENSE byte-identical to the BUSL source of truth', () => {
    // An in-place MIT substitution, however it happened, shows up here as a
    // modification and fails the suite before it can be committed.
    expect(read('LICENSE')).toBe(read(join('licenses', 'LICENSE-BUSL-1.1.txt')));
  });

  it('holds the BUSL source license at the root, never the MIT extension license', () => {
    const root = read('LICENSE');
    expect(root.split(/\r?\n/)[0]).toBe('Business Source License 1.1');
    // Not a substring check: the BUSL grant clause legitimately NAMES the MIT
    // license as a possible Additional Use Grant, so "contains MIT License"
    // proves nothing about which text is installed.
    expect(root).not.toBe(read(join('licenses', 'LICENSE-MIT.txt')));
  });

  it('keeps both canonical license texts in licenses/', () => {
    expect(read(join('licenses', 'LICENSE-BUSL-1.1.txt'))).toContain('Business Source License 1.1');
    expect(read(join('licenses', 'LICENSE-MIT.txt'))).toContain('MIT License');
    expect(read('package.json')).toContain('"license": "MIT"');
  });

  it('keeps the licenses folder out of the shipped extension', () => {
    // Shipping the folder would put the source license inside the VSIX next to
    // a manifest that declares MIT.
    expect(read('.vscodeignore')).toMatch(/^licenses\/$/m);
  });

  it('keeps the extension-host E2E harness out of the shipped extension', () => {
    // Real leak, caught 2026-10-05: the first packaged build after adding
    // test/e2e carried five out-e2e/ files into the VSIX (130 -> 135 entries),
    // and no existing check noticed — the staging test verifies required
    // content, never forbidden content. Harness code, mocha scenarios and a
    // downloaded VS Code must never reach a user's machine.
    const ignore = read('.vscodeignore');
    expect(ignore).toMatch(/^out-e2e\/$/m);
    expect(ignore).toMatch(/^\.vscode-test\/$/m);
    expect(ignore).toMatch(/^\.vscode-test\.mjs$/m);
  });

  it('keeps the core-proof fixtures out of the shipped extension', () => {
    // parity/ is 18.8 KB of scenario and fixture JSON that only scripts/ reads
    // (core-proof, parity-export). Nothing on the runtime path opens it, and the
    // packager copies the whole tree, so a build-time directory ships silently
    // unless a check names it.
    const ignore = read('.vscodeignore');
    expect(ignore).toMatch(/^parity\/$/m);
  });

  it('packages through the staging wrapper from the build', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    expect(scripts['package:vsix']).toContain('package-vsix.mjs');
    expect(scripts.build).toContain('package:vsix');
  });

  it('ships the core declarations and emits them inside the prepublish path', () => {
    // The staged core's typed surface depends on TWO build facts, and each can
    // die silently: (a) the gitignore-style `*.ts` rule above also matches
    // `.d.ts`, so the negation is the only reason out/core/*.d.ts ships —
    // dropping it un-types the bridge's staged copy with every test still
    // green; (b) `vscode:prepublish` reruns `compile`, whose rmSync wipes
    // out/, so `core:decl` must run INSIDE compile or packaging ships JS with
    // no declarations. Pin both.
    const ignore = read('.vscodeignore');
    expect(ignore).toMatch(/^!out\/core\/\*\*\/\*\.d\.ts$/m);
    const scripts = JSON.parse(read('package.json')).scripts;
    expect(scripts.compile).toContain('core:decl');
  });

  it('refuses to overwrite an edited root license during packaging', () => {
    const root = mkdtempSync(join(tmpdir(), 'vllm-license-draft-'));
    const sourceLicense = 'Business Source License 1.1\n';
    const draft = 'work in progress\n';
    try {
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, 'licenses'));
      copyFileSync(join(ROOT, 'scripts', 'package-vsix.mjs'), join(root, 'scripts', 'package-vsix.mjs'));
      writeFileSync(join(root, 'licenses', 'LICENSE-BUSL-1.1.txt'), sourceLicense);
      writeFileSync(join(root, 'licenses', 'LICENSE-MIT.txt'), 'MIT License\n');
      writeFileSync(join(root, 'LICENSE'), draft);

      const result = spawnSync(process.execPath, [join(root, 'scripts', 'package-vsix.mjs')], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('root LICENSE does not match');
      expect(readFileSync(join(root, 'LICENSE'), 'utf8')).toBe(draft);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
