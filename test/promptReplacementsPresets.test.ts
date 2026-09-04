import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPersonalityMeta, loadPromptReplacements } from '../src/persona/promptReplacer.js';

/**
 * Guards the shipped prompt-replacements/ files: every JSON must parse through
 * the real loader (promptReplacer.ts) and expose usable rules. These files are
 * packaged into the VSIX and applied to system messages at request time, so a
 * malformed preset would silently break (a personality that never applies) for
 * end users — the picker would skip it or the request-time load would fail.
 *
 * Mirrors modelConfigPresets.test.ts (which guards model-configs/) for the
 * personality side. The docs/ copies are documentation references, not what
 * discovery loads — only this shipped directory is guarded.
 */
const replDir = fileURLToPath(new URL('../prompt-replacements/', import.meta.url));
const replFiles = readdirSync(replDir).filter(f => f.endsWith('.json'));

describe('shipped prompt-replacements files', () => {
  it('has at least one replacement file', () => {
    expect(replFiles.length).toBeGreaterThan(0);
  });

  for (const file of replFiles) {
    it(`${file} parses through the real loader with non-empty rules`, async () => {
      const absPath = replDir + file;
      // Throws on malformed JSON / wrong shape (unlike loadPersonalityMeta,
      // which swallows errors) — so a broken file fails this test.
      const rules = await loadPromptReplacements(absPath);
      expect(rules.length, `${file} has no usable rules`).toBeGreaterThan(0);
    });

    it(`${file} carries a name and description`, async () => {
      const absPath = replDir + file;
      const meta = await loadPersonalityMeta(absPath);
      // Every shipped prompt-replacements file must carry meta.name +
      // description. This is NOT an assertion that each is a personality:
      // prompt-replacements-common.json is the shared rules file, explicitly
      // excluded from personality discovery by promptReplacer.ts (CR-107).
      expect(meta?.name?.length ?? 0).toBeGreaterThan(0);
      expect(meta?.description?.length ?? 0).toBeGreaterThan(0);
    });
  }
});
