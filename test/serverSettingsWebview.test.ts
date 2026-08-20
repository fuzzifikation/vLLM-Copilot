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

  it('renders only Auto when the provider list is unavailable (no fabricated options)', () => {
    const { dom } = loadWebview({}, ['wire-model'], [], {}, 'openrouter');
    const document = dom.window.document;
    const provider = document.querySelector<HTMLSelectElement>('select[data-f="provider"]')!;
    expect(provider).not.toBeNull();
    expect([...provider.options].map(o => o.value)).toEqual(['']);
    expect([...provider.options].map(o => o.textContent)).toEqual(['Auto']);
  });
});