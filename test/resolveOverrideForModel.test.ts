import { describe, it, expect } from 'vitest';
import { resolveOverrideForModel } from '../src/config.js';
import type { ModelConfig } from '../src/config.js';

describe('resolveOverrideForModel', () => {
  it('matches an override by its explicit id', () => {
    const overrides: ModelConfig[] = [
      { id: 'fast', server: 'srv', vllmModelId: 'Qwen/Qwen3-8B', modelModes: { Think: {} } },
    ];
    expect(resolveOverrideForModel(overrides, 'fast')).toBe(overrides[0]);
  });

  it('matches a config by its wire id when that is the config id', () => {
    // The common case: no explicit rename, so the config key IS the wire model id.
    const overrides: ModelConfig[] = [
      { id: 'Qwen/Qwen3-8B', server: 'srv', vllmModelId: 'Qwen/Qwen3-8B', modelModes: { Think: {} } },
    ];
    expect(resolveOverrideForModel(overrides, 'Qwen/Qwen3-8B')).toBe(overrides[0]);
  });

  it('keys the same wire model on two servers apart by distinct config ids', () => {
    const overrides: ModelConfig[] = [
      { id: 'qwen-a', server: 'a', vllmModelId: 'Qwen/Qwen3-8B', maxOutputTokens: 1024 },
      { id: 'qwen-b', server: 'b', vllmModelId: 'Qwen/Qwen3-8B', maxOutputTokens: 2048 },
    ];
    expect(resolveOverrideForModel(overrides, 'qwen-a')).toBe(overrides[0]);
    expect(resolveOverrideForModel(overrides, 'qwen-b')).toBe(overrides[1]);
  });

  it('never resolves a config by a composite "model on host" id', () => {
    // Composite picker ids are gone: `id` is required and the picker id IS the
    // config key. The old round-trip lookup must not match anything.
    const overrides: ModelConfig[] = [
      { id: 'X', server: 'h', vllmModelId: 'X' },
    ];
    expect(resolveOverrideForModel(overrides, 'X on h:8000')).toBeUndefined();
  });

  it('does not match by vllmModelId when the config carries a different id', () => {
    // `id` is the sole lookup key — a wire id that differs from the config id
    // resolves nothing.
    const overrides: ModelConfig[] = [
      { id: 'my-custom', server: 'h', vllmModelId: 'X' },
    ];
    expect(resolveOverrideForModel(overrides, 'X')).toBeUndefined();
  });

  it('disambiguates configs sharing a wire id by their ids', () => {
    const overrides: ModelConfig[] = [
      { id: 'preset-a', server: 'srv', vllmModelId: 'server-x' },
      { id: 'preset-b', server: 'srv', vllmModelId: 'server-x' },
    ];
    expect(resolveOverrideForModel(overrides, 'preset-b')).toBe(overrides[1]);
  });

  it('returns undefined when no override matches', () => {
    const overrides: ModelConfig[] = [{ id: 'fast', server: 'srv' }];
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
      { id: 'Qwen/Qwen3.6-27B', server: 'srv', vllmModelId: 'Qwen/Qwen3.6-27B' },
      { id: 'meta-llama/Llama-4-Scalar', server: 'srv', vllmModelId: 'meta-llama/Llama-4-Scalar' },
    ];
    expect(resolveOverrideForModel(overrides, 'meta-llama/Llama-4-Scalar-FP8')).toBeUndefined();
  });

  it('does NOT cross-match different models or orgs (exact only)', () => {
    // Cross-org + quantization forgiveness is gone. "nvidia/DeepSeek-V4-Flash-NVFP4"
    // must not resolve to a deepseek-ai base preset — that was the silent lie that
    // made T&R report OK for a config whose chat request the server would reject.
    const overrides: ModelConfig[] = [
      { id: 'deepseek-ai/DeepSeek-V4-Flash', server: 'srv', vllmModelId: 'deepseek-ai/DeepSeek-V4-Flash' },
    ];
    expect(resolveOverrideForModel(overrides, 'nvidia/DeepSeek-V4-Flash-NVFP4')).toBeUndefined();
    // Same-model-same-org still matches exactly.
    expect(resolveOverrideForModel(overrides, 'deepseek-ai/DeepSeek-V4-Flash')).toBe(overrides[0]);
  });
});
