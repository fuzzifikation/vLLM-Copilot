import { describe, it, expect } from 'vitest';
import { deriveTokenBudget } from '../src/tokenBudget.js';

describe('deriveTokenBudget', () => {
  it('uses server max_model_len when present, global config for output', () => {
    const b = deriveTokenBudget(8000, 4096, undefined);
    expect(b.maxModelLen).toBe(8000);
    expect(b.maxOutputTokens).toBe(4096);
    expect(b.maxInputTokens).toBe(3904);
    expect(b.maxInputTokens + b.maxOutputTokens).toBe(8000);
  });

  it('uses global config output even when server max is large', () => {
    const b = deriveTokenBudget(262144, 8192, undefined);
    expect(b.maxModelLen).toBe(262144);
    expect(b.maxOutputTokens).toBe(8192); // global config, not 5%
    expect(b.maxInputTokens).toBe(253952);
  });

  it('throws when server omits max_model_len', () => {
    expect(() => deriveTokenBudget(undefined, 4096, undefined, 'test-model')).toThrow(
      'Server did not report max_model_len for model test-model'
    );
  });

  it('per-model override beats global config', () => {
    const b = deriveTokenBudget(10000, 4096, { maxOutputTokens: 3000 });
    expect(b.maxOutputTokens).toBe(3000);
    expect(b.maxInputTokens).toBe(7000); // 10000 - 3000
    expect(b.maxInputTokens + b.maxOutputTokens).toBe(10000);
  });

  it('honors maxInputTokens override as-is', () => {
    const b = deriveTokenBudget(10000, 4096, { maxInputTokens: 2000 });
    expect(b.maxInputTokens).toBe(2000);
    expect(b.maxOutputTokens).toBe(4096); // global config
  });

  it('honors both overrides', () => {
    const b = deriveTokenBudget(10000, 4096, { maxInputTokens: 6000, maxOutputTokens: 1000 });
    expect(b.maxInputTokens).toBe(6000);
    expect(b.maxOutputTokens).toBe(1000);
  });

  it('never returns negative input when output override exceeds window', () => {
    const b = deriveTokenBudget(1000, 4096, { maxOutputTokens: 2000 });
    expect(b.maxInputTokens).toBeGreaterThanOrEqual(0);
  });

  it('clamps maxInputTokens when overrides exceed maxModelLen', () => {
    // maxInputTokens override (8000) + maxOutputTokens override (3000) = 11000 > 10000
    const b = deriveTokenBudget(10000, 4096, { maxInputTokens: 8000, maxOutputTokens: 3000 });
    expect(b.maxOutputTokens).toBe(3000);
    expect(b.maxInputTokens).toBe(7000); // clamped: min(8000, 10000 - 3000)
    expect(b.maxInputTokens + b.maxOutputTokens).toBeLessThanOrEqual(b.maxModelLen);
  });
});
