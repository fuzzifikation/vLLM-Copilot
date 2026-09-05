import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { runOpenRouterAddFlow } from '../src/commands/addServerFlow.js';
import * as configStore from '../src/state/configStore.js';
import { resetOpenRouterCaches } from '../src/backends/openRouter.js';

// The catalog memo is module-level: a success fetched by one test would
// otherwise satisfy (or mask) the next test's stubbed catalog.
beforeEach(() => {
  resetOpenRouterCaches();
});

/**
 * Tests for the OpenRouter onboarding branch of the Add-server flow: host-only
 * routing (openrouter.ai), server → key → model ordering, catalog
 * typeahead with prefill from a pasted model-page URL, one catalog snapshot
 * (no free-text fallback / no double download), duplicate handling, and the
 * save shape (serverType/URL/headers/limits).
 */

const provider = { clearCache: vi.fn() } as any;

/** Fresh output per test (typed `any` like the existing addServerFlow tests). */
const freshOutput = (): any => ({
  appendLine: vi.fn(),
  dispose: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
});

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const NEMOTRON_METADATA = {
  id: 'nvidia/nemotron-3.5-lightning',
  canonical_slug: 'nvidia/nemotron-3.5-lightning-20260807',
  name: 'NVIDIA: Nemotron 3.5 Lightning (free)',
  context_length: 1000000,
  architecture: { input_modalities: ['text'] },
  pricing: { prompt: '0', completion: '0' },
  top_provider: { context_length: 1000000, max_completion_tokens: 65536 },
  per_request_limits: null,
  supported_parameters: ['reasoning', 'tools', 'max_tokens', 'temperature'],
  reasoning: { mandatory: false },
};

// The catalog is the AUTHORITATIVE metadata source: every model VARIANT is its
// own full entry keyed by exact `id` (verified live — this is what `/v1/models`
// actually returns). Metadata resolution matches the requested id VERBATIM, so
// `:free` and the base model are distinct entries with distinct pricing.
const CATALOG = {
  data: [
    {
      ...NEMOTRON_METADATA,
      id: 'nvidia/nemotron-3.5-lightning',
      name: 'NVIDIA: Nemotron 3.5 Lightning',
      pricing: { prompt: '0.00000008', completion: '0.0000002' },
    },
    {
      ...NEMOTRON_METADATA,
      id: 'nvidia/nemotron-3.5-lightning:free',
      name: 'NVIDIA: Nemotron 3.5 Lightning (free)',
    },
    {
      id: 'deepseek/deepseek-chat',
      name: 'DeepSeek V3',
      context_length: 163840,
      top_provider: { context_length: 163840, max_completion_tokens: null },
      per_request_limits: null,
      pricing: { prompt: '0.000000274', completion: '0.0000010287' },
      supported_parameters: ['reasoning', 'tools'],
    },
  ],
};

/** Standard fetch stub: the catalog at /v1/models is the ONLY metadata source. */
function stubOpenRouterFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
    const u = String(url);
    if (u.endsWith('/v1/models')) return jsonResponse(CATALOG);
    return jsonResponse({}, 404);
  });
}

/** Mock the config surfaces the save path touches (configStore + workspace config). */
function mockSaveSurfaces(chatUpdate = vi.fn().mockResolvedValue(undefined)) {
  const resolveSpy = vi
    .spyOn(configStore, 'replaceModelConfig')
    .mockResolvedValue({ model: { id: 'x' } as any, created: true });
  vscode.workspace._mockConfig = {
    get: (key: string) =>
      key === 'models' ? [] : key === 'servers' ? OPENROUTER_SERVERS : undefined,
    update: chatUpdate,
    inspect: () => ({ defaultValue: 'none' }),
  };
  return resolveSpy;
}

/** Registry the duplicate detection resolves model `server` refs against.
 *  Carries the same auth the flow will send, so `ensureServerEntry` reuses
 *  the entry instead of minting a duplicate for the identical server. */
const OPENROUTER_SERVERS = [
  {
    id: 'openrouter',
    serverUrl: 'https://openrouter.ai/api',
    displayName: 'OldName',
    requestHeaders: { Authorization: 'Bearer sk-or-v1-test' },
  },
];

/** Build a controllable createQuickPick stub. Drive it with _fireAccept/_fireHide. */
function makeQuickPickStub(): any {
  // `dispose()` fires `onDidHide` — real VS Code does this. A picker handler
  // that disposes BEFORE resolving would let onDidHide's resolve(undefined)
  // clobber the accepted label (the "clicked a model → cancelled" bug). The
  // stub must model this so the dispose→hide race is caught in tests.
  const qp: any = {
    value: '',
    placeholder: undefined,
    title: undefined,
    prompt: undefined,
    items: [],
    selectedItems: [],
    activeItems: [],
    canSelectMany: false,
    matchOnDescription: false,
    matchOnDetail: false,
    ignoreFocusOut: false,
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(() => { if (qp._hide) { const cb = qp._hide; qp._hide = undefined; cb(); } }),
    onDidAccept: vi.fn((cb: () => unknown) => { qp._accept = cb; return { dispose: () => {} }; }),
    onDidHide: vi.fn((cb: () => unknown) => { qp._hide = cb; return { dispose: () => {} }; }),
    onDidChangeValue: vi.fn(() => ({ dispose: () => {} })),
    _accept: undefined,
    _hide: undefined,
    _fireAccept: () => qp._accept?.(),
    _fireHide: () => { if (qp._hide) { const cb = qp._hide; qp._hide = undefined; cb(); } },
  };
  return qp;
}

describe('runOpenRouterAddFlow', () => {
  let inputBoxSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let createQuickPickSpy: ReturnType<typeof vi.spyOn>;
  let qpStub: any;
  let resolveSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    inputBoxSpy = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(undefined);
    infoSpy = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    qpStub = makeQuickPickStub();
    createQuickPickSpy = vi.spyOn(vscode.window, 'createQuickPick').mockReturnValue(qpStub);
    resolveSpy = mockSaveSurfaces();
    provider.clearCache.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vscode.workspace._mockConfig = {};
  });

  it('onboards from a model-page URL: key → direct metadata (no picker) → confirm dialog → fixed-URL config', async () => {
    const out = freshOutput();
    const fetchSpy = stubOpenRouterFetch();
    // Order per the rule: server → key → model. Custom headers are NOT prompted
    // for OpenRouter (expert concern — edited in settings).
    inputBoxSpy.mockResolvedValueOnce('sk-or-v1-test'); // API key only
    infoSpy.mockResolvedValue('Save to Settings' as any);

    // A full model-page URL names the model EXPLICITLY — the picker is SKIPPED
    // and the flow resolves the exact catalog entry directly, so the user
    // actively confirms the model in the confirm/save dialog (no pre-select
    // flash + auto-accept on Enter).
    await runOpenRouterAddFlow(out, provider, 'https://openrouter.ai/nvidia/nemotron-3.5-lightning:free');
    expect(createQuickPickSpy).not.toHaveBeenCalled();

    // Key box ran FIRST, as a required password box.
    expect(inputBoxSpy).toHaveBeenCalledWith(expect.objectContaining({ password: true, title: 'Add OpenRouter Model - API Key' }));
    const keyCall = inputBoxSpy.mock.calls[0][0] as any;
    expect(keyCall.validateInput).toBeDefined();
    expect(keyCall.validateInput('')).toBe('An API key is required.');
    // Model resolved from the catalog by EXACT id match (the :free entry, never
    // the paid base model).
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(resolveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'nvidia/nemotron-3.5-lightning:free on openrouter',
        vllmModelId: 'nvidia/nemotron-3.5-lightning:free',
        server: 'openrouter',
        // Auth + URL live on the registry entry; the model only refs it.
        maxOutputTokens: 65536,
        capabilities: { toolCalling: true, imageInput: false },
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith(expect.any(String)); // toast fired; wording is chrome (CR-109)
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('fails clearly (no guessing) when the catalog cannot be loaded — no picker, nothing saved', async () => {
    // The catalog is the authoritative metadata source. If it can't be loaded,
    // the flow fails up front rather than collecting an id it cannot size/save.
    // There is NO free-text fallback and no per-model metadata download.
    const out = freshOutput();
    const fetchSpy = stubOpenRouterFetch();
    const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    inputBoxSpy.mockResolvedValueOnce('sk-or-v1-test'); // API key only
    infoSpy.mockResolvedValue('Save to Settings' as any);

    await runOpenRouterAddFlow(out, provider, 'https://openrouter.ai/api');

    // No model picker (and no free-text input box) — the flow stops at the catalog.
    expect(createQuickPickSpy).not.toHaveBeenCalled();
    expect(inputBoxSpy).toHaveBeenCalledTimes(1); // API key only — no headers prompt
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Couldn't load the OpenRouter model catalog"));
    expect(out.appendLine).toHaveBeenCalledWith(expect.stringContaining('[ERROR] OpenRouter model catalog unavailable'));
  });

  it('Replace Config retains the existing entry id (duplicate on the fixed API base)', async () => {
    const out = freshOutput();
    stubOpenRouterFetch();
    inputBoxSpy.mockResolvedValueOnce('sk-or-v1-test'); // API key only
    infoSpy
      .mockResolvedValueOnce('Replace Config' as any)   // duplicate dialog
      .mockResolvedValueOnce('Save to Settings' as any); // final confirm

    // Full model-page URL → picker skipped, straight to the duplicate dialog.
    // The duplicate lives in the STORE (the gate re-reads it fresh, it takes no
    // caller snapshot) — seed the mocked settings surface accordingly.
    vscode.workspace._mockConfig = {
      ...vscode.workspace._mockConfig,
      get: (key: string) =>
        key === 'models'
          ? [{ id: 'custom-openrouter-id', vllmModelId: 'nvidia/nemotron-3.5-lightning:free', server: 'openrouter' }]
          : key === 'servers' ? OPENROUTER_SERVERS : undefined,
    };
    await runOpenRouterAddFlow(out, provider, 'https://openrouter.ai/nvidia/nemotron-3.5-lightning:free');
    expect(createQuickPickSpy).not.toHaveBeenCalled();

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('is already configured'),
      expect.anything(),
      'Update Auth',
      'Replace Config',
    );
    expect(resolveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'custom-openrouter-id' }),
    );
    expect(provider.clearCache).toHaveBeenCalled();
  });
});
