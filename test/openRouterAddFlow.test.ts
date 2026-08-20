import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  registerAddServerModelCommand,
  runOpenRouterAddFlow,
  pickOpenRouterModel,
  projectCatalog,
  buildOpenRouterSummary,
} from '../src/commands/addServerFlow.js';
import * as configStore from '../src/configStore.js';

/**
 * Tests for the OpenRouter onboarding branch of the Add-server flow: host-only
 * routing (openrouter.ai), server → key & headers → model-pick ordering, catalog
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

/** The catalog projected to the picker's narrow entry shape (what the flow passes to the picker). */
const PROJECTED = projectCatalog(CATALOG.data);

/** Mock the config surfaces the save path touches (configStore + workspace config). */
function mockSaveSurfaces(chatUpdate = vi.fn().mockResolvedValue(undefined)) {
  const resolveSpy = vi
    .spyOn(configStore, 'replaceModelConfig')
    .mockResolvedValue({ model: { id: 'x' } as any, created: true });
  vscode.workspace._mockConfig = {
    get: (key: string) => (key === 'models' ? [] : undefined),
    update: chatUpdate,
    inspect: () => ({ defaultValue: 'none' }),
  };
  return resolveSpy;
}

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

  it('onboards from a model-page URL: key → picker (pre-filled) → metadata → fixed-URL config', async () => {
    const out = freshOutput();
    const fetchSpy = stubOpenRouterFetch();
    // Order per the rule: server → key & headers → model pick.
    inputBoxSpy
      .mockResolvedValueOnce('sk-or-v1-test') // API key
      .mockResolvedValueOnce('');             // custom headers
    infoSpy.mockResolvedValue('Save to Settings' as any);

    const flow = runOpenRouterAddFlow(out, provider, 'https://openrouter.ai/nvidia/nemotron-3.5-lightning:free', []);
    // Wait for the flow to reach the picker, then confirm the selection.
    await vi.waitFor(() => expect(qpStub._accept).toBeDefined());
    // The pasted model-page URL pre-filled the picker filter box.
    expect(qpStub.value).toBe('nvidia/nemotron-3.5-lightning:free');
    qpStub.selectedItems = [{ label: 'nvidia/nemotron-3.5-lightning:free' } as any];
    qpStub._fireAccept();
    await flow;

    // Key box ran FIRST, as a required password box.
    expect(inputBoxSpy).toHaveBeenCalledWith(expect.objectContaining({ password: true, title: 'Add OpenRouter Model — API Key' }));
    const keyCall = inputBoxSpy.mock.calls[0][0] as any;
    expect(keyCall.validateInput).toBeDefined();
    expect(keyCall.validateInput('')).toBe('An API key is required.');
    // Model was PICKED (not taken from the URL) — metadata resolved from the
    // catalog by EXACT id match (the :free entry, never the paid base model).
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(resolveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'nvidia/nemotron-3.5-lightning:free on openrouter.ai',
        vllmModelId: 'nvidia/nemotron-3.5-lightning:free',
        serverUrl: 'https://openrouter.ai/api',
        serverType: 'openrouter',
        requestHeaders: { Authorization: 'Bearer sk-or-v1-test' },
        maxOutputTokens: 65536,
        capabilities: { toolCalling: true, imageInput: false },
      }),
    );
    expect(infoSpy).toHaveBeenCalledWith('Model "nvidia/nemotron-3.5-lightning:free" added.');
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('onboards from the bare /api base via catalog typeahead', async () => {
    const out = freshOutput();
    stubOpenRouterFetch();
    inputBoxSpy
      .mockResolvedValueOnce('sk-or-v1-test')
      .mockResolvedValueOnce('');
    infoSpy.mockResolvedValue('Save to Settings' as any);

    const flow = runOpenRouterAddFlow(out, provider, 'https://openrouter.ai/api', []);
    await vi.waitFor(() => expect(qpStub._accept).toBeDefined());
    // No model-page URL → no prefill.
    expect(qpStub.value).toBe('');
    // Filter-as-you-type over the catalog.
    expect(qpStub.matchOnDescription).toBe(true);
    expect(qpStub.matchOnDetail).toBe(true);
    expect(qpStub.items.some((i: any) => i.label === 'nvidia/nemotron-3.5-lightning:free')).toBe(true);
    qpStub.selectedItems = [{ label: 'nvidia/nemotron-3.5-lightning:free' } as any];
    qpStub._fireAccept();
    await flow;

    expect(resolveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        vllmModelId: 'nvidia/nemotron-3.5-lightning:free',
        serverType: 'openrouter',
        serverUrl: 'https://openrouter.ai/api',
      }),
    );
  });

  it('fails clearly (no guessing) when the catalog cannot be loaded — no picker, nothing saved', async () => {
    // The catalog is the authoritative metadata source. If it can't be loaded,
    // the flow fails up front rather than collecting an id it cannot size/save.
    // There is NO free-text fallback and no per-model metadata download.
    const out = freshOutput();
    const fetchSpy = stubOpenRouterFetch();
    const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
    fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));
    inputBoxSpy
      .mockResolvedValueOnce('sk-or-v1-test') // API key
      .mockResolvedValueOnce('');             // headers
    infoSpy.mockResolvedValue('Save to Settings' as any);

    await runOpenRouterAddFlow(out, provider, 'https://openrouter.ai/api', []);

    // No model picker (and no free-text input box) — the flow stops at the catalog.
    expect(createQuickPickSpy).not.toHaveBeenCalled();
    expect(inputBoxSpy).toHaveBeenCalledTimes(2); // key + headers only
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Couldn't load the OpenRouter model catalog"));
    expect(out.appendLine).toHaveBeenCalledWith(expect.stringContaining('[ERROR] OpenRouter model catalog unavailable'));
  });

  it('aborts when the key prompt is cancelled', async () => {
    const out = freshOutput();
    stubOpenRouterFetch();
    inputBoxSpy.mockResolvedValue(undefined); // cancelled at key prompt
    infoSpy.mockResolvedValue('Save to Settings' as any);

    await runOpenRouterAddFlow(out, provider, 'https://openrouter.ai/nvidia/nemotron-3.5-lightning:free', []);

    expect(createQuickPickSpy).not.toHaveBeenCalled(); // never reached the model pick
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(provider.clearCache).not.toHaveBeenCalled();
  });

  it('treats a scheme-less openrouter.ai base as a base reference (no prefill → catalog picker)', async () => {
    const out = freshOutput();
    stubOpenRouterFetch();
    inputBoxSpy
      .mockResolvedValueOnce('sk-or-v1-test')
      .mockResolvedValueOnce('');
    infoSpy.mockResolvedValue('Save to Settings' as any);

    const flow = runOpenRouterAddFlow(out, provider, 'openrouter.ai/api', []);
    await vi.waitFor(() => expect(qpStub._accept).toBeDefined());
    // "openrouter.ai/api" must NOT be parsed as a bare slug — no prefill, catalog picker only.
    expect(qpStub.value).toBe('');
    qpStub.selectedItems = [{ label: 'nvidia/nemotron-3.5-lightning:free' } as any];
    qpStub._fireAccept();
    await flow;

    expect(resolveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ vllmModelId: 'nvidia/nemotron-3.5-lightning:free' }),
    );
  });

  it('pre-fills the picker from a scheme-less openrouter.ai model-page URL', async () => {
    const out = freshOutput();
    const fetchSpy = stubOpenRouterFetch();
    inputBoxSpy
      .mockResolvedValueOnce('sk-or-v1-test')
      .mockResolvedValueOnce('');
    infoSpy.mockResolvedValue('Save to Settings' as any);

    const flow = runOpenRouterAddFlow(out, provider, 'openrouter.ai/nvidia/nemotron-3.5-lightning:free', []);
    await vi.waitFor(() => expect(qpStub._accept).toBeDefined());
    expect(qpStub.value).toBe('nvidia/nemotron-3.5-lightning:free'); // pre-filled, still picked
    qpStub.selectedItems = [{ label: 'nvidia/nemotron-3.5-lightning:free' } as any];
    qpStub._fireAccept();
    await flow;

    // Metadata resolved from the catalog by exact id (parsed as a URL, not a bare slug).
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/models',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(resolveSpy).toHaveBeenCalledWith(
      expect.objectContaining({ vllmModelId: 'nvidia/nemotron-3.5-lightning:free' }),
    );
  });

  it('Replace Config retains the existing entry id (duplicate on the fixed API base)', async () => {
    const out = freshOutput();
    stubOpenRouterFetch();
    inputBoxSpy
      .mockResolvedValueOnce('sk-or-v1-test')
      .mockResolvedValueOnce('');
    infoSpy
      .mockResolvedValueOnce('Replace Config' as any)   // duplicate dialog
      .mockResolvedValueOnce('Save to Settings' as any); // final confirm

    const flow = runOpenRouterAddFlow(out, provider, 'https://openrouter.ai/nvidia/nemotron-3.5-lightning:free', [
      { id: 'custom-openrouter-id', vllmModelId: 'nvidia/nemotron-3.5-lightning:free', serverUrl: 'https://openrouter.ai/api', displayName: 'OldName' },
    ]);
    await vi.waitFor(() => expect(qpStub._accept).toBeDefined());
    qpStub.selectedItems = [{ label: 'nvidia/nemotron-3.5-lightning:free' } as any];
    qpStub._fireAccept();
    await flow;

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

  it('Update Auth reuses the already-collected headers (no second prompt, no discarded key)', async () => {
    const out = freshOutput();
    stubOpenRouterFetch();
    inputBoxSpy
      .mockResolvedValueOnce('sk-or-v1-test') // API key
      .mockResolvedValueOnce('');             // headers
    const execSpy = vi.spyOn(vscode.commands, 'executeCommand');
    infoSpy.mockResolvedValueOnce('Update Auth' as any); // duplicate dialog

    const flow = runOpenRouterAddFlow(out, provider, 'https://openrouter.ai/nvidia/nemotron-3.5-lightning:free', [
      { id: 'custom-openrouter-id', vllmModelId: 'nvidia/nemotron-3.5-lightning:free', serverUrl: 'https://openrouter.ai/api', displayName: 'OldName' },
    ]);
    await vi.waitFor(() => expect(qpStub._accept).toBeDefined());
    qpStub.selectedItems = [{ label: 'nvidia/nemotron-3.5-lightning:free' } as any];
    qpStub._fireAccept();
    await flow;

    // The key+headers collected at step 1 are passed straight to updateServerAuth —
    // it must NOT re-prompt (which would discard this key and open a second wizard).
    expect(execSpy).toHaveBeenCalledWith(
      'vllm-copilot.updateServerAuth',
      'https://openrouter.ai/api',
      { Authorization: 'Bearer sk-or-v1-test' },
    );
    // Only the two step-1 prompts ran (key + headers) — no second auth wizard.
    expect(inputBoxSpy).toHaveBeenCalledTimes(2);
    // Update Auth does not save a new config.
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('logs (does not pop up) when the API-key step is cancelled', async () => {
    const out = freshOutput();
    stubOpenRouterFetch();
    const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
    inputBoxSpy.mockResolvedValueOnce(undefined); // key box cancelled

    await runOpenRouterAddFlow(out, provider, 'https://openrouter.ai/api', []);

    // Error details go to the OUTPUT CHANNEL, never a popup.
    expect(errorSpy).not.toHaveBeenCalled();
    expect(out.appendLine).toHaveBeenCalledWith(expect.stringContaining('[WARN] OpenRouter add cancelled — no API key entered.'));
    expect(out.show).toHaveBeenCalledWith(true); // output channel revealed
    // Nothing saved, no picker shown.
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(createQuickPickSpy).not.toHaveBeenCalled();
  });

  it('logs (does not pop up) when the model picker is dismissed without a selection', async () => {
    const out = freshOutput();
    stubOpenRouterFetch();
    const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
    inputBoxSpy
      .mockResolvedValueOnce('sk-or-v1-test') // API key
      .mockResolvedValueOnce('');             // headers

    const flow = runOpenRouterAddFlow(out, provider, 'https://openrouter.ai/api', []);
    await vi.waitFor(() => expect(qpStub._hide).toBeDefined());
    qpStub._fireHide(); // picker dismissed
    await flow;

    expect(errorSpy).not.toHaveBeenCalled();
    expect(out.appendLine).toHaveBeenCalledWith(expect.stringContaining('[WARN] OpenRouter add cancelled — no model selected.'));
    expect(out.show).toHaveBeenCalledWith(true);
    expect(resolveSpy).not.toHaveBeenCalled();
  });
});

describe('pickOpenRouterModel', () => {
  let createQuickPickSpy: ReturnType<typeof vi.spyOn>;
  let qpStub: any;

  beforeEach(() => {
    qpStub = makeQuickPickStub();
    createQuickPickSpy = vi.spyOn(vscode.window, 'createQuickPick').mockReturnValue(qpStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('filters the catalog via quick pick and returns the selected id', async () => {
    const p = pickOpenRouterModel(PROJECTED);
    await vi.waitFor(() => expect(qpStub._accept).toBeDefined());

    // Catalog items loaded (id label, name description, ctx·price detail) with filter-as-you-type.
    const items = qpStub.items as vscode.QuickPickItem[];
    expect(items.some((i) => i.label === 'nvidia/nemotron-3.5-lightning:free')).toBe(true);
    const nemotron = items.find((i) => i.label === 'nvidia/nemotron-3.5-lightning:free')!;
    expect(nemotron.description).toBe('NVIDIA: Nemotron 3.5 Lightning (free)');
    expect(nemotron.detail).toContain('ctx');
    // Pricing detail comes from the SHARED per-token → per-1M conversion
    // (perMillion in openRouter.ts), not a second implementation here. The
    // :free variant is priced at zero; the paid variant converts nonzero.
    // toLocaleString is locale-dependent, so format the expectation with the
    // same options the picker uses (existing pattern in this file).
    const fmtRate = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}/1M`;
    expect(nemotron.detail).toContain(`in ${fmtRate(0)} · out ${fmtRate(0)}`);
    const paid = items.find((i) => i.label === 'nvidia/nemotron-3.5-lightning')!;
    expect(paid.detail).toContain(`in ${fmtRate(0.08)} · out ${fmtRate(0.2)}`);
    expect(qpStub.matchOnDescription).toBe(true);
    expect(qpStub.matchOnDetail).toBe(true);
    expect(qpStub.value).toBe(''); // no prefill

    qpStub.selectedItems = [nemotron];
    qpStub._fireAccept();
    await expect(p).resolves.toBe('nvidia/nemotron-3.5-lightning:free');
  });

  it('pre-fills the filter box from a model-page URL', async () => {
    const p = pickOpenRouterModel(PROJECTED, 'nvidia/nemotron-3.5-lightning:free');
    await vi.waitFor(() => expect(qpStub._accept).toBeDefined());
    expect(qpStub.value).toBe('nvidia/nemotron-3.5-lightning:free');
    qpStub.selectedItems = [{ label: 'nvidia/nemotron-3.5-lightning:free' } as any];
    qpStub._fireAccept();
    await expect(p).resolves.toBe('nvidia/nemotron-3.5-lightning:free');
  });

  it('rejects a typed id that is not in the catalog (no free-text fallback)', async () => {
    const p = pickOpenRouterModel(PROJECTED);
    await vi.waitFor(() => expect(qpStub._accept).toBeDefined());
    // Type a valid-looking but non-catalog id and accept without selecting. The
    // catalog is authoritative — a model that isn't in the snapshot cannot be
    // sized or saved, so the picker must NOT fall back to the typed value.
    qpStub.value = 'some/non-catalog-model';
    qpStub.selectedItems = [];
    qpStub.activeItems = [];
    qpStub._fireAccept();
    await expect(p).resolves.toBeUndefined();
  });

  it('resolves undefined when the picker is cancelled', async () => {
    const p = pickOpenRouterModel(PROJECTED);
    await vi.waitFor(() => expect(qpStub._hide).toBeDefined());
    qpStub._fireHide();
    await expect(p).resolves.toBeUndefined();
  });

  it('accepting a model wins over the dispose→hide race (no false cancel)', async () => {
    // Regression for the real-VS-Code bug: onDidAccept disposes the picker,
    // which fires onDidHide. If the handler resolved AFTER dispose, onDidHide's
    // resolve(undefined) would clobber the accepted label — clicking a model
    // would read as "cancelled". The stub's dispose fires onDidHide like VS Code.
    const p = pickOpenRouterModel(PROJECTED);
    await vi.waitFor(() => expect(qpStub._accept).toBeDefined());
    const nemotron = qpStub.items.find((i: any) => i.label === 'nvidia/nemotron-3.5-lightning:free');
    qpStub.selectedItems = [nemotron];
    qpStub._fireAccept(); // accept handler disposes → fires onDidHide internally
    await expect(p).resolves.toBe('nvidia/nemotron-3.5-lightning:free');
  });
});

describe('projectCatalog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('projects full catalog entries down to the subset the picker renders', () => {
    const projected = projectCatalog(CATALOG.data as any);
    expect(projected[0]).toEqual({
      id: 'nvidia/nemotron-3.5-lightning',
      name: 'NVIDIA: Nemotron 3.5 Lightning',
      context_length: 1000000,
      pricing: { prompt: '0.00000008', completion: '0.0000002' },
    });
    // Picker entries carry only id/name/context/pricing — no capabilities/modes.
    expect(Object.keys(projected[0])).toEqual(['id', 'name', 'context_length', 'pricing']);
  });
});

describe('buildOpenRouterSummary', () => {
  it('renders limits, capabilities, modes, and pricing', () => {
    const summary = buildOpenRouterSummary({
      wireModelId: 'nvidia/nemotron-3.5-lightning:free',
      canonicalSlug: 'nvidia/nemotron-3.5-lightning-20260807',
      displayName: 'NVIDIA: Nemotron 3.5 Lightning (free)',
      capabilities: { toolCalling: true, imageInput: false },
      modelModes: { 'Think (High)': {}, 'No Think': {} },
      defaultMode: 'Think (High)',
      cost: { input: 0, output: 0, currency: 'USD' },
      runtimeLimits: { contextWindow: 1000000, maxOutputTokens: 65536 },
      expirationDate: '2098-12-31',
    });
    expect(summary).toContain('OpenRouter model: nvidia/nemotron-3.5-lightning:free');
    // toLocaleString is locale-dependent (test env may render 1.000.000) — assert
    // against the same formatting the summary uses, like the existing addServerFlow tests.
    expect(summary).toContain(`Context window: ${(1000000).toLocaleString()} tokens`);
    expect(summary).toContain(`Max output: ${(65536).toLocaleString()} tokens`);
    expect(summary).toContain('Tool calling: yes');
    expect(summary).toContain('Modes: Think (High), No Think');
    expect(summary).toContain('Estimated rates');
    expect(summary).toContain('Expires: 2098-12-31');
  });
});

describe('registerAddServerModelCommand — OpenRouter routing', () => {
  let inputBoxSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let createQuickPickSpy: ReturnType<typeof vi.spyOn>;
  let qpStub: any;
  let resolveSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (vscode as any).commands._registrations = [];
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

  it('routes an openrouter.ai URL into the OpenRouter branch (not the vLLM probe path)', async () => {
    const out = freshOutput();
    stubOpenRouterFetch();
    inputBoxSpy
      .mockResolvedValueOnce('https://openrouter.ai/nvidia/nemotron-3.5-lightning:free') // server URL
      .mockResolvedValueOnce('sk-or-v1-test')                                            // API key
      .mockResolvedValueOnce('');                                                        // headers
    infoSpy.mockResolvedValue('Save to Settings' as any);

    registerAddServerModelCommand({} as any, provider, out);
    const cmd = (vscode as any).commands._run('vllm-copilot.addServerModel');
    await vi.waitFor(() => expect(qpStub._accept).toBeDefined());
    // Model-page URL pre-filled the picker; user confirms the pick.
    expect(qpStub.value).toBe('nvidia/nemotron-3.5-lightning:free');
    qpStub.selectedItems = [{ label: 'nvidia/nemotron-3.5-lightning:free' } as any];
    qpStub._fireAccept();
    await cmd;

    expect(resolveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        serverType: 'openrouter',
        serverUrl: 'https://openrouter.ai/api',
        vllmModelId: 'nvidia/nemotron-3.5-lightning:free',
      }),
    );
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('does NOT route a bare author/slug to OpenRouter (server field = server)', async () => {
    const out = freshOutput();
    const fetchSpy = stubOpenRouterFetch();
    inputBoxSpy
      .mockResolvedValueOnce('nvidia/nemotron-3.5-lightning:free') // bare slug, no scheme
      .mockResolvedValueOnce('sk-or-v1-test')
      .mockResolvedValueOnce('');
    infoSpy.mockResolvedValue('Save to Settings' as any);

    registerAddServerModelCommand({} as any, provider, out);
    await (vscode as any).commands._run('vllm-copilot.addServerModel');

    // It is NOT an openrouter.ai host → the generic server flow runs, never the
    // OpenRouter branch: no OpenRouter model picker, no metadata lookup, no save.
    expect(createQuickPickSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalledWith(expect.stringContaining('openrouter.ai/api/v1/model'), expect.anything());
    expect(resolveSpy).not.toHaveBeenCalledWith(expect.objectContaining({ serverType: 'openrouter' }));
  });

  it('pre-selects a model pasted as a URL so Enter confirms it without manual selection', async () => {
    // Regression test for the silent "no model selected" failure: real VS Code does
    // NOT populate QuickPick.selectedItems from a programmatic .value (it fills
    // activeItems), so a pasted model-page URL previously cancelled the flow when
    // the user pressed Enter. The flow must pre-select the matching item itself.
    const out = freshOutput();
    stubOpenRouterFetch();
    inputBoxSpy
      .mockResolvedValueOnce('https://openrouter.ai/nvidia/nemotron-3.5-lightning:free') // server URL
      .mockResolvedValueOnce('sk-or-v1-test')                                            // API key
      .mockResolvedValueOnce('');                                                        // headers
    infoSpy.mockResolvedValue('Save to Settings' as any);

    registerAddServerModelCommand({} as any, provider, out);
    const cmd = (vscode as any).commands._run('vllm-copilot.addServerModel');
    await vi.waitFor(() => expect(qpStub._accept).toBeDefined());
    // The pasted URL pre-filled AND pre-selected the model.
    expect(qpStub.value).toBe('nvidia/nemotron-3.5-lightning:free');
    expect(qpStub.selectedItems[0]?.label).toBe('nvidia/nemotron-3.5-lightning:free');
    expect(qpStub.activeItems[0]?.label).toBe('nvidia/nemotron-3.5-lightning:free');
    // NO manual selectedItems assignment — this is what the regression caught.
    qpStub._fireAccept();
    await cmd;

    expect(resolveSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        serverType: 'openrouter',
        serverUrl: 'https://openrouter.ai/api',
        vllmModelId: 'nvidia/nemotron-3.5-lightning:free',
      }),
    );
    expect(provider.clearCache).toHaveBeenCalled();
  });

  it('fails clearly (no guessing, no free-text) when the catalog is unreachable via the command', async () => {
    // The catalog is the only deterministic metadata source. If it can't be
    // loaded, the flow stops up front with a clear error and never saves a model
    // it can't size. There is no free-text fallback and no per-model download.
    const out = freshOutput();
    const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const u = String(url);
      if (u.includes('/v1/models')) throw new TypeError('fetch failed'); // catalog unreachable
      return jsonResponse({}, 404);
    });
    inputBoxSpy
      .mockResolvedValueOnce('https://openrouter.ai/nvidia/nemotron-3.5-lightning:free') // server URL
      .mockResolvedValueOnce('sk-or-v1-test')                                            // API key
      .mockResolvedValueOnce('');                                                        // headers
    infoSpy.mockResolvedValue('Save to Settings' as any);

    registerAddServerModelCommand({} as any, provider, out);
    await (vscode as any).commands._run('vllm-copilot.addServerModel');

    // No picker, no free-text input box, no save — the flow stops at the catalog.
    expect(createQuickPickSpy).not.toHaveBeenCalled();
    expect(inputBoxSpy).toHaveBeenCalledTimes(3); // server URL + key + headers
    expect(resolveSpy).not.toHaveBeenCalledWith(expect.objectContaining({ serverType: 'openrouter' }));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Couldn't load the OpenRouter model catalog"));
  });
});
