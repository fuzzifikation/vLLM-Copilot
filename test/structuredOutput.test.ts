import { describe, it, expect } from 'vitest';
import { resolveRequestParams, type ModelConfig } from '../src/config.js';

/**
 * Structured output is now a raw vLLM request param (`structured_outputs`) carried
 * in a model's `defaultParams` or a `modelModes` entry — there is no global setting
 * and no parsing layer. These tests verify it flows through the per-model resolution
 * chain (built-in defaults ← model defaultParams ← selected mode).
 */
describe('structured_outputs via resolveRequestParams', () => {
  it('passes structured_outputs from defaultParams', () => {
    const model: ModelConfig = {
      id: 'm',
      serverUrl: 'http://localhost:8000',
      defaultParams: { structured_outputs: { json: { type: 'object' } } },
    };
    const params = resolveRequestParams(model, undefined);
    expect(params.structured_outputs).toEqual({ json: { type: 'object' } });
  });

  it('is absent when no model/mode sets it', () => {
    const model: ModelConfig = { id: 'm', serverUrl: 'http://localhost:8000' };
    const params = resolveRequestParams(model, undefined);
    expect(params.structured_outputs).toBeUndefined();
  });

  it('mode-scope structured_outputs overrides model-scope', () => {
    const model: ModelConfig = {
      id: 'm',
      serverUrl: 'http://localhost:8000',
      defaultParams: { structured_outputs: { json: { type: 'object' } } },
      modelModes: {
        JSON: { structured_outputs: { regex: '.*' } },
      },
    };
    const params = resolveRequestParams(model, 'JSON');
    expect(params.structured_outputs).toEqual({ regex: '.*' });
  });

  it('supports choice and grammar constraint shapes verbatim', () => {
    const choiceModel: ModelConfig = {
      id: 'm',
      serverUrl: 'http://localhost:8000',
      defaultParams: { structured_outputs: { choice: ['yes', 'no'] } },
    };
    expect(resolveRequestParams(choiceModel, undefined).structured_outputs).toEqual({ choice: ['yes', 'no'] });

    const grammarModel: ModelConfig = {
      id: 'm',
      serverUrl: 'http://localhost:8000',
      defaultParams: { structured_outputs: { grammar: 'root ::= "a"' } },
    };
    expect(resolveRequestParams(grammarModel, undefined).structured_outputs).toEqual({ grammar: 'root ::= "a"' });
  });
});

describe('resolveRequestParams layering', () => {
  it('applies built-in defaults (temperature, top_p) when nothing set', () => {
    const params = resolveRequestParams(undefined, undefined);
    expect(params.temperature).toBe(0.7);
    expect(params.top_p).toBe(1.0);
  });

  it('model defaultParams override built-in defaults', () => {
    const model: ModelConfig = {
      id: 'm',
      serverUrl: 'http://localhost:8000',
      defaultParams: { temperature: 1 },
    };
    expect(resolveRequestParams(model, undefined).temperature).toBe(1);
  });

  it('selected mode overrides model defaultParams', () => {
    const model: ModelConfig = {
      id: 'm',
      serverUrl: 'http://localhost:8000',
      defaultParams: { temperature: 1 },
      modelModes: { Precise: { temperature: 0.6 } },
    };
    expect(resolveRequestParams(model, 'Precise').temperature).toBe(0.6);
  });

  it('unknown mode falls back to model defaultParams', () => {
    const model: ModelConfig = {
      id: 'm',
      serverUrl: 'http://localhost:8000',
      defaultParams: { temperature: 1 },
      modelModes: { Precise: { temperature: 0.6 } },
    };
    expect(resolveRequestParams(model, 'Missing').temperature).toBe(1);
  });
});

describe('resolveRequestParams runtime options layer', () => {
  it('runtime options override built-in defaults', () => {
    const params = resolveRequestParams(undefined, undefined, { max_tokens: 500, temperature: 0.2 });
    expect(params.max_tokens).toBe(500);
    expect(params.temperature).toBe(0.2);
  });

  it('model defaultParams override runtime options', () => {
    const model: ModelConfig = {
      id: 'm',
      serverUrl: 'http://localhost:8000',
      defaultParams: { temperature: 1 },
    };
    // Copilot's runtime temperature is overridden by the model's own defaultParams.
    const params = resolveRequestParams(model, undefined, { temperature: 0.2, max_tokens: 500 });
    expect(params.temperature).toBe(1);
    expect(params.max_tokens).toBe(500); // untouched runtime value passes through
  });

  it('selected mode outranks runtime options and defaultParams', () => {
    const model: ModelConfig = {
      id: 'm',
      serverUrl: 'http://localhost:8000',
      defaultParams: { temperature: 1 },
      modelModes: { Precise: { temperature: 0.6 } },
    };
    const params = resolveRequestParams(model, 'Precise', { temperature: 0.2 });
    expect(params.temperature).toBe(0.6);
  });
});

