import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePresetFile, parsePresetRawJson, PRESET_CONFIG_KEYS } from '../src/commands/presets.js';

/**
 * Guards the shipped model-configs/ presets: every JSON must parse through the
 * real loader (parsePresetFile, incl. comment-stripping + jsonrepair), use the
 * v2 envelope format, and expose valid match/meta/config. These files are
 * packaged into the VSIX and applied by Auto-Configure, so a malformed preset
 * would silently break for end users.
 */
const configsDir = fileURLToPath(new URL('../model-configs/', import.meta.url));
// index.json is the generated remote preset list, not a preset — it is guarded
// separately below.
const INDEX_FILE = 'index.json';
const presetFiles = readdirSync(configsDir).filter(f => f.endsWith('.json') && f !== INDEX_FILE);

describe('shipped model-configs presets', () => {
  it('has at least one preset', () => {
    expect(presetFiles.length).toBeGreaterThan(0);
  });

  for (const file of presetFiles) {
    describe(file, () => {
      const text = readFileSync(configsDir + file, 'utf8');

      it('is a v2 envelope (presetVersion 1 with match list)', () => {
        // Raw check — assert the version tag explicitly (parsePresetFile
        // rejects anything else, but a missing tag here means authoring drift).
        const raw = parsePresetRawJson(text)!;
        expect(raw.presetVersion, `${file} must declare presetVersion`).toBe(1);
        expect(Array.isArray(raw.match) && raw.match.length).toBeGreaterThan(0);
      });

      it('parses through the real loader with usable config', () => {
        const preset = parsePresetFile(text, file);
        expect(preset, `${file} failed to parse`).not.toBeNull();
        expect(preset!.match!.every(m => m.trim().length > 0)).toBe(true);
        // Identity used for matching / merging target.
        expect(preset!.config.vllmModelId).toBeTruthy();
        // Presets exist to supply modes; each should define at least one.
        expect(Object.keys(preset!.config.modelModes ?? {}).length).toBeGreaterThan(0);
        // If a defaultMode is set it must reference a real mode.
        if (preset!.config.defaultMode) {
          expect(Object.keys(preset!.config.modelModes ?? {})).toContain(preset!.config.defaultMode);
        }
      });

      it('config only uses preset-allowed keys', () => {
        const raw = parsePresetRawJson(text)!;
        for (const key of Object.keys(raw.config as Record<string, unknown>)) {
          expect(PRESET_CONFIG_KEYS.has(key), `${file}: unknown config key "${key}"`).toBe(true);
        }
      });

      it('carries user-facing provenance metadata', () => {
        const meta = parsePresetRawJson(text)!.meta as Record<string, string | undefined>;
        expect(typeof meta?.name, `${file}: meta.name must be a string`).toBe('string');
        expect(meta.name!.trim().length).toBeGreaterThan(0);
        expect(typeof meta?.notes, `${file}: meta.notes must be a string`).toBe('string');
        expect(meta.notes!.trim().length).toBeGreaterThan(0);
        if (meta.source !== undefined) {
          expect(meta.source, `${file}: meta.source must be https`).toMatch(/^https:\/\//);
        }
        if (meta.verified !== undefined) {
          expect(meta.verified, `${file}: meta.verified must be YYYY-MM-DD`).toMatch(
            /^\d{4}-\d{2}-\d{2}$/,
          );
        }
      });
    });
  }
});

/**
 * Drift guard for the generated remote preset list (model-configs/index.json):
 * it must list exactly the preset files in this directory with identical match
 * arrays. Regenerate with `npm run gen:presets`, in the same commit as the
 * preset change — a stale index must never ship, and npm run build gates this.
 */
describe('model-configs/index.json (remote preset list)', () => {
  const indexRaw = JSON.parse(readFileSync(configsDir + INDEX_FILE, 'utf8'));

  it('has schemaVersion 1 and a bare object shape', () => {
    expect(indexRaw.schemaVersion).toBe(1);
    expect(typeof indexRaw.updated).toBe('string');
    expect(Array.isArray(indexRaw.presets)).toBe(true);
  });

  it('lists exactly the preset files in this directory', () => {
    const listed = indexRaw.presets.map((e: { file: string }) => e.file).sort();
    expect(listed).toEqual([...presetFiles].sort());
  });

  it('entry match arrays are identical to the preset file match arrays', () => {
    for (const entry of indexRaw.presets) {
      const raw = parsePresetRawJson(readFileSync(configsDir + entry.file, 'utf8'))!;
      expect(entry.match, `index match drift for ${entry.file}`).toEqual(raw.match);
    }
  });

  it('every file is a bare *.json name (no path traversal)', () => {
    for (const entry of indexRaw.presets) {
      expect(entry.file).toMatch(/^[^/\\]+\.json$/);
    }
  });
});
