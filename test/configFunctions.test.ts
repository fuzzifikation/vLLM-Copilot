import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildAuthHeaders, validateConfig, resolveServerType, resolveModelSettings, resolveMaxTokensForRequest, buildModelId, resolveWorkspaceRelativePath, toPublicModelConfig, type VllmConfig } from '../src/config.js';

// ── resolveMaxTokensForRequest ──────────────────────────────────────────

describe('resolveMaxTokensForRequest', () => {
  it('falls back to the model ceiling when nothing is configured', () => {
    expect(resolveMaxTokensForRequest(undefined, undefined, 4096, 32768)).toBe(4096);
  });

  it('honors the selected mode max_tokens over defaultParams (coherent advertised)', () => {
    const override = {
      id: 'm', serverUrl: 'http://host:8000',
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
      id: 'm', serverUrl: 'http://host:8000',
      modelModes: { Big: { max_tokens: 32000 } },
    };
    expect(resolveMaxTokensForRequest(override, 'Big', 8000, 32768)).toBe(8000);
  });

  it('clamps to the context window as defense when the advertised budget is incoherent', () => {
    const override = {
      id: 'm', serverUrl: 'http://host:8000',
      modelModes: { Big: { max_tokens: 100000 } },
    };
    // Advertised (99999) exceeds window-1 — only reachable with an incoherent
    // model object; deriveTokenBudget never produces this. Window 32768 → 32767.
    expect(resolveMaxTokensForRequest(override, 'Big', 99999, 32768)).toBe(32767);
  });

  it('floors fractional/negative values and ignores non-numeric max_tokens', () => {
    const badMode = { id: 'm', serverUrl: 'http://host:8000', modelModes: { X: { max_tokens: 'lots' as any } } };
    expect(resolveMaxTokensForRequest(badMode, 'X', 4096, 32768)).toBe(4096);
    const frac = { id: 'm', serverUrl: 'http://host:8000', modelModes: { X: { max_tokens: 12.9 } } };
    expect(resolveMaxTokensForRequest(frac, 'X', 4096, 32768)).toBe(12);
  });

  it('never returns a budget below 1', () => {
    const override = { id: 'm', serverUrl: 'http://host:8000', modelModes: { X: { max_tokens: -5 } } };
    expect(resolveMaxTokensForRequest(override, 'X', 4096, 32768)).toBe(1);
  });
});

// ── resolveServerType ───────────────────────────────────────────────────

describe('resolveServerType', () => {
  it('always returns vllm when the field is missing (policy)', () => {
    expect(resolveServerType(undefined)).toBe('vllm');
    expect(resolveServerType({} as any)).toBe('vllm');
    expect(resolveServerType({ serverType: undefined } as any)).toBe('vllm');
  });

  it('returns the explicit backend when set', () => {
    expect(resolveServerType({ serverType: 'lmstudio' } as any)).toBe('lmstudio');
    expect(resolveServerType({ serverType: 'llamacpp' } as any)).toBe('llamacpp');
    expect(resolveServerType({ serverType: 'ollama' } as any)).toBe('ollama');
    expect(resolveServerType({ serverType: 'vllm' } as any)).toBe('vllm');
  });
});

describe('resolveModelSettings', () => {
  it('normalizes invalid transport and retry values before runtime control flow', () => {
    expect(resolveModelSettings({
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
    expect(resolveModelSettings({ autoContinueRetries: 2.9 }).autoContinueRetries).toBe(2);
  });
});

// ── toPublicModelConfig ───────────────────────────────────────────────────

describe('toPublicModelConfig', () => {
  const base = { id: 'm', vllmModelId: 'wire', serverUrl: 'http://h:8000' } as any;

  it('returns a copy unchanged when there are no credentials', () => {
    expect(toPublicModelConfig(base)).toEqual(base);
    expect(toPublicModelConfig(base)).not.toBe(base);
  });

  it('redacts header values but keeps key names (output-channel log)', () => {
    const out = toPublicModelConfig({ ...base, requestHeaders: { Authorization: 'Bearer sekrit', 'X-Key': 'abc' } });
    expect(out.requestHeaders).toEqual({ Authorization: '[REDACTED]', 'X-Key': '[REDACTED]' });
    expect(JSON.stringify(out)).not.toContain('sekrit');
    expect(JSON.stringify(out)).not.toContain('abc');
  });

  it('drops the requestHeaders field entirely when strip is set (webview)', () => {
    const out = toPublicModelConfig({ ...base, requestHeaders: { Authorization: 'Bearer sekrit' } }, { strip: true });
    expect('requestHeaders' in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain('sekrit');
  });

  it('keeps all non-credential fields', () => {
    const cfg = { ...base, displayName: 'Model', serverType: 'vllm', defaultParams: { temperature: 0.7 } };
    const out = toPublicModelConfig(cfg);
    expect(out.displayName).toBe('Model');
    expect(out.serverType).toBe('vllm');
    expect(out.defaultParams).toEqual({ temperature: 0.7 });
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
    models: [{ id: 'm', serverUrl: 'http://localhost:8000' }],
    enableFileLogging: false,
  };
}

/** Helper: build a config with a single model carrying the given fields. */
function withModel(model: Record<string, unknown>): VllmConfig {
  return { ...makeValidConfig(), models: [{ id: 'm', serverUrl: 'http://localhost:8000', ...model }] };
}

describe('validateConfig', () => {
  it('returns no warnings for a valid config', () => {
    const warnings = validateConfig(makeValidConfig());
    expect(warnings).toHaveLength(0);
  });

  it('warns when a model has no serverUrl', () => {
    const warnings = validateConfig({ ...makeValidConfig(), models: [{ id: 'm' }] });
    expect(warnings.some(w => w.includes('serverUrl'))).toBe(true);
  });

  it('accepts every known serverType without warning', () => {
    for (const serverType of ['vllm', 'lmstudio', 'llamacpp', 'ollama', 'openrouter']) {
      const warnings = validateConfig(withModel({ serverType }));
      expect(warnings.some(w => w.includes('serverType'))).toBe(false);
    }
  });

  it('warns on an unknown serverType', () => {
    const warnings = validateConfig(withModel({ serverType: 'anything' }));
    expect(warnings.some(w => w.includes('serverType'))).toBe(true);
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
    const warnings = validateConfig({ ...makeValidConfig(), models: [{ vllmModelId: 'no-id', serverUrl: 'http://localhost:8000' }] });
    expect(warnings.some(w => w.includes('missing id'))).toBe(true);
  });

  it('warns on duplicate ids', () => {
    const warnings = validateConfig({
      ...makeValidConfig(),
      models: [
        { id: 'dup', serverUrl: 'http://localhost:8000' },
        { id: 'dup', vllmModelId: 'other-model', serverUrl: 'http://localhost:9000' },
      ],
    });
    expect(warnings.some(w => w.includes('duplicate id'))).toBe(true);
  });

  it('does not warn when two models share a vllmModelId but have distinct ids', () => {
    const warnings = validateConfig({
      ...makeValidConfig(),
      models: [
        { id: 'm1', vllmModelId: 'shared', serverUrl: 'http://a:8000' },
        { id: 'm2', vllmModelId: 'shared', serverUrl: 'http://b:8000' },
      ],
    });
    expect(warnings.some(w => w.includes('duplicate id'))).toBe(false);
    expect(warnings.some(w => w.includes('missing id'))).toBe(false);
  });
});

