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
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: {
      type: 'data',
      servers: [{
        url: 'http://server:8000',
        serverModelIds,
        models: [{
          id: 'model-config',
          vllmModelId: 'wire-model',
          serverUrl: 'http://server:8000',
          defaultParams: { parallel_tool_calls: true },
          modelModes,
        }],
      }],
      selectedServerUrl: 'http://server:8000',
      selectedModelId: 'model-config',
      knownParams: {
        parallel_tool_calls: {
          label: 'Parallel Tool Calls',
          type: 'string',
          options: ['true', 'false'],
        },
      },
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
});