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

  it('ignores non-finite input and output overrides', () => {
    expect(deriveTokenBudget(8192, 1024, {
      maxOutputTokens: Number.NaN,
      maxInputTokens: Number.NaN,
    })).toEqual({
      maxModelLen: 8192,
      maxOutputTokens: 1024,
      maxInputTokens: 7168,
    });
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

  it('clamps a 0/negative maxOutputTokens override to at least 1', () => {
    // A 0 would pass through as max_tokens: 0, which vLLM rejects.
    expect(deriveTokenBudget(10000, 4096, { maxOutputTokens: 0 }).maxOutputTokens).toBeGreaterThanOrEqual(1);
    expect(deriveTokenBudget(10000, 4096, { maxOutputTokens: -5 }).maxOutputTokens).toBeGreaterThanOrEqual(1);
  });

  it('clamps a 0/negative maxInputTokens override to at least 1', () => {
    // A 0/negative override would otherwise advertise a model with no input.
    expect(deriveTokenBudget(10000, 4096, { maxInputTokens: 0 }).maxInputTokens).toBeGreaterThanOrEqual(1);
    expect(deriveTokenBudget(10000, 4096, { maxInputTokens: -5 }).maxInputTokens).toBeGreaterThanOrEqual(1);
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

  it('reserves at least one input token even when the output budget consumes the window', () => {
    // Default 4096 output budget on a model whose window is <= 4096 used to
    // clamp output to the full window, leaving maxInputTokens = 0 — a model
    // that cannot accept any prompt at all. The output budget must yield one
    // token of input headroom so the model stays usable.
    const b = deriveTokenBudget(4096, 4096, undefined);
    expect(b.maxInputTokens).toBeGreaterThanOrEqual(1);
    expect(b.maxOutputTokens).toBeLessThanOrEqual(b.maxModelLen - 1);
    expect(b.maxInputTokens + b.maxOutputTokens).toBe(b.maxModelLen);

    const c = deriveTokenBudget(2048, 4096, undefined);
    expect(c.maxInputTokens).toBeGreaterThanOrEqual(1);
    expect(c.maxOutputTokens).toBe(2047);
    expect(c.maxInputTokens + c.maxOutputTokens).toBe(c.maxModelLen);
  });

  it('clamps maxInputTokens when overrides exceed maxModelLen', () => {
    // maxInputTokens override (8000) + maxOutputTokens override (3000) = 11000 > 10000
    const b = deriveTokenBudget(10000, 4096, { maxInputTokens: 8000, maxOutputTokens: 3000 });
    expect(b.maxOutputTokens).toBe(3000);
    expect(b.maxInputTokens).toBe(7000); // clamped: min(8000, 10000 - 3000)
    expect(b.maxInputTokens + b.maxOutputTokens).toBeLessThanOrEqual(b.maxModelLen);
  });

  it('clamps output to a server-reported ceiling when present', () => {
    const b = deriveTokenBudget(32768, 8192, undefined, undefined, 4096);
    expect(b.maxOutputTokens).toBe(4096);
    expect(b.maxInputTokens + b.maxOutputTokens).toBeLessThanOrEqual(b.maxModelLen);
  });

  it('reported ceiling wins over a larger configured output budget', () => {
    // Configured default 8192 but the backend reports a 2048 completion ceiling.
    const b = deriveTokenBudget(32768, 8192, { maxOutputTokens: 8192 }, undefined, 2048);
    expect(b.maxOutputTokens).toBe(2048);
    expect(b.maxInputTokens + b.maxOutputTokens).toBeLessThanOrEqual(b.maxModelLen);
  });

  it('a 0/negative reported ceiling degrades to 1 token, never ignored', () => {
    expect(deriveTokenBudget(10000, 4096, undefined, undefined, 0).maxOutputTokens).toBeGreaterThanOrEqual(1);
    expect(deriveTokenBudget(10000, 4096, undefined, undefined, -5).maxOutputTokens).toBeGreaterThanOrEqual(1);
  });

  it('undefined reported ceiling leaves the derived budget unchanged', () => {
    const withCeiling = deriveTokenBudget(10000, 3000, undefined, undefined, 8000);
    const withoutCeiling = deriveTokenBudget(10000, 3000, undefined, undefined, undefined);
    expect(withCeiling.maxOutputTokens).toBe(3000);
    expect(withCeiling.maxOutputTokens).toBe(withoutCeiling.maxOutputTokens);
  });

  it('a NaN reported ceiling is ignored, never poisoning the budget', () => {
    const b = deriveTokenBudget(10000, 4096, undefined, undefined, NaN);
    expect(b.maxOutputTokens).toBe(4096);
    expect(Number.isNaN(b.maxOutputTokens)).toBe(false);
    expect(Number.isNaN(b.maxInputTokens)).toBe(false);
    expect(Number.isNaN(b.maxModelLen)).toBe(false);
    expect(b.maxInputTokens + b.maxOutputTokens).toBeLessThanOrEqual(b.maxModelLen);
  });
});
