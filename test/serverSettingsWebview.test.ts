import * as fs from 'node:fs';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const script = fs.readFileSync(
  path.resolve('resources/serverSettings.js'),
  'utf8',
);

function loadWebview(
  modelModes: Record<string, Record<string, unknown>>,
  serverModelIds: string[] = ['wire-model'],
  extraServers: any[] = [],
  providersByModel: Record<string, any[]> = {},
  serverType?: string,
  initialProvider?: string,
  initialRoutingMode?: string,
) {
  const dom = new JSDOM(
    '<!doctype html><body>' +
      '<div id="root"></div>' +
      '<div class="modal-overlay" id="modal"><div id="modalBody"></div></div>' +
    '</body>',
    { runScripts: 'outside-only', url: 'https://webview.test/' },
  );
  const posted: any[] = [];
  (dom.window as any).acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => posted.push(message),
  });
  dom.window.eval(script);
  const servers = [{
    key: 'srv-k1',
    url: 'http://server:8000',
    serverModelIds,
    models: [{
      id: 'model-config',
      vllmModelId: 'wire-model',
      serverUrl: 'http://server:8000',
      ...(serverType ? { serverType } : {}),
      ...(initialProvider !== undefined ? { provider: initialProvider } : {}),
      ...(initialRoutingMode !== undefined ? { routingMode: initialRoutingMode } : {}),
      defaultParams: { parallel_tool_calls: true },
      modelModes,
    }],
  }, ...extraServers];
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: {
      type: 'data',
      servers,
      selectedServerKey: servers[0].key,
      selectedModelId: 'model-config',
      knownParams: {
        parallel_tool_calls: {
          label: 'Parallel Tool Calls',
          type: 'string',
          options: ['true', 'false'],
        },
      },
      providersByModel,
      personalities: [],
      activePersonalities: {},
      systemMessageCapture: false,
    },
  }));
  return { dom, posted };
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('Model Settings webview', () => {
  it('posts boolean false values as booleans, not strings', () => {
    const { dom, posted } = loadWebview({
      Think: { parallel_tool_calls: true },
    });
    const document = dom.window.document;
    const defaultSelect = document.querySelector<HTMLSelectElement>(
      '#dpList select[data-dk="parallel_tool_calls"]',
    )!;
    const modeSelect = document.querySelector<HTMLSelectElement>(
      '.mode-card select[data-mk="parallel_tool_calls"]',
    )!;
    defaultSelect.value = 'false';
    modeSelect.value = 'false';
    defaultSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    document.getElementById('saveBtn')!.click();

    const save = [...posted].reverse().find((message: any) => message.type === 'save');
    expect(save.config.defaultParams.parallel_tool_calls).toBe(false);
    expect(save.config.modelModes.Think.parallel_tool_calls).toBe(false);
  });

  it('rejects duplicate mode names on add and rename', async () => {
    const { dom } = loadWebview({ Think: {}, Coding: {} });
    const document = dom.window.document;

    document.getElementById('addModeBtn')!.click();
    (document.getElementById('modalInput') as HTMLInputElement).value = 'Think';
    document.getElementById('modalOk')!.click();
    await flush();
    expect(document.querySelectorAll('.mode-card')).toHaveLength(2);
    expect(document.getElementById('modalBody')!.textContent).toContain('already exists');
    document.getElementById('modalOk')!.click();

    const codingCard = [...document.querySelectorAll<HTMLElement>('.mode-card')]
      .find(card => card.dataset.mn === 'Coding')!;
    codingCard.querySelector<HTMLButtonElement>('.rename-mode-btn')!.click();
    (document.getElementById('modalInput') as HTMLInputElement).value = 'Think';
    document.getElementById('modalOk')!.click();
    await flush();
    expect(codingCard.dataset.mn).toBe('Coding');
    expect(document.getElementById('modalBody')!.textContent).toContain('already exists');
  });

  it('marks configured models not running on the server as inactive', () => {
    // Server reports only 'wire-model'; the configured model's wire id matches,
    // so it is ACTIVE and must NOT carry an (inactive) marker.
    const { dom } = loadWebview({}, ['wire-model']);
    const select = dom.window.document.querySelector<HTMLSelectElement>('#mSel')!;
    const option = [...select.options].find(o => o.value === 'model-config')!;
    expect(option.textContent).toBe('wire-model');

    // Server reports a DIFFERENT set — the configured model is stale/inactive.
    const { dom: dom2 } = loadWebview({}, ['some-other-model']);
    const select2 = dom2.window.document.querySelector<HTMLSelectElement>('#mSel')!;
    const option2 = [...select2.options].find(o => o.value === 'model-config')!;
    expect(option2.textContent).toBe('wire-model (inactive)');
  });

  it('does not mark models inactive when the server probe reported nothing', () => {
    // Empty serverModelIds = probe failed / non-`/v1/models` backend — "unknown",
    // not "inactive". No marker should be added.
    const { dom } = loadWebview({}, []);
    const select = dom.window.document.querySelector<HTMLSelectElement>('#mSel')!;
    const option = [...select.options].find(o => o.value === 'model-config')!;
    expect(option.textContent).toBe('wire-model');
  });

  it('disambiguates multiple header identities sharing one URL', () => {
    const { dom, posted } = loadWebview({}, ['wire-model'], [{
      key: 'srv-k2',
      url: 'http://server:8000',
      serverModelIds: ['model-b'],
      // Legacy configs may have no explicit id; identity uses the same
      // id-or-vllmModelId fallback as the rest of Model Settings.
      models: [{ vllmModelId: 'model-b', serverUrl: 'http://server:8000' }],
    }]);
    const select = dom.window.document.querySelector<HTMLSelectElement>('#sSel')!;
    expect(select.options).toHaveLength(2);
    // Both options are disambiguated so the two identities are explicit.
    expect(select.options[0].value).toBe('srv-k1');
    expect(select.options[0].textContent).toBe('http://server:8000 (identity 1)');
    expect(select.options[1].value).toBe('srv-k2');
    expect(select.options[1].textContent).toBe('http://server:8000 (identity 2)');

    select.value = 'srv-k2';
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    dom.window.document.getElementById('autoConfigureBtn')!.click();
    const action = posted.find((message: any) => message.type === 'autoConfigure');
    expect(action).toMatchObject({
      serverUrl: 'http://server:8000',
      id: 'model-b',
      identityModelId: 'model-b',
    });
  });

  it('renders a provider dropdown for OpenRouter models from the API list (Auto + tags verbatim)', () => {
    // An OpenRouter model with a fetched provider list keyed by wire id.
    const { dom } = loadWebview(
      {},
      ['wire-model'],
      [],
      {
        'wire-model': [
          { tag: 'together', providerName: 'Together', quantization: 'unknown' },
          { tag: 'gmicloud/fp8', providerName: 'GMICloud', quantization: 'fp8' },
        ],
      },
      'openrouter',
    );
    const document = dom.window.document;
    const provider = document.querySelector<HTMLSelectElement>('select[data-f="provider"]')!;
    expect(provider).not.toBeNull();
    // Auto (empty) first, then the API tags verbatim (no derivation).
    expect([...provider.options].map(o => o.value)).toEqual(['', 'together', 'gmicloud/fp8']);
    expect([...provider.options].map(o => o.textContent)).toEqual(['Auto', 'Together', 'GMICloud (fp8)']);
  });

  it('annotates each provider option with its reported context + output limits', () => {
    // Providers reporting context_length / max_completion_tokens get a compact
    // suffix in the option label and the exact numbers in the hover title.
    // Display-only — nothing is persisted from these fields.
    const { dom } = loadWebview({}, ['wire-model'], [], {
      'wire-model': [
        { tag: 'together', providerName: 'Together', contextLength: 131072, maxCompletionTokens: 2048 },
        { tag: 'sambanova-turbo', providerName: 'SambaNova', contextLength: 32768, maxCompletionTokens: 7168 },
        { tag: 'nocontext', providerName: 'NoCtx' }, // no limits → plain label
      ],
    }, 'openrouter');
    const document = dom.window.document;
    const provider = document.querySelector<HTMLSelectElement>('select[data-f="provider"]')!;
    expect([...provider.options].map(o => o.value)).toEqual(['', 'together', 'sambanova-turbo', 'nocontext']);
    // Compact limits suffix on the labeled providers, absent on the bare one.
    expect([...provider.options].map(o => o.textContent)).toEqual([
      'Auto',
      'Together · Ctx (131k tot, 2k out)',
      'SambaNova · Ctx (32.8k tot, 7.2k out)',
      'NoCtx',
    ]);
    // Exact numbers ride in the option title for the hover.
    expect(provider.options[1].title).toContain('131,072 context');
    expect(provider.options[1].title).toContain('2,048 max output');
    expect(provider.options[2].title).toContain('32,768 context');
    expect(provider.options[2].title).toContain('7,168 max output');
    expect(provider.options[3].title).toBe('');
  });

  it('annotates each provider option with per-1M pricing (compact label, exact hover)', () => {
    // Per-token pricing strings → per-1M in the label (up to 4 decimals, trailing
    // zeros trimmed, locale-independent); full precision in the hover title.
    // Cache price shown only when present.
    const { dom } = loadWebview({}, ['wire-model'], [], {
      'wire-model': [
        // Alibaba-style: full pricing incl. cache.
        { tag: 'alibaba', providerName: 'Alibaba', contextLength: 1000000, maxCompletionTokens: 393216, pricing: { prompt: '0.0000012052', completion: '0.0000031655', input_cache_read: '0.0000001205' } },
        // Together-style: no cache price → cache omitted.
        { tag: 'together', providerName: 'Together', contextLength: 131072, maxCompletionTokens: 2048, pricing: { prompt: '0.00000066', completion: '0.00000198' } },
        // Unknown price (-1) → that component omitted.
        { tag: 'unknown', providerName: 'Unknown', pricing: { prompt: '-1', completion: '0.000002' } },
        // No pricing at all → plain label.
        { tag: 'nopricing', providerName: 'NoPricing' },
      ],
    }, 'openrouter');
    const document = dom.window.document;
    const provider = document.querySelector<HTMLSelectElement>('select[data-f="provider"]')!;
    expect([...provider.options].map(o => o.value)).toEqual(['', 'alibaba', 'together', 'unknown', 'nopricing']);
    // Compact label: Ctx + Cost/M, present fields only.
    expect([...provider.options].map(o => o.textContent)).toEqual([
      'Auto',
      'Alibaba · Ctx (1M tot, 393k out) · Cost/M (in $1.2052, out $3.1655, cache $0.1205)',
      'Together · Ctx (131k tot, 2k out) · Cost/M (in $0.66, out $1.98)',
      'Unknown · Cost/M (out $2)',
      'NoPricing',
    ]);
    // Exact per-1M prices ride in the hover title.
    expect(provider.options[1].title).toContain('prompt $1.2052/M');
    expect(provider.options[1].title).toContain('completion $3.1655/M');
    expect(provider.options[1].title).toContain('cache $0.1205/M');
    expect(provider.options[3].title).toContain('completion $2/M');
    expect(provider.options[4].title).toBe('');
  });

  it('does NOT render a provider dropdown for non-OpenRouter models', () => {
    const { dom } = loadWebview({});
    const provider = dom.window.document.querySelector('select[data-f="provider"]');
    expect(provider).toBeNull();
  });

  it('persists a selected provider tag on save', () => {
    const { dom, posted } = loadWebview(
      {},
      ['wire-model'],
      [],
      { 'wire-model': [{ tag: 'gmicloud/fp8', providerName: 'GMICloud', quantization: 'fp8' }] },
      'openrouter',
    );
    const document = dom.window.document;
    const provider = document.querySelector<HTMLSelectElement>('select[data-f="provider"]')!;
    provider.value = 'gmicloud/fp8';
    provider.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    document.getElementById('saveBtn')!.click();

    const save = [...posted].reverse().find((message: any) => message.type === 'save');
    expect(save.config.provider).toBe('gmicloud/fp8');
  });

  it('clears the provider back to Auto (empty value) on save', () => {
    const { dom, posted } = loadWebview(
      {},
      ['wire-model'],
      [],
      { 'wire-model': [{ tag: 'gmicloud/fp8', providerName: 'GMICloud', quantization: 'fp8' }] },
      'openrouter',
      'gmicloud/fp8',
    );
    const document = dom.window.document;
    const provider = document.querySelector<HTMLSelectElement>('select[data-f="provider"]')!;
    // The model already has a pinned provider; the dropdown pre-selects it.
    expect(provider.value).toBe('gmicloud/fp8');
    // Switch back to "Auto" (the empty option) and save — must send '' so the
    // store's normalizeModelEntry deletes the key (undefined/omitted = Auto).
    provider.value = '';
    provider.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    document.getElementById('saveBtn')!.click();

    const save = [...posted].reverse().find((message: any) => message.type === 'save');
    expect(save.config.provider).toBe('');
  });

  it('renders only Auto when the provider list is unavailable (no fabricated options)', () => {
    const { dom } = loadWebview({}, ['wire-model'], [], {}, 'openrouter');
    const document = dom.window.document;
    const provider = document.querySelector<HTMLSelectElement>('select[data-f="provider"]')!;
    expect(provider).not.toBeNull();
    expect([...provider.options].map(o => o.value)).toEqual(['']);
    expect([...provider.options].map(o => o.textContent)).toEqual(['Auto']);
  });

  it('renders the routing-mode dropdown for OpenRouter models with Standard/Nitro/Exacto', () => {
    const { dom } = loadWebview({}, ['wire-model'], [], {}, 'openrouter');
    const document = dom.window.document;
    const routing = document.querySelector<HTMLSelectElement>('select[data-f="routingMode"]')!;
    expect(routing).not.toBeNull();
    expect([...routing.options].map(o => o.value)).toEqual(['standard', 'nitro', 'exacto']);
    expect([...routing.options].map(o => o.textContent)).toEqual(['Standard', 'Nitro', 'Exacto']);
    // Enabled (not disabled) when routing is Auto — no provider pinned.
    expect(routing.disabled).toBe(false);
    // Standard is the default.
    expect(routing.value).toBe('standard');
  });

  it('pre-selects the saved routing mode', () => {
    const { dom } = loadWebview({}, ['wire-model'], [], {}, 'openrouter', undefined, 'nitro');
    const document = dom.window.document;
    const routing = document.querySelector<HTMLSelectElement>('select[data-f="routingMode"]')!;
    expect(routing.value).toBe('nitro');
  });

  it('disables the routing dropdown when a provider is pinned', () => {
    const { dom } = loadWebview({}, ['wire-model'], [], { 'wire-model': [{ tag: 'gmicloud/fp8', providerName: 'GMICloud' }] }, 'openrouter', 'gmicloud/fp8');
    const document = dom.window.document;
    const routing = document.querySelector<HTMLSelectElement>('select[data-f="routingMode"]')!;
    expect(routing.disabled).toBe(true);
  });

  it('syncs the routing dropdown LIVE to the provider selection — no save-and-re-render needed', () => {
    const { dom } = loadWebview({}, ['wire-model'], [], { 'wire-model': [{ tag: 'gmicloud/fp8', providerName: 'GMICloud' }] }, 'openrouter');
    const document = dom.window.document;
    const provider = document.querySelector<HTMLSelectElement>('select[data-f="provider"]')!;
    const routing = document.querySelector<HTMLSelectElement>('select[data-f="routingMode"]')!;
    const hint = document.getElementById('routingHint')!;
    // Starts Auto → routing selectable, hint hidden.
    expect(provider.value).toBe('');
    expect(routing.disabled).toBe(false);
    expect(hint.hidden).toBe(true);

    // Pin a provider in the dropdown — routing greys out immediately, hint shows.
    provider.value = 'gmicloud/fp8';
    provider.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(routing.disabled).toBe(true);
    expect(hint.hidden).toBe(false);

    // Flip back to Auto — routing is selectable again, hint hides.
    provider.value = '';
    provider.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(routing.disabled).toBe(false);
    expect(hint.hidden).toBe(true);
  });

  it('persists the routing mode on save', () => {
    const { dom, posted } = loadWebview({}, ['wire-model'], [], {}, 'openrouter');
    const document = dom.window.document;
    const routing = document.querySelector<HTMLSelectElement>('select[data-f="routingMode"]')!;
    routing.value = 'exacto';
    routing.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    document.getElementById('saveBtn')!.click();

    const save = [...posted].reverse().find((message: any) => message.type === 'save');
    expect(save.config.routingMode).toBe('exacto');
  });

  it('maps Standard to the clear signal on save — the default must not pollute the config', () => {
    // "Standard" is the DEFAULT routing mode, semantically identical to omitting
    // the field. Saving with it selected must send '' (→ delete), not a redundant
    // `routingMode: "standard"` on every Auto-routed OpenRouter config.
    const { dom, posted } = loadWebview({}, ['wire-model'], [], {}, 'openrouter');
    const document = dom.window.document;
    const routing = document.querySelector<HTMLSelectElement>('select[data-f="routingMode"]')!;
    expect(routing.value).toBe('standard'); // default selection
    // Make the form dirty so Save All is enabled.
    const displayName = document.querySelector<HTMLInputElement>('input[data-f="displayName"]')!;
    displayName.value = 'edited';
    displayName.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    document.getElementById('saveBtn')!.click();

    const save = [...posted].reverse().find((message: any) => message.type === 'save');
    expect(save.config.routingMode).toBe(''); // '' → normalizeModelEntry deletes the key
  });

  it('drops the routing mode on save when a provider is pinned (Auto-only setting)', () => {
    const { dom, posted } = loadWebview(
      {},
      ['wire-model'],
      [],
      { 'wire-model': [{ tag: 'gmicloud/fp8', providerName: 'GMICloud' }] },
      'openrouter',
      'gmicloud/fp8',
      'nitro',
    );
    const document = dom.window.document;
    const routing = document.querySelector<HTMLSelectElement>('select[data-f="routingMode"]')!;
    expect(routing.disabled).toBe(true); // pinned provider → disabled
    // Make the form dirty so Save All Changes is enabled (it's disabled until an edit).
    const displayName = document.querySelector<HTMLInputElement>('input[data-f="displayName"]')!;
    displayName.value = 'edited';
    displayName.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    document.getElementById('saveBtn')!.click();

    const save = [...posted].reverse().find((message: any) => message.type === 'save');
    expect(save.config.routingMode).toBe(''); // cleared — '' reaches the store → delete
  });
});