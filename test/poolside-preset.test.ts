import { describe, it, expect } from 'vitest';
import { parsePresetJson, findPresetForModel } from '../src/commands/presets.js';
import * as fs from 'fs/promises';
import * as path from 'path';

const PRESET_PATH = path.resolve(__dirname, '../model-configs/Poolside-Laguna-S-2.1.json');

describe('Poolside Laguna-S-2.1 preset', () => {
  // Regression: the served id `poolside/Laguna-S-2.1-NVFP4` (org prefix +
  // quantization suffix) must resolve to the base preset via the case-insensitive
  // substring matcher — no normalization needed.
  it('matches a NVFP4-quantized served id', async () => {
    const text = await fs.readFile(PRESET_PATH, 'utf8');
    const config = parsePresetJson(text);
    expect(config).not.toBeNull();
    expect(config?.vllmModelId).toBe('Laguna-S-2.1');

    const preset = { config: config!, sourceFile: 'Poolside-Laguna-S-2.1.json' };
    expect(findPresetForModel([preset], 'poolside/Laguna-S-2.1-NVFP4')).toBe(preset);
  });
});
