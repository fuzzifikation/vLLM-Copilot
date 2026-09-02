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
    serverId: 'entry-1',
    url: 'http://server:8000',
    serverModelIds,
    ...(serverType ? { serverType } : {}),
    models: [{
      id: 'model-config',
      vllmModelId: 'wire-model',
      server: 'entry-1',
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
});
