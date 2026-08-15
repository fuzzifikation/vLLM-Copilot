import { describe, it, expect, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { autoConfigureModel, resolveModelConfigForAdd, resolveModelConfigForAddSafely } from '../src/commands/hfDiscovery.js';

/**
 * Direct tests for the hfDiscovery module's autoConfigureModel. Global fetch is
 * stubbed and routed by URL so the module is measured without hitting the
 * network: /v1/models → vLLM, /api/models/ → HF model info,
 * /generation_config.json → HF generation config.
 */
describe('autoConfigureModel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  /** Route a fetch call to a stubbed response based on its URL. */
  const stubFetch = (router: (url: string) => Response | Promise<Response>) => {
    const fn = vi.fn(async (url: string) => router(url));
    vi.stubGlobal('fetch', fn);
    return fn;
  };

  it('assembles modelConfig from vLLM + HF discovery (family, defaults, tool calling, suggested tokens)', async () => {
    stubFetch((url: string) => {
      if (url.endsWith('/v1/models')) {
        return jsonResponse({
          data: [{ id: 'org/Model-FP8', root: 'org/Model', max_model_len: 131072 }],
        });
      }
      if (url.includes('/api/models/org/Model')) {
        return jsonResponse({
          id: 'org/Model',
          pipeline_tag: 'text-generation',
          config: { model_type: 'qwen3_5', tokenizer_config: { chat_template: '{{ tools | tool_call }}' } },
        });
      }
      if (url.includes('generation_config.json')) {
        return jsonResponse({ temperature: 0.7, top_p: 0.9 });
      }
      return jsonResponse({}, 404);
    });

    const result = await autoConfigureModel('org/Model-FP8', 'http://host:8000');

    expect(result.modelConfig.family).toBe('qwen3_5');
    expect(result.modelConfig.defaultParams).toEqual({ temperature: 0.7, top_p: 0.9 });
    expect(result.modelConfig.capabilities).toEqual({ toolCalling: true, imageInput: false });
    // id/vllmModelId are the served id, not the resolved HF root.
    expect(result.modelConfig.id).toBe('org/Model-FP8');
    expect(result.modelConfig.vllmModelId).toBe('org/Model-FP8');
    // Suggested tokens = min(floor(131072 * 0.1), cap) = 13107.
    expect(result.suggestedMaxOutputTokens).toBe(13107);
    expect(result.summary.join('\n')).toContain('HF generation defaults: temperature=0.7, top_p=0.9');
  });

  it('falls back to the served model id for HF lookups when vLLM reports no root', async () => {
    const fetchFn = stubFetch((url: string) => {
      if (url.endsWith('/v1/models')) {
        return jsonResponse({ data: [{ id: 'plain-model', max_model_len: 8192 }] });
      }
      // HF lookup must use 'plain-model' (no root available).
      if (url.includes('/api/models/plain-model')) {
        return jsonResponse({ id: 'plain-model', config: { model_type: 'llama' } });
      }
      return jsonResponse({}, 404);
    });

    const result = await autoConfigureModel('plain-model', 'http://host:8000');

    expect(result.modelConfig.family).toBe('llama');
    expect(result.suggestedMaxOutputTokens).toBe(819); // floor(8192 * 0.1)
    expect(fetchFn.mock.calls.some(([u]) => String(u).includes('/api/models/plain-model'))).toBe(true);
  });

  it('THROWS (no context, no model) when the server cannot report a context window', async () => {
    const fetchFn = stubFetch((url: string) => {
      if (url.endsWith('/v1/models')) {
        return jsonResponse({ error: 'nope' }, 503);
      }
      return jsonResponse({}, 404);
    });

    // Strict policy: a model without a resolvable context window is not saved.
    await expect(autoConfigureModel('m', 'http://host:8000')).rejects.toThrow(/HTTP 503/);
    // No HF lookup happened — the flow aborted at the mandatory context check.
    expect(fetchFn.mock.calls.some(([u]) => String(u).includes('/api/models/m'))).toBe(false);
  });

  it('detects vision support from a vision model_type', async () => {
    stubFetch((url: string) => {
      if (url.endsWith('/v1/models')) {
        return jsonResponse({ data: [{ id: 'vl-model', max_model_len: 32768 }] });
      }
      if (url.includes('/api/models/vl-model')) {
        return jsonResponse({ id: 'vl-model', config: { model_type: 'qwen2_5_vl' } });
      }
      return jsonResponse({}, 404);
    });

    const result = await autoConfigureModel('vl-model', 'http://host:8000');

    expect(result.modelConfig.capabilities).toEqual({ toolCalling: true, imageInput: true });
    expect(result.summary.join('\n')).toContain('Vision support detected');
  });

  it('does not claim tool calling when the chat template provably lacks tool markers', async () => {
    stubFetch((url: string) => {
      if (url.endsWith('/v1/models')) {
        return jsonResponse({ data: [{ id: 'plain-text', max_model_len: 8192 }] });
      }
      if (url.includes('/api/models/plain-text')) {
        // A plain chat template with no tools/function_call markers.
        return jsonResponse({
          id: 'plain-text',
          config: { model_type: 'llama', tokenizer_config: { chat_template: '{{ messages }}' } },
        });
      }
      return jsonResponse({}, 404);
    });

    const result = await autoConfigureModel('plain-text', 'http://host:8000');

    // The template is present but has no tool support — the step-4 fallback must
    // not re-claim tool calling that the model's own template proves it lacks.
    expect(result.modelConfig.capabilities).toEqual({ toolCalling: false, imageInput: false });
    expect(result.summary.join('\n')).toContain('No tool calling markers in chat template');
  });

  it('passes per-server request headers through to the vLLM fetch', async () => {
    const fetchFn = stubFetch((url: string) => {
      if (url.endsWith('/v1/models')) {
        return jsonResponse({ data: [{ id: 'm', max_model_len: 4096 }] });
      }
      return jsonResponse({}, 404);
    });

    await autoConfigureModel('m', 'http://host:8000', { 'X-API-Key': 'secret' });

    const vllmCall = fetchFn.mock.calls.find(([u]) => String(u).endsWith('/v1/models'));
    expect(vllmCall).toBeDefined();
    const [, init] = vllmCall as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('secret');
  });
});

describe('resolveModelConfigForAdd', () => {
  const extContext = { extensionUri: vscode.Uri.file('/ext') } as any;
  const PRESET_JSON = '{ "vllmModelId": "org/Model", "modelModes": { "balanced": {} } }';

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const stubDiscovery = () => {
    // autoConfigureModel does real fetch; route /v1/models and HF so the
    // Auto-Discover / no-preset branches resolve through it. Any requested
    // model gets a valid window (mandatory no-context-no-model check).
    const fn = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/models')) {
        return jsonResponse({ data: [{ id: 'org/Model', max_model_len: 8192 }, { id: 'unknown-model', max_model_len: 8192 }] });
      }
      if (String(url).includes('/api/models/')) {
        return jsonResponse({ id: 'x', config: { model_type: 'qwen' } });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fn);
    return fn;
  };

  /** Seed the mock workspace.fs with a single preset file. */
  const seedPreset = () => {
    (vscode as any).workspace._mockFsReadDirectory = () =>
      Promise.resolve([['Preset.json', vscode.FileType.File]]);
    (vscode as any).workspace._mockFsReadFile = () =>
      Promise.resolve(new TextEncoder().encode(PRESET_JSON));
  };

  /** Seed the mock workspace.fs with no preset files. */
  const seedNoPresets = () => {
    (vscode as any).workspace._mockFsReadDirectory = () => Promise.resolve([]);
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (vscode as any).workspace._mockFsReadDirectory;
    delete (vscode as any).workspace._mockFsReadFile;
  });

  it('returns null when the user cancels the preset dialog', async () => {
    seedPreset();
    const infoSpy = vi
      .spyOn(vscode.window, 'showInformationMessage')
      .mockResolvedValue(undefined);

    const result = await resolveModelConfigForAdd(extContext, 'org/Model', 'http://host:8000');

    expect(result).toBeNull();
    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  it('returns the preset-merged config, preserving the caller identity, on Use Preset', async () => {
    seedPreset();
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Use Preset' as any);
    // The preset path now resolves context via the SHARED resolver — serve a
    // valid vLLM window so the strict no-context-no-model check passes.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ data: [{ id: 'org/Model', max_model_len: 8192 }] })));
    const base = { id: 'user-id', vllmModelId: 'user-wire', serverUrl: 'http://host:8000' };

    const result = await resolveModelConfigForAdd(
      extContext, 'org/Model', 'http://host:8000', undefined, undefined, base as any,
    );

    expect(result).not.toBeNull();
    // User identity is preserved; the preset supplies model fields.
    expect(result!.modelConfig.id).toBe('user-id');
    expect(result!.modelConfig.vllmModelId).toBe('user-wire');
    expect(result!.modelConfig.modelModes).toEqual({ balanced: {} });
    expect(result!.summary[0]).toContain('Using preset Preset.json');
  });

  it('falls through to HuggingFace discovery when Auto-Discover is chosen', async () => {
    seedPreset();
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Auto-Discover' as any);
    const fetchFn = stubDiscovery();

    const result = await resolveModelConfigForAdd(extContext, 'org/Model', 'http://host:8000');

    expect(result).not.toBeNull();
    // Discovery ran (HF model_type surfaced) rather than the preset.
    expect(result!.modelConfig.family).toBe('qwen');
    expect(fetchFn).toHaveBeenCalled();
  });

  it('auto-discovers when no preset matches', async () => {
    seedNoPresets();
    const fetchFn = stubDiscovery();

    const result = await resolveModelConfigForAdd(extContext, 'unknown-model', 'http://host:8000');

    expect(result).not.toBeNull();
    expect(result!.modelConfig.id).toBe('unknown-model');
    expect(result!.modelConfig.family).toBe('qwen');
    expect(fetchFn).toHaveBeenCalled();
  });
});

describe('resolveModelConfigForAddSafely', () => {
  const extContext = { extensionUri: vscode.Uri.file('/ext') } as any;
  const output = { appendLine: vi.fn() } as any;

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (vscode as any).workspace._mockFsReadDirectory;
    delete (vscode as any).workspace._mockFsReadFile;
  });

  it('logs the backend-specific detail and returns null instead of letting the strict error escape', async () => {
    // No presets, and the server is llama.cpp-shaped: /v1/models reports
    // owned_by "llamacpp" but no max_model_len → the strict vLLM resolver throws.
    (vscode as any).workspace._mockFsReadDirectory = () => Promise.resolve([]);
    vi.stubGlobal('fetch', vi.fn(async () =>
      jsonResponse({ data: [{ id: 'unknown-model', owned_by: 'llamacpp' }] })
    ));
    const errSpy = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);

    const result = await resolveModelConfigForAddSafely(
      output, extContext, 'unknown-model', 'http://host:8000'
    );

    // The strict policy refuses to serve — the wrapper converts the throw into a
    // logged, user-facing error and returns null (nothing saved).
    expect(result).toBeNull();
    expect(output.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('[ERROR] Auto-configure failed for "unknown-model"'),
    );
    // The actionable detail (names serverType as the fix) reaches the user.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('serverType'),
    );
  });
});
