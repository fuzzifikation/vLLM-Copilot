import { describe, it, expect } from 'vitest';
import { buildAuthHeaders, resolveServerType, resolveModelSettings, resolveMaxTokensForRequest, buildModelId, toPublicModelConfig, type ModelConfig } from '../src/config.js';
import type { ServerEntry } from '../src/serverRegistry.js';

// ── resolveMaxTokensForRequest ──────────────────────────────────────────

describe('resolveMaxTokensForRequest', () => {
  it('falls back to the model ceiling when nothing is configured', () => {
    expect(resolveMaxTokensForRequest(undefined, undefined, 4096, 32768)).toBe(4096);
  });

  it('honors the selected mode max_tokens over defaultParams (coherent advertised)', () => {
    const override = {
      id: 'm', server: 'srv',
      defaultParams: { max_tokens: 1000 },
      modelModes: { Think: { max_tokens: 8000 }, Fast: {} },
    };
    // Advertised = 8000 (metadata re-registered to the mode's budget).
    expect(resolveMaxTokensForRequest(override, 'Think', 8000, 32768)).toBe(8000);
    // A mode without max_tokens falls back to defaultParams (below advertised).
    expect(resolveMaxTokensForRequest(override, 'Fast', 8000, 32768)).toBe(1000);
  });

  it('clamps a configured max_tokens to the advertised budget (never exceeds it)', () => {
    // Finding 2 / Option A: Copilot was told 8000 (advertised, already ceiling +
    // window clamped). A mode wanting 32000 must not send more than advertised —
    // the wire can never exceed what Copilot was told.
    const override = {
      id: 'm', server: 'srv',
      modelModes: { Big: { max_tokens: 32000 } },
    };
    expect(resolveMaxTokensForRequest(override, 'Big', 8000, 32768)).toBe(8000);
  });

  it('clamps to the context window as defense when the advertised budget is incoherent', () => {
    const override = {
      id: 'm', server: 'srv',
      modelModes: { Big: { max_tokens: 100000 } },
    };
    // Advertised (99999) exceeds window-1 — only reachable with an incoherent
    // model object; deriveTokenBudget never produces this. Window 32768 → 32767.
    expect(resolveMaxTokensForRequest(override, 'Big', 99999, 32768)).toBe(32767);
  });

  it('floors fractional/negative values and ignores non-numeric max_tokens', () => {
    const badMode = { id: 'm', server: 'srv', modelModes: { X: { max_tokens: 'lots' as any } } };
    expect(resolveMaxTokensForRequest(badMode, 'X', 4096, 32768)).toBe(4096);
    const frac = { id: 'm', server: 'srv', modelModes: { X: { max_tokens: 12.9 } } };
    expect(resolveMaxTokensForRequest(frac, 'X', 4096, 32768)).toBe(12);
  });

  it('never returns a budget below 1', () => {
    const override = { id: 'm', server: 'srv', modelModes: { X: { max_tokens: -5 } } };
    expect(resolveMaxTokensForRequest(override, 'X', 4096, 32768)).toBe(1);
  });

  it('picker outranks mode and defaultParams max_tokens', () => {
    const override = {
      id: 'm', server: 'srv',
      defaultParams: { max_tokens: 1000 },
      modelModes: { Think: { max_tokens: 8000 } },
    };
    // Even though Think wants 8000, the explicit UI pick (4096) wins.
    expect(resolveMaxTokensForRequest(override, 'Think', 8000, 32768, 4096)).toBe(4096);
    // Picking the full advertised length still works.
    expect(resolveMaxTokensForRequest(override, 'Think', 8000, 32768, 8000)).toBe(8000);
  });

  it('clamps the picker pick to the advertised ceiling too', () => {
    const override = { id: 'm', server: 'srv', modelModes: { Think: { max_tokens: 8000 } } };
    // A stale cached schema offering more than advertised must not exceed it.
    expect(resolveMaxTokensForRequest(override, 'Think', 8000, 32768, 32000)).toBe(8000);
  });

  it('ignores a non-finite picker value and falls back to mode/defaultParams', () => {
    const override = {
      id: 'm', server: 'srv',
      defaultParams: { max_tokens: 1000 },
      modelModes: { Think: { max_tokens: 8000 } },
    };
    expect(resolveMaxTokensForRequest(override, 'Think', 8000, 32768, Number.NaN)).toBe(8000);
    // undefined picker → legacy resolution unchanged.
    expect(resolveMaxTokensForRequest(override, 'Think', 8000, 32768, undefined)).toBe(8000);
  });

  it('floors a fractional picker pick', () => {
    expect(resolveMaxTokensForRequest(undefined, undefined, 8000, 32768, 4096.9)).toBe(4096);
  });
});

// ── resolveServerType ───────────────────────────────────────────────────

describe('resolveServerType', () => {
  const servers: ServerEntry[] = [
    { id: 'plain', serverUrl: 'http://a:8000' },
    { id: 'lm', serverUrl: 'http://b:8000', serverType: 'lmstudio' },
    { id: 'llama', serverUrl: 'http://c:8000', serverType: 'llamacpp' },
    { id: 'oll', serverUrl: 'http://d:8000', serverType: 'ollama' },
    { id: 'v', serverUrl: 'http://e:8000', serverType: 'vllm' },
  ];
  const model = (server: string): ModelConfig => ({ id: 'm', server });

  it('always returns vllm for an undefined model or an entry without an explicit type (policy)', () => {
    expect(resolveServerType(undefined, servers)).toBe('vllm');
    expect(resolveServerType(model('plain'), servers)).toBe('vllm');
  });

  it('a dangling server ref falls back to vllm, same as a missing type', () => {
    expect(resolveServerType(model('ghost'), servers)).toBe('vllm');
    expect(resolveServerType(model('plain'), [])).toBe('vllm');
  });

  it('returns the explicit backend of the referenced entry', () => {
    expect(resolveServerType(model('lm'), servers)).toBe('lmstudio');
    expect(resolveServerType(model('llama'), servers)).toBe('llamacpp');
    expect(resolveServerType(model('oll'), servers)).toBe('ollama');
    expect(resolveServerType(model('v'), servers)).toBe('vllm');
  });
});

describe('resolveModelSettings', () => {
  it('normalizes invalid transport and retry values before runtime control flow', () => {
    expect(resolveModelSettings({
      id: 'm',
      server: 'srv',
      maxOutputTokens: Number.NaN,
      estimateCharsPerToken: Number.NaN,
      streamInactivityTimeout: -10,
      initialResponseTimeoutMs: Number.POSITIVE_INFINITY,
      autoContinueRetries: -1,
    })).toEqual({
      maxOutputTokens: 4096,
      estimateCharsPerToken: 3.5,
      streamInactivityTimeout: 0,
      initialResponseTimeoutMs: 600000,
      autoContinueRetries: 0,
    });
  });

  it('floors retry counts to a non-negative integer', () => {
    expect(resolveModelSettings({ id: 'm', server: 'srv', autoContinueRetries: 2.9 }).autoContinueRetries).toBe(2);
  });
});

// ── toPublicModelConfig ───────────────────────────────────────────────────

describe('toPublicModelConfig', () => {
  const base = { id: 'm', vllmModelId: 'wire', server: 'srv' } satisfies ModelConfig;

  it('returns a copy unchanged — models carry no credentials post-registry', () => {
    expect(toPublicModelConfig(base)).toEqual(base);
    expect(toPublicModelConfig(base)).not.toBe(base);
  });

  it('strips legacy credential keys a hand-edited settings.json smuggles back', () => {
    const cfg = {
      ...base,
      displayName: 'Model',
      requestHeaders: { Authorization: ['Bearer', 'secret-a'].join(' ') },
      apiKey: 'plain-secret',
    } as unknown as ModelConfig;
    const out = toPublicModelConfig(cfg);
    expect(out.displayName).toBe('Model');
    expect('requestHeaders' in out).toBe(false);
    expect('apiKey' in out).toBe(false);
  });
});

describe('buildAuthHeaders', () => {
  it('sets Authorization Bearer when key is present', () => {
    const headers = buildAuthHeaders('my-key');
    expect(headers['Authorization']).toBe('Bearer my-key');
    expect(headers['x-api-key']).toBeUndefined();
  });
});

// ── buildModelId ──────────────────────────────────────────────────────────

describe('buildModelId', () => {
  it('formats as "<model> on <entry-id>"', () => {
    expect(buildModelId('localhost-8000', 'zai-glm-52')).toBe('zai-glm-52 on localhost-8000');
  });

  it('preserves slashes and colons in the wire id (repo-style and suffixed ids)', () => {
    expect(buildModelId('gw-8000', 'zai-org/GLM-5.2')).toBe('zai-org/GLM-5.2 on gw-8000');
    expect(buildModelId('openrouter', 'x/y:free')).toBe('x/y:free on openrouter');
  });

  it('produces distinct ids for the same model on two entries — even entries sharing one host', () => {
    // The point of keying on the ENTRY id: same URL + different credentials is
    // two entries, and both serving the same wire model must not collide.
    const a = buildModelId('gw-8000', 'glm');
    const b = buildModelId('gw-8000-2', 'glm');
    expect(a).not.toBe(b);
  });
});
