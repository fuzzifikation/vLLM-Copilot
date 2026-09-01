import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildAuthHeaders, validateConfig, resolveServerType, resolveModelSettings, resolveMaxTokensForRequest, buildModelId, resolveWorkspaceRelativePath, toPublicModelConfig, type VllmConfig, type ModelConfig } from '../src/config.js';
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

  it('keeps ordinary model fields', () => {
    const cfg: ModelConfig = { ...base, displayName: 'Model', defaultParams: { temperature: 0.7 } };
    const out = toPublicModelConfig(cfg);
    expect(out.displayName).toBe('Model');
    expect(out.defaultParams).toEqual({ temperature: 0.7 });
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

// ── resolveWorkspaceRelativePath ──────────────────────────────────────────

describe('resolveWorkspaceRelativePath', () => {
  const originalFolders = (vscode.workspace as any).workspaceFolders;

  afterEach(() => {
    (vscode.workspace as any).workspaceFolders = originalFolders;
  });

  it('returns an absolute path normalized unchanged', () => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    expect(resolveWorkspaceRelativePath('/a/b.json')).toBe(path.resolve('/a/b.json'));
  });

  it('resolves a relative path against the first workspace folder', () => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/ws' } }];
    expect(resolveWorkspaceRelativePath('.vllm/repl.json')).toBe(path.resolve('/ws', '.vllm/repl.json'));
  });

  it('resolves against the process cwd when no workspace folder is open', () => {
    (vscode.workspace as any).workspaceFolders = undefined;
    expect(resolveWorkspaceRelativePath('.vllm/repl.json')).toBe(path.resolve('.vllm/repl.json'));
  });
});

// ── buildAuthHeaders ──────────────────────────────────────────────────────

describe('buildAuthHeaders', () => {
  it('returns empty object when apiKey is undefined', () => {
    expect(buildAuthHeaders(undefined)).toEqual({});
  });

  it('returns empty object when apiKey is empty string', () => {
    expect(buildAuthHeaders('')).toEqual({});
  });

  it('sets Authorization Bearer when key is present', () => {
    const headers = buildAuthHeaders('my-key');
    expect(headers['Authorization']).toBe('Bearer my-key');
    expect(headers['x-api-key']).toBeUndefined();
  });
});

// ── buildModelId ──────────────────────────────────────────────────────────

describe('buildModelId', () => {
  it('formats as "<model> on <host>" using the host', () => {
    expect(buildModelId('https://host.example.com', 'zai-glm-52')).toBe('zai-glm-52 on host.example.com');
  });

  it('keeps the port in the host', () => {
    expect(buildModelId('http://10.0.0.5:8000', 'my-model')).toBe('my-model on 10.0.0.5:8000');
  });

  it('strips scheme and path, keeping only host:port', () => {
    expect(buildModelId('https://host:9000/v1', 'm')).toBe('m on host:9000');
  });

  it('normalizes a scheme-less server URL before extracting the host', () => {
    expect(buildModelId('localhost:8000', 'm')).toBe('m on localhost:8000');
  });

  it('preserves slashes in the vllm model id (repo-style ids)', () => {
    expect(buildModelId('http://host:8000', 'zai-org/GLM-5.2')).toBe('zai-org/GLM-5.2 on host:8000');
  });

  it('produces distinct ids for the same model on two servers', () => {
    const a = buildModelId('http://a.example.com:8000', 'glm');
    const b = buildModelId('http://b.example.com:8000', 'glm');
    expect(a).not.toBe(b);
  });
});

// ── validateConfig ────────────────────────────────────────────────────────

/** Minimal valid config for validation tests (per-model). */
function makeValidConfig(): VllmConfig {
  return {
    models: [{ id: 'm', server: 'srv' }],
    servers: [{ id: 'srv', serverUrl: 'http://localhost:8000' }],
    enableFileLogging: false,
  };
}

/** Helper: build a config with a single model carrying the given fields. */
function withModel(model: Record<string, unknown>): VllmConfig {
  return { ...makeValidConfig(), models: [{ id: 'm', server: 'srv', ...model }] };
}

describe('validateConfig', () => {
  it('returns no warnings for a valid config', () => {
    const warnings = validateConfig(makeValidConfig());
    expect(warnings).toHaveLength(0);
  });

  it('warns when a model has no server reference', () => {
    const warnings = validateConfig({ ...makeValidConfig(), models: [{ id: 'm' } as ModelConfig] });
    expect(warnings.some(w => w.includes('no server reference'))).toBe(true);
  });

  it('warns when a model references an unknown server id (dangling ref)', () => {
    const warnings = validateConfig(withModel({ server: 'ghost' }));
    expect(warnings.some(w => w.includes('references unknown server'))).toBe(true);
  });

  it('warns on registry entries with a missing or duplicate id', () => {
    const noId = validateConfig({
      ...makeValidConfig(),
      servers: [{ id: '', serverUrl: 'http://localhost:8000' }],
    });
    expect(noId.some(w => w.includes('missing its id'))).toBe(true);
    const dup = validateConfig({
      ...makeValidConfig(),
      servers: [
        { id: 'srv', serverUrl: 'http://localhost:8000' },
        { id: 'srv', serverUrl: 'http://localhost:9000' },
      ],
    });
    expect(dup.some(w => w.includes('duplicate id'))).toBe(true);
  });

  it('warns when two entries are the same connection (same URL + auth), ignoring header-name case', () => {
    const dup = validateConfig({
      ...makeValidConfig(),
      models: [],
      servers: [
        { id: 'a', serverUrl: 'http://localhost:8000', requestHeaders: { Authorization: 'k' } },
        { id: 'b', serverUrl: 'http://localhost:8000', requestHeaders: { authorization: 'k' } },
      ],
    });
    expect(dup.some(w => w.includes('"a" and "b"') && w.includes('same server connection'))).toBe(true);
    // Different credentials = different identities → no warning (credential isolation).
    const distinct = validateConfig({
      ...makeValidConfig(),
      models: [],
      servers: [
        { id: 'a', serverUrl: 'http://localhost:8000', requestHeaders: { Authorization: 'k1' } },
        { id: 'b', serverUrl: 'http://localhost:8000', requestHeaders: { Authorization: 'k2' } },
      ],
    });
    expect(distinct.some(w => w.includes('same server connection'))).toBe(false);
  });

  it('accepts every known routing mode without warning', () => {
    for (const routingMode of ['standard', 'nitro', 'exacto']) {
      const warnings = validateConfig(withModel({ routingMode }));
      expect(warnings.some(w => w.includes('routingMode'))).toBe(false);
    }
  });

  it('warns on an unknown routing mode', () => {
    const warnings = validateConfig(withModel({ routingMode: 'turbo' }));
    expect(warnings.some(w => w.includes('routingMode'))).toBe(true);
  });

  it('warns on maxOutputTokens <= 0', () => {
    expect(validateConfig(withModel({ maxOutputTokens: 0 })).length).toBeGreaterThan(0);
    expect(validateConfig(withModel({ maxOutputTokens: -1 })).length).toBeGreaterThan(0);
  });

  it('accepts a valid descending maxOutputTokens vector without warning', () => {
    expect(validateConfig(withModel({ maxOutputTokens: [16384, 8192, 4096] }))).toHaveLength(0);
  });

  it('warns on a malformed maxOutputTokens vector', () => {
    // Empty array is indistinguishable from omitting the field — still a typo.
    expect(validateConfig(withModel({ maxOutputTokens: [] })).some(w => w.includes('maxOutputTokens'))).toBe(true);
    // Non-positive or fractional entries break the enum contract.
    expect(validateConfig(withModel({ maxOutputTokens: [8192, 0] })).some(w => w.includes('positive integers'))).toBe(true);
    expect(validateConfig(withModel({ maxOutputTokens: [8192, 4096.5] })).some(w => w.includes('positive integers'))).toBe(true);
    // Ascending order (or duplicates) violate "first entry is the default, strictly descending".
    expect(validateConfig(withModel({ maxOutputTokens: [8192, 16384] })).some(w => w.includes('descending'))).toBe(true);
    expect(validateConfig(withModel({ maxOutputTokens: [8192, 8192] })).some(w => w.includes('descending'))).toBe(true);
    // More than 8 entries — the picker only offers the first 8.
    const nine = Array.from({ length: 9 }, (_, i) => (9 - i) * 1024);
    expect(validateConfig(withModel({ maxOutputTokens: nine })).some(w => w.includes('first 8'))).toBe(true);
  });

  it('warns on estimateCharsPerToken <= 0', () => {
    expect(validateConfig(withModel({ estimateCharsPerToken: 0 })).length).toBeGreaterThan(0);
    expect(validateConfig(withModel({ estimateCharsPerToken: -1 })).length).toBeGreaterThan(0);
  });

  it('warns on negative streamInactivityTimeout', () => {
    const warnings = validateConfig(withModel({ streamInactivityTimeout: -100 }));
    expect(warnings.some(w => w.includes('streamInactivityTimeout'))).toBe(true);
  });

  it('does not warn when streamInactivityTimeout is 0 (disabled)', () => {
    const warnings = validateConfig(withModel({ streamInactivityTimeout: 0 }));
    expect(warnings.some(w => w.includes('streamInactivityTimeout'))).toBe(false);
  });

  it('warns on negative initialResponseTimeoutMs', () => {
    const warnings = validateConfig(withModel({ initialResponseTimeoutMs: -100 }));
    expect(warnings.some(w => w.includes('initialResponseTimeoutMs'))).toBe(true);
  });

  it('does not warn when initialResponseTimeoutMs is 0 (disabled)', () => {
    const warnings = validateConfig(withModel({ initialResponseTimeoutMs: 0 }));
    expect(warnings.some(w => w.includes('initialResponseTimeoutMs'))).toBe(false);
  });

  it('warns on negative autoContinueRetries', () => {
    const warnings = validateConfig(withModel({ autoContinueRetries: -1 }));
    expect(warnings.some(w => w.includes('autoContinueRetries'))).toBe(true);
  });

  it('warns on defaultParams.temperature out of range', () => {
    expect(validateConfig(withModel({ defaultParams: { temperature: -1 } })).length).toBeGreaterThan(0);
    expect(validateConfig(withModel({ defaultParams: { temperature: 3 } })).length).toBeGreaterThan(0);
  });

  it('does not warn on defaultParams.temperature within range', () => {
    const warnings = validateConfig(withModel({ defaultParams: { temperature: 0.7 } }));
    expect(warnings.some(w => w.includes('temperature'))).toBe(false);
  });

  it('warns on defaultParams.top_p out of range', () => {
    expect(validateConfig(withModel({ defaultParams: { top_p: -0.1 } })).length).toBeGreaterThan(0);
    expect(validateConfig(withModel({ defaultParams: { top_p: 1.5 } })).length).toBeGreaterThan(0);
  });

  it('warns on defaultParams.top_k === 0 or < -1', () => {
    expect(validateConfig(withModel({ defaultParams: { top_k: 0 } })).length).toBeGreaterThan(0);
    expect(validateConfig(withModel({ defaultParams: { top_k: -5 } })).length).toBeGreaterThan(0);
  });

  it('warns on defaultParams.repetition_penalty out of range', () => {
    expect(validateConfig(withModel({ defaultParams: { repetition_penalty: 0 } })).length).toBeGreaterThan(0);
    expect(validateConfig(withModel({ defaultParams: { repetition_penalty: 2.5 } })).length).toBeGreaterThan(0);
  });

  it('validates params inside each model mode', () => {
    const warnings = validateConfig(withModel({ modelModes: { Think: { temperature: 5 } } }));
    expect(warnings.some(w => w.includes('mode "Think"') && w.includes('temperature'))).toBe(true);
  });

  it('warns when a model entry has no id', () => {
    const warnings = validateConfig({ ...makeValidConfig(), models: [{ vllmModelId: 'no-id', server: 'srv' } as ModelConfig] });
    expect(warnings.some(w => w.includes('missing id'))).toBe(true);
  });

  it('warns on duplicate ids', () => {
    const warnings = validateConfig({
      ...makeValidConfig(),
      models: [
        { id: 'dup', server: 'srv' },
        { id: 'dup', vllmModelId: 'other-model', server: 'srv' },
      ],
    });
    expect(warnings.some(w => w.includes('duplicate id'))).toBe(true);
  });

  it('does not warn when two models share a vllmModelId but have distinct ids', () => {
    const warnings = validateConfig({
      ...makeValidConfig(),
      models: [
        { id: 'm1', vllmModelId: 'shared', server: 'srv' },
        { id: 'm2', vllmModelId: 'shared', server: 'srv' },
      ],
    });
    expect(warnings.some(w => w.includes('duplicate id'))).toBe(false);
    expect(warnings.some(w => w.includes('missing id'))).toBe(false);
  });
});

