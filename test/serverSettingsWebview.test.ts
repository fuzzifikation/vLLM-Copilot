import * as fs from 'node:fs';
import * as path from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const script = fs.readFileSync(
  path.resolve('resources/serverSettings.js'),
  'utf8',
);
// Vendored searchable-picker library - loaded into the harness exactly like
// the webview does (plain script tag, exposes window.Choices).
const choicesScript = fs.readFileSync(
  path.resolve('resources/choices.min.js'),
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
  withChoices = true,
) {
  const dom = new JSDOM(
    '<!doctype html><body>' +
      '<div id="root"></div>' +
      '<div class="modal-overlay" id="modal"><div id="modalBody"></div></div>' +
    '</body>',
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://webview.test/' },
  );
  const posted: any[] = [];
  (dom.window as any).acquireVsCodeApi = () => ({
    postMessage: (message: unknown) => posted.push(message),
  });
  if (withChoices) {
    (dom.window as any).eval(choicesScript);
  }
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

  it('wraps the model picker in Choices.js and re-wraps cleanly after a commit', () => {
    // The OpenRouter groups report the whole catalog (~415 ids); the searchable
    // dropdown is the only navigable way through it. Pins the three load-bearing
    // behaviors: the vendored dist loads, the picker is enhanced, and the
    // commit path (change on the backing select) re-renders with exactly ONE
    // live wrapper - render() must destroy() the old instance, or every commit
    // would leak a Choices instance with live listeners on detached DOM.
    const { dom } = loadWebview({ Think: {} }, ['wire-model', 'acme/open-model', 'other/closed-model']);
    const document = dom.window.document;
    expect((dom.window as any).Choices).toBeTypeOf('function');
    expect(document.querySelectorAll('.choices').length).toBe(1);
    const sel = document.getElementById('mSel') as HTMLSelectElement;
    expect(sel.options.length).toBe(3);

    // What a Choices selection ends in: the backing select's value, then 'change'.
    sel.value = 'acme/open-model';
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const sel2 = document.getElementById('mSel') as HTMLSelectElement;
    expect(sel2.value).toBe('acme/open-model');
    expect(document.querySelectorAll('.choices').length).toBe(1);
  });

  it('falls back to the native select when the Choices script is missing', () => {
    // Degradation path: no window.Choices - the picker must stay a usable
    // native select and the commit path must still re-render.
    const { dom } = loadWebview({ Think: {} }, ['wire-model', 'acme/open-model'], [], {}, undefined, undefined, undefined, false);
    const document = dom.window.document;
    expect((dom.window as any).Choices).toBeUndefined();
    expect(document.querySelectorAll('.choices').length).toBe(0);
    const sel = document.getElementById('mSel') as HTMLSelectElement;
    sel.value = 'acme/open-model';
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect((document.getElementById('mSel') as HTMLSelectElement).value).toBe('acme/open-model');
  });
});

// The cross-OS personality bug, pinned at the dropdown: a shipped preset is
// identified by NAME (data-name), not by the machine-bound path - the same
// settings entry must select the right option on every OS, and applying it
// must post the name so the host stores the portable reference.
describe('personality dropdown (portable name references)', () => {
  const ROBOT_PATH = 'G:/globalStorage/personalities/prompt-replacements-sarcastic-robot.json';
  const personalities = [
    { name: 'Sarcastic Robot', description: 'chrome-plated asshole', sourcePath: ROBOT_PATH, bundled: true },
    { name: 'My Fork', description: 'user file', sourcePath: 'G:/globalStorage/personalities/my-fork.json' },
  ];

  function loadPersonality(modelExtras: Record<string, unknown>, activePersonalities: Record<string, string | null>) {
    const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', {
      runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://webview.test/',
    });
    const posted: any[] = [];
    (dom.window as any).acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(m) });
    dom.window.eval(script);
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'data',
        servers: [{
          key: 'srv-k1', serverId: 'entry-1', url: 'http://server:8000', serverModelIds: ['wire-model'],
          models: [{ id: 'model-config', vllmModelId: 'wire-model', server: 'entry-1', modelModes: {}, ...modelExtras }],
        }],
        selectedServerKey: 'srv-k1', selectedModelId: 'model-config',
        knownParams: {}, providersByModel: {}, personalities, activePersonalities, systemMessageCapture: false,
      },
    }));
    return { dom, posted };
  }

  it('a stored NAME selects the bundled option and re-applies as a name reference', () => {
    const { dom, posted } = loadPersonality({ personality: 'Sarcastic Robot' }, { 'model-config': 'Sarcastic Robot' });
    const sel = dom.window.document.getElementById('personalitySel') as HTMLSelectElement;
    // Selected option is the bundled preset (its value is the local path —
    // selection proves the data-name match, not any path equality).
    expect(sel.value).toBe(ROBOT_PATH);
    expect(sel.options[sel.selectedIndex].textContent).toBe('Sarcastic Robot');
    // No phantom "(user file)" option: the name matched a real entry.
    expect([...sel.options].some(o => o.textContent.includes('(user file)'))).toBe(false);

    // Re-applying the same preset posts the NAME (portable), not just the path.
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(posted.at(-1)).toEqual({
      type: 'applyPersonality', server: 'entry-1', id: 'model-config',
      sourcePath: ROBOT_PATH, name: 'Sarcastic Robot',
    });
  });

  it('choosing a bundled preset posts the name; a user file option posts no name', () => {
    const { dom, posted } = loadPersonality({}, {});
    const sel = dom.window.document.getElementById('personalitySel') as HTMLSelectElement;

    sel.value = ROBOT_PATH; // shipped preset
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(posted.at(-1).name).toBe('Sarcastic Robot');

    sel.value = 'G:/globalStorage/personalities/my-fork.json'; // user-dropped file
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(posted.at(-1).name).toBeUndefined();
    expect(posted.at(-1).sourcePath).toBe('G:/globalStorage/personalities/my-fork.json');
  });

  it('a foreign-machine path naming no option still renders the honest user-file option', () => {
    // Pre-migration shape on a new machine: stored path is unreachable and
    // matches nothing - the dropdown shows the label, never a false Default.
    const { dom } = loadPersonality(
      { systemMessageReplacementsFile: 'c:\\Users\\me\\personalities\\my-fork.json' },
      { 'model-config': 'My Fork' },
    );
    const sel = dom.window.document.getElementById('personalitySel') as HTMLSelectElement;
    const text = [...sel.options].map(o => o.textContent);
    expect(text.some(t => t.includes('(user file)'))).toBe(true);
    expect(sel.selectedIndex).toBe(sel.options.length - 1);
  });

  it('Default still clears with no name field attached', () => {
    const { dom, posted } = loadPersonality({ personality: 'Sarcastic Robot' }, { 'model-config': 'Sarcastic Robot' });
    const sel = dom.window.document.getElementById('personalitySel') as HTMLSelectElement;
    sel.value = ''; // Default (no personality)
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect(posted.at(-1)).toEqual({ type: 'applyPersonality', server: 'entry-1', id: 'model-config', clear: true });
  });
});
