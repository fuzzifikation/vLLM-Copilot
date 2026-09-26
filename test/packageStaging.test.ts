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

  it('packages through the staging wrapper from the build', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    expect(scripts['package:vsix']).toContain('package-vsix.mjs');
    expect(scripts.build).toContain('package:vsix');
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
