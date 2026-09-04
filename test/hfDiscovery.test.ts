import { describe, it, expect, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { resolveModelConfigForAddSafely } from '../src/commands/hfDiscovery.js';
import { clearRuntimeLimitsCache } from '../src/backends/runtimeLimits.js';

/**
 * HuggingFace auto-discovery pins. `autoConfigureModel` and the preset resolver
 * are module-private (U9 demotion + U8b); these drive them through the sole
 * production entry, `resolveModelConfigForAddSafely`, with no presets seeded so
 * the resolver falls straight through to the auto-discovery branch. The wrapper
 * converts the resolver's strict THROWS into `null` plus a logged error, so
 * failure pins assert the logged detail, not a rejection. Global fetch is
 * stubbed and routed by URL so nothing hits the network: /v1/models → vLLM,
 * /api/models/ → HF model info, /generation_config.json → HF generation
 * config, anything else (the remote-preset index) → 404 → silent miss.
 */
describe('autoConfigureModel (via resolveModelConfigForAddSafely)', () => {
  const extContext = { extensionUri: vscode.Uri.file('/ext') } as any;
  const fakeOutput = () => ({ appendLine: vi.fn(), show: vi.fn() }) as any;

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (vscode as any).workspace._mockFsReadDirectory;
    delete (vscode as any).workspace._mockFsReadFile;
    // The server-list memo (runtimeLimits) is keyed WITHOUT the model id and
    // lives 5 s — a successful list fetched by one test would satisfy the next
    // test's lookup on the same serverUrl+headers, so a model id only the next
    // stub serves would "disappear" (order-dependent failures). Same doctrine
    // as resetOpenRouterCaches in the OpenRouter flow tests.
    clearRuntimeLimitsCache();
  });

  /** No bundled presets — the resolver cannot stop at the preset dialog. */
  const seedNoPresets = () => {
    (vscode as any).workspace._mockFsReadDirectory = () => Promise.resolve([]);
  };

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  /** Route a fetch call to a stubbed response based on its URL. */
  const stubFetch = (router: (url: string) => Response | Promise<Response>) => {
    const fn = vi.fn(async (url: string) => router(url));
    vi.stubGlobal('fetch', fn);
    return fn;
  };

  it('THROWS (no context, no model) when the server cannot report a context window', async () => {
    const fetchFn = stubFetch((url: string) => {
      if (url.endsWith('/v1/models')) {
        return jsonResponse({ error: 'nope' }, 503);
      }
      return jsonResponse({}, 404);
    });

    seedNoPresets();
    // Strict policy: a model without a resolvable context window is not saved.
    // The wrapper converts the strict throw into null + a logged actionable
    // error carrying the same HTTP detail.
    const output = fakeOutput();
    const result = await resolveModelConfigForAddSafely(output, extContext, 'm', 'http://host:8000');
    expect(result).toBeNull();
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining('HTTP 503'));
    // No HF lookup happened — the flow aborted at the mandatory context check.
    expect(fetchFn.mock.calls.some(([u]) => String(u).includes('/api/models/m'))).toBe(false);
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

    seedNoPresets();
    const result = await resolveModelConfigForAddSafely(fakeOutput(), extContext, 'plain-text', 'http://host:8000');

    // The template is present but has no tool support — the step-4 fallback must
    // not re-claim tool calling that the model's own template proves it lacks.
    expect(result!.modelConfig.capabilities).toEqual({ toolCalling: false, imageInput: false });
    expect(result!.summary.join('\n')).toContain('No tool calling markers in chat template');
  });

  it('vision detection claims imageInput only — the template verdict owns toolCalling', async () => {
    // CR-7 canary: the vision branch used to write `toolCalling: true`
    // wholesale, which made the template's detected-absence branch
    // (guarded on undefined) structurally unreachable — agent turns then
    // sent `tools` to a server whose model rejects them, while the summary
    // claimed the opposite.
    stubFetch((url: string) => {
      if (url.endsWith('/v1/models')) {
        return jsonResponse({ data: [{ id: 'vision-thing', max_model_len: 32768 }] });
      }
      if (url.includes('/api/models/vision-thing')) {
        return jsonResponse({
          id: 'vision-thing',
          config: { model_type: 'qwen2_5_vl', tokenizer_config: { chat_template: '{{ messages }}' } },
        });
      }
      return jsonResponse({}, 404);
    });

    seedNoPresets();
    const result = await resolveModelConfigForAddSafely(fakeOutput(), extContext, 'vision-thing', 'http://host:8000');

    expect(result!.summary.join('\n')).toContain('Vision support detected (model_type: qwen2_5_vl)');
    expect(result!.modelConfig.capabilities).toEqual({ toolCalling: false, imageInput: true });
  });

  it('passes per-server request headers through to the vLLM fetch', async () => {
    const fetchFn = stubFetch((url: string) => {
      if (url.endsWith('/v1/models')) {
        return jsonResponse({ data: [{ id: 'm', max_model_len: 4096 }] });
      }
      return jsonResponse({}, 404);
    });

    seedNoPresets();
    await resolveModelConfigForAddSafely(fakeOutput(), extContext, 'm', 'http://host:8000', { 'X-API-Key': 'secret' });

    const vllmCall = fetchFn.mock.calls.find(([u]) => String(u).endsWith('/v1/models'));
    expect(vllmCall).toBeDefined();
    const [, init] = vllmCall as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('secret');
  });
});

describe('the OpenRouter route (via resolveModelConfigForAddSafely)', () => {
  const extContext = { extensionUri: vscode.Uri.file('/ext') } as any;
  const fakeOutput = () => ({ appendLine: vi.fn(), show: vi.fn() }) as any;
  const PRESET_JSON =
    '{ "presetVersion": 1, "match": ["org/Model"], "config": { "vllmModelId": "org/Model", "modelModes": { "balanced": {} } } }';

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

  it('routes OpenRouter models to exact-model discovery — no HF, no presets, no fabricated cap', async () => {
    seedNoPresets();
    const fetchFn = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/models')) {
        // The catalog is the deterministic metadata source (exact-id match).
        return jsonResponse({
          data: [{
            id: 'x-ai/grok-4.6',
            name: 'Grok 4.6',
            context_length: 500000,
            top_provider: { context_length: 500000 },
            supported_parameters: ['tools', 'reasoning', 'reasoning_effort'],
            reasoning: {
              mandatory: true,
              supported_efforts: ['xhigh', 'high', 'medium', 'low'],
              default_effort: 'high',
            },
          }],
        });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchFn);
    const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);

    const result = await resolveModelConfigForAddSafely(
      fakeOutput(), extContext, 'x-ai/grok-4.6', 'https://openrouter.ai/api', undefined,
      undefined, undefined, 'openrouter',
    );

    expect(result).not.toBeNull();
    // The OpenRouter catalog (/v1/models) is the ONLY call — HF and the
    // local-server probe are never touched, and no preset dialog is shown.
    expect(fetchFn.mock.calls.some(([u]) => String(u).includes('/v1/models'))).toBe(true);
    expect(fetchFn.mock.calls.some(([u]) => String(u).includes('/v1/model/'))).toBe(false);
    expect(fetchFn.mock.calls.some(([u]) => String(u).includes('/api/models/'))).toBe(false);
    expect(infoSpy).not.toHaveBeenCalled();
    // Thinking modes came from the reasoning object, not fabricated.
    expect(result!.modelConfig.modelModes?.['Think (High)']).toEqual({ reasoning: { enabled: true, effort: 'high' } });
    // No API completion cap → 10% of the context window, hard-capped at 81920.
    // floor(500000 × 0.1) = 50000 < 81920 → 50000.
    expect(result!.suggestedMaxOutputTokens).toBeUndefined();
    expect(result!.modelConfig.maxOutputTokens).toBe(50000);
    expect(result!.summary.join('\n')).not.toContain('HuggingFace');
  });
});

describe('resolveModelConfigForAddSafely', () => {
  const extContext = { extensionUri: vscode.Uri.file('/ext') } as any;
  const output = { appendLine: vi.fn(), show: vi.fn() } as any;

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
    // logged, user-facing error AND a popup (so the user knows it failed), with
    // the full detail in the output channel. Returns null (nothing saved).
    expect(result).toBeNull();
    expect(output.appendLine).toHaveBeenCalledWith(
      expect.stringContaining('[ERROR] Auto-configure failed for "unknown-model"'),
    );
    // Popup so the user KNOWS; the output channel carries the full detail.
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('serverType'));
    expect(output.show).toHaveBeenCalledWith(true);
  });
});
