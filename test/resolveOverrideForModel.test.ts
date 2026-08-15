import { describe, it, expect } from 'vitest';
import { resolveOverrideForModel } from '../src/config.js';
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

  it('does NOT match a quantized variant against a base-model config (exact only)', () => {
    // `vllmModelId` is a wire identity: it must exactly equal one of the server's
    // served ids. A hand-edited config pointing at "Llama-4-Scalar" against a
    // server serving "Llama-4-Scalar-FP8" violates that contract — it must NOT
    // resolve (the picker entry came from a config whose id was the served name).
    const overrides: ModelConfig[] = [
      { id: 'Qwen/Qwen3.6-27B', vllmModelId: 'Qwen/Qwen3.6-27B' },
      { id: 'meta-llama/Llama-4-Scalar', vllmModelId: 'meta-llama/Llama-4-Scalar' },
    ];
    expect(resolveOverrideForModel(overrides, 'meta-llama/Llama-4-Scalar-FP8')).toBeUndefined();
  });

  it('does NOT cross-match different models or orgs (exact only)', () => {
    // Cross-org + quantization forgiveness is gone. "nvidia/DeepSeek-V4-Flash-NVFP4"
    // must not resolve to a deepseek-ai base preset — that was the silent lie that
    // made T&R report OK for a config whose chat request the server would reject.
    const overrides: ModelConfig[] = [
      { id: 'deepseek-ai/DeepSeek-V4-Flash', vllmModelId: 'deepseek-ai/DeepSeek-V4-Flash' },
    ];
    expect(resolveOverrideForModel(overrides, 'nvidia/DeepSeek-V4-Flash-NVFP4')).toBeUndefined();
    // Same-model-same-org still matches exactly.
    expect(resolveOverrideForModel(overrides, 'deepseek-ai/DeepSeek-V4-Flash')).toBe(overrides[0]);
  });
});
