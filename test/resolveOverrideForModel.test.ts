import { describe, it, expect } from 'vitest';
import { resolveOverrideForModel, normalizeModelId } from '../src/config.js';
import type { ModelConfig } from '../src/config.js';

describe('resolveOverrideForModel', () => {
  it('matches an override by its explicit id', () => {
    const overrides: ModelConfig[] = [
      { id: 'fast', vllmModelId: 'Qwen/Qwen3-8B', modelModes: { Think: {} } },
    ];
    expect(resolveOverrideForModel(overrides, 'fast')).toBe(overrides[0]);
  });

  it('matches an id-less override (vllmModelId only) by the server model id', () => {
    // buildModelInfo gives this model the server id, so the request-time lookup
    // must resolve via vllmModelId. Regression test for the dropped-modelModes bug.
    const overrides: ModelConfig[] = [
      { vllmModelId: 'Qwen/Qwen3-8B', modelModes: { Think: {} } },
    ];
    expect(resolveOverrideForModel(overrides, 'Qwen/Qwen3-8B')).toBe(overrides[0]);
  });

  it('prefers id over vllmModelId when both are set', () => {
    const overrides: ModelConfig[] = [
      { id: 'preset-a', vllmModelId: 'server-x' },
      { id: 'preset-b', vllmModelId: 'server-x' },
    ];
    expect(resolveOverrideForModel(overrides, 'preset-b')).toBe(overrides[1]);
  });

  it('returns undefined when no override matches', () => {
    const overrides: ModelConfig[] = [{ id: 'fast' }];
    expect(resolveOverrideForModel(overrides, 'other')).toBeUndefined();
  });

  it('returns undefined for an empty override list', () => {
    expect(resolveOverrideForModel([], 'any')).toBeUndefined();
  });

  it('matches quantized variant against base model config (fuzzy)', () => {
    const overrides: ModelConfig[] = [
      { id: 'Qwen/Qwen3.6-27B', vllmModelId: 'Qwen/Qwen3.6-27B' },
      { id: 'meta-llama/Llama-4-Scalar', vllmModelId: 'meta-llama/Llama-4-Scalar' },
    ];
    expect(resolveOverrideForModel(overrides, 'meta-llama/Llama-4-Scalar-FP8')).toBe(overrides[1]);
    // Llama-FP8 should NOT match Qwen config
    expect(resolveOverrideForModel(overrides, 'meta-llama/Llama-4-Scalar-FP8')).not.toBe(overrides[0]);
  });
});

describe('normalizeModelId', () => {
  it('strips common quantization suffixes', () => {
    expect(normalizeModelId('Qwen/Qwen3.6-27B-FP8')).toBe('Qwen/Qwen3.6-27B');
    expect(normalizeModelId('Qwen/Qwen3.6-27B-GGUF')).toBe('Qwen/Qwen3.6-27B');
    expect(normalizeModelId('Qwen/Qwen3.6-27B-GPTQ')).toBe('Qwen/Qwen3.6-27B');
    expect(normalizeModelId('Qwen/Qwen3.6-27B-AWQ')).toBe('Qwen/Qwen3.6-27B');
    expect(normalizeModelId('Qwen/Qwen3.6-27B-INT4')).toBe('Qwen/Qwen3.6-27B');
    expect(normalizeModelId('Qwen/Qwen3.6-27B-INT8')).toBe('Qwen/Qwen3.6-27B');
    expect(normalizeModelId('Qwen/Qwen3.6-27B-NF4')).toBe('Qwen/Qwen3.6-27B');
  });

  it('leaves base model ids unchanged', () => {
    expect(normalizeModelId('Qwen/Qwen3.6-27B')).toBe('Qwen/Qwen3.6-27B');
    expect(normalizeModelId('deepseek-ai/DeepSeek-V4-Flash')).toBe('deepseek-ai/DeepSeek-V4-Flash');
    expect(normalizeModelId('InternScience/Agents-A1')).toBe('InternScience/Agents-A1');
  });
});
