import { describe, it, expect } from 'vitest';
import { parsePresetJson, findPresetForModel } from '../src/autoConfig.js';
import { normalizeModelId } from '../src/config.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const PRESET_PATH = path.resolve(__dirname, '../model-configs/Poolside-Laguna-S-2.1.json');

describe('Poolside Laguna-S-2.1 preset', () => {
  // Regression: the served id `poolside/Laguna-S-2.1-NVFP4` must resolve to the
  // base preset via `normalizeModelId` stripping the `-NVFP4` suffix, then
  // match the preset's id `poolside/Laguna-S-2.1` via findPresetForModel.
  it('matches a NVFP4-quantized served id', async () => {
    const text = await fs.readFile(PRESET_PATH, 'utf8');
    const config = parsePresetJson(text);
    expect(config).not.toBeNull();
    expect(config?.vllmModelId).toBe('poolside/Laguna-S-2.1');

    const preset = { config: config!, sourceFile: 'Poolside-Laguna-S-2.1.json' };
    const servedId = 'poolside/Laguna-S-2.1-NVFP4';
    expect(normalizeModelId(servedId)).toBe('poolside/Laguna-S-2.1');
    expect(findPresetForModel([preset], servedId)).toBe(preset);
  });
});
