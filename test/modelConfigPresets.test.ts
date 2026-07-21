import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePresetJson } from '../src/autoConfig.js';

/**
 * Guards the shipped model-configs/ presets: every JSON must parse through the
 * real loader (parsePresetJson, incl. comment-stripping + jsonrepair) and expose
 * a usable identity + modes. These files are packaged into the VSIX and applied
 * by Auto-Configure, so a malformed preset would silently break for end users.
 */
const configsDir = fileURLToPath(new URL('../model-configs/', import.meta.url));
const presetFiles = readdirSync(configsDir).filter(f => f.endsWith('.json'));

describe('shipped model-configs presets', () => {
  it('has at least one preset', () => {
    expect(presetFiles.length).toBeGreaterThan(0);
  });

  for (const file of presetFiles) {
    it(`${file} parses and has id + modes`, () => {
      const text = readFileSync(configsDir + file, 'utf8');
      const cfg = parsePresetJson(text);
      expect(cfg, `${file} failed to parse`).not.toBeNull();
      // Identity used for matching (id or vllmModelId).
      expect(cfg!.id || cfg!.vllmModelId).toBeTruthy();
      // Presets exist to supply modes; each should define at least one.
      expect(Object.keys(cfg!.modelModes ?? {}).length).toBeGreaterThan(0);
      // If a defaultMode is set it must reference a real mode.
      if (cfg!.defaultMode) {
        expect(Object.keys(cfg!.modelModes ?? {})).toContain(cfg!.defaultMode);
      }
    });
  }
});
