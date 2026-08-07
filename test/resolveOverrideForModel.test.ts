import { describe, it, expect } from 'vitest';
import { resolveOverrideForModel, normalizeModelId, modelMatchKey } from '../src/config.js';
import type { ModelConfig } from '../src/config.js';

describe('resolveOverrideForModel', () => {
  it('matches an override by its explicit id', () => {
    const overrides: ModelConfig[] = [
      { id: 'fast', vllmModelId: 'Qwen/Qwen3-8B', modelModes: { Think: {} } },
    ];
    expect(resolveOverrideForModel(overrides, 'fast')).toBe(overrides[0]);
  });

  it('matches an id-less override (vllmModelId only) by the server model id', () => {
    // A config with no serverUrl never reaches the picker (discovery skips it),
    // but the matcher must still resolve bare wire ids defensively.
    const overrides: ModelConfig[] = [
      { vllmModelId: 'Qwen/Qwen3-8B', modelModes: { Think: {} } },
    ];
    expect(resolveOverrideForModel(overrides, 'Qwen/Qwen3-8B')).toBe(overrides[0]);
  });

  it('round-trips a derived composite id back to an id-less config', () => {
    // Discovery assigns id-less configs the composite id "<model> on <host>"
    // (buildModelId). The request-time lookup must resolve it back to the config.
    const overrides: ModelConfig[] = [
      { vllmModelId: 'Qwen/Qwen3-8B', serverUrl: 'http://h:8000', modelModes: { Think: {} } },
    ];
    expect(resolveOverrideForModel(overrides, 'Qwen/Qwen3-8B on h:8000')).toBe(overrides[0]);
  });

  it('keeps the same vllmModelId on two servers distinct via composite ids', () => {
    const overrides: ModelConfig[] = [
      { vllmModelId: 'Qwen/Qwen3-8B', serverUrl: 'http://a:8000', maxOutputTokens: 1024 },
      { vllmModelId: 'Qwen/Qwen3-8B', serverUrl: 'http://b:8000', maxOutputTokens: 2048 },
    ];
    expect(resolveOverrideForModel(overrides, 'Qwen/Qwen3-8B on a:8000')).toBe(overrides[0]);
    expect(resolveOverrideForModel(overrides, 'Qwen/Qwen3-8B on b:8000')).toBe(overrides[1]);
  });

  it('does not match a composite id to an id\'d config sharing the wire id and server', () => {
    // The composite id belongs to the id-less config only — an id'd config that
    // shares the same wire id + server must not be matched by the other's id.
    const overrides: ModelConfig[] = [
      { id: 'my-custom', vllmModelId: 'X', serverUrl: 'http://h:8000' },
      { vllmModelId: 'X', serverUrl: 'http://h:8000' },
    ];
    expect(resolveOverrideForModel(overrides, 'X on h:8000')).toBe(overrides[1]);
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

  it('matches a cross-org quantized variant against the base model (name-only)', () => {
    // nvidia's NVFP4 quantized DeepSeek-V4-Flash must resolve to the
    // deepseek-ai preset: quantization only changes weight precision, and the
    // serving org is irrelevant to inference parameters.
    const overrides: ModelConfig[] = [
      { id: 'deepseek-ai/DeepSeek-V4-Flash', vllmModelId: 'deepseek-ai/DeepSeek-V4-Flash' },
    ];
    expect(resolveOverrideForModel(overrides, 'nvidia/DeepSeek-V4-Flash-NVFP4')).toBe(overrides[0]);
  });

  it('does not cross-match different models that share an org-stripped token substring', () => {
    // "DeepSeek-V4-Flash" must not match a "DeepSeek-V4-Chat" preset just because
    // they share the "deepseek" prefix after org stripping.
    const overrides: ModelConfig[] = [
      { id: 'deepseek-ai/DeepSeek-V4-Chat', vllmModelId: 'deepseek-ai/DeepSeek-V4-Chat' },
    ];
    expect(resolveOverrideForModel(overrides, 'nvidia/DeepSeek-V4-Flash-NVFP4')).toBeUndefined();
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
    expect(normalizeModelId('poolside/Laguna-S-2.1-NVFP4')).toBe('poolside/Laguna-S-2.1');
  });

  it('leaves base model ids unchanged', () => {
    expect(normalizeModelId('Qwen/Qwen3.6-27B')).toBe('Qwen/Qwen3.6-27B');
    expect(normalizeModelId('deepseek-ai/DeepSeek-V4-Flash')).toBe('deepseek-ai/DeepSeek-V4-Flash');
    expect(normalizeModelId('InternScience/Agents-A1')).toBe('InternScience/Agents-A1');
  });
});

describe('modelMatchKey', () => {
  it('strips the org prefix and quantization suffix, then lowercases', () => {
    expect(modelMatchKey('nvidia/DeepSeek-V4-Flash-NVFP4')).toBe('deepseek-v4-flash');
    expect(modelMatchKey('deepseek-ai/DeepSeek-V4-Flash')).toBe('deepseek-v4-flash');
  });

  it('leaves org-less ids intact (minus quantization)', () => {
    expect(modelMatchKey('zai-glm-52')).toBe('zai-glm-52');
    expect(modelMatchKey('zai-glm-52-FP8')).toBe('zai-glm-52');
  });

  it('distinguishes different base models that share a prefix token', () => {
    expect(modelMatchKey('deepseek-ai/DeepSeek-V4-Chat')).not.toBe(
      modelMatchKey('nvidia/DeepSeek-V4-Flash-NVFP4')
    );
  });
});
