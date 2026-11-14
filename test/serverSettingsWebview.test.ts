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

  it('greys out Remove Model for unconfigured server models', () => {
    // An unconfigured server model is a live stub with no settings entry, so
    // removal could only confirm a deletion and then find nothing (the flow
    // before 2026-09-18). Pins: enabled for the configured selection, disabled
    // with a reason after switching to the stub, and the disabled click posts
    // nothing (jsdom honors disabled, exactly like the webview's Chromium).
    const { dom, posted } = loadWebview({ Think: {} }, ['wire-model', 'ghost-model']);
    const document = dom.window.document;
    const btn = document.getElementById('removeModelBtn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);

    const sel = document.getElementById('mSel') as HTMLSelectElement;
    sel.value = 'ghost-model';
    sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    const btn2 = document.getElementById('removeModelBtn') as HTMLButtonElement;
    expect(btn2.disabled).toBe(true);
    expect(btn2.getAttribute('title')).toContain('not configured');
    btn2.click();
    expect(posted.some((m: any) => m.type === 'removeModel')).toBe(false);

    // And back to the configured entry re-enables it (state follows the selection).
    const sel3 = document.getElementById('mSel') as HTMLSelectElement;
    sel3.value = 'model-config';
    sel3.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    expect((document.getElementById('removeModelBtn') as HTMLButtonElement).disabled).toBe(false);
  });
});

// The DeepSeek Harness section in Model Settings: session-wide rows that only
// ROUTE to harness commands. It never holds model state, and a harness click
// must never post a model save - the two interfaces have independent truths.
describe('DeepSeek Harness session section (routing only)', () => {
  function loadWithHarness(harness: unknown) {
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
          models: [{ id: 'model-config', vllmModelId: 'wire-model', server: 'entry-1', modelModes: {} }],
        }],
        selectedServerKey: 'srv-k1', selectedModelId: 'model-config',
        knownParams: {}, providersByModel: {}, personalities: [], activePersonalities: {},
        systemMessageCapture: false,
        ...(harness !== undefined ? { harness } : {}),
      },
    }));
    return { dom, posted };
  }

  it('labels Copilot controls as Copilot and routes harness rows to the three commands', () => {
    const { dom, posted } = loadWithHarness({
      personality: 'My Harness Personality', isDefault: false, personalityPath: 'G:/files/my-harness-personality.json',
      recording: true, recordingMarker: 'on',
    });
    const document = dom.window.document;
    const text = document.body.textContent || '';
    expect(text).toContain('Copilot Personality');
    expect(text).toContain('Record Copilot system prompts');
    expect(text).toContain('My Harness Personality');
    expect(text).toContain('ON - stored locally');
    document.getElementById('harnessPersBtn')!.click();
    document.getElementById('harnessRecBtn')!.click();
    document.getElementById('harnessRecOpenBtn')!.click();
    expect(posted.filter((m: any) => m.type === 'harnessCommand').map((m: any) => m.command)).toEqual([
      'vllm-copilot.harness.setPersonality',
      'vllm-copilot.harness.toggleRecording',
      'vllm-copilot.harness.openRecording',
    ]);
    // Routing only: no model-form write rides along with a harness click.
    expect(posted.some((m: any) => m.type === 'save' || m.type === 'applyPersonality' || m.type === 'setSystemMessageCapture')).toBe(false);
    // A running toggle offers the honest next state as its button text.
    expect((document.getElementById('harnessRecBtn') as HTMLButtonElement).textContent).toContain('OFF');
  });

  it('renders Default/OFF when the payload carries no harness state at all', () => {
    const { dom } = loadWithHarness(undefined);
    const text = dom.window.document.body.textContent || '';
    expect(text).toContain('Default (upstream DeepSeek Harness prompt)');
    expect(text).toContain('OFF - nothing is recorded');
  });

  it('refreshes the harness card while a dirty Copilot draft survives unsaved', () => {
    const servers = [{
      key: 'srv-k1', serverId: 'entry-1', url: 'http://server:8000', serverModelIds: ['wire-model'],
      models: [{ id: 'model-config', vllmModelId: 'wire-model', server: 'entry-1', modelModes: {} }],
    }];
    const { dom, posted } = loadWithHarness({
      personality: 'Default (upstream DeepSeek Harness prompt)', isDefault: true, personalityPath: '', recording: false,
    });
    const document = dom.window.document;
    expect(document.body.textContent || '').toContain('OFF - nothing is recorded');
    // Dirty the Copilot form with an unsaved edit (delegated markDirty input).
    const field = document.querySelector('#root input[data-f]') as HTMLInputElement;
    expect(field).not.toBeNull();
    const draftValue = field.value + '-DRAFT';
    field.value = draftValue;
    field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    // Host answers a harness toggle with a fresh payload while the form is dirty.
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'data', servers, selectedServerKey: 'srv-k1', selectedModelId: 'model-config',
        knownParams: {}, providersByModel: {}, personalities: [], activePersonalities: {},
        systemMessageCapture: false,
        harness: { personality: 'My Voice', isDefault: false, personalityPath: 'my-voice.json', recording: true, recordingMarker: 'on' },
      },
    }));
    // The source-independent harness section refreshed...
    const text = document.body.textContent || '';
    expect(text).toContain('ON - stored locally');
    expect(text).toContain('My Voice');
    // ...while the draft survived the partial update (no full re-render).
    expect((document.querySelector('#root input[data-f]') as HTMLInputElement).value).toBe(draftValue);
    // And the re-wired buttons still route to the real command.
    document.getElementById('harnessRecBtn')!.click();
    expect(posted.some((m: any) => m.type === 'harnessCommand' && m.command === 'vllm-copilot.harness.toggleRecording')).toBe(true);
  });

  it('never claims "nothing is recorded" while a stale ON marker still records', () => {
    // Setting OFF, marker write failed, live marker ON: the card must name the
    // mismatch - the setting alone would lie about privacy.
    const { dom } = loadWithHarness({
      personality: 'Default (upstream DeepSeek Harness prompt)', isDefault: true, personalityPath: '',
      recording: false, recordingMarker: 'on',
    });
    const text = dom.window.document.body.textContent || '';
    expect(text).toContain('OFF requested; the live marker is still ON');
    expect(text).not.toContain('OFF - nothing is recorded');
  });

  it('pre-install ON says "starts when the harness next starts", not "recording"', () => {
    const { dom } = loadWithHarness({
      personality: 'Default (upstream DeepSeek Harness prompt)', isDefault: true, personalityPath: '',
      recording: true, recordingMarker: 'absent',
    });
    const text = dom.window.document.body.textContent || '';
    expect(text).toContain('Enabled - starts recording when the harness next starts');
    expect(text).not.toContain('ON - stored locally');
  });

  it('renders the session harness card even with no server configured', () => {
    // The card needs no model, no server and no harness install - the
    // empty-state early return must not swallow it.
    const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', {
      runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://webview.test/',
    });
    const posted: any[] = [];
    (dom.window as any).acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(m) });
    dom.window.eval(script);
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: {
        type: 'data', servers: [], selectedServerKey: '', selectedModelId: '',
        knownParams: {}, providersByModel: {}, personalities: [], activePersonalities: {},
        systemMessageCapture: false,
        harness: { personality: 'Default (upstream DeepSeek Harness prompt)', isDefault: true, personalityPath: '', recording: false },
      },
    }));
    const document = dom.window.document;
    const text = document.body.textContent || '';
    expect(text).toContain('No servers configured');
    expect(document.getElementById('harnessSection')).not.toBeNull();
    expect(text).toContain('OFF - nothing is recorded');
    document.getElementById('harnessPersBtn')!.click();
    expect(posted.some((m: any) => m.type === 'harnessCommand' && m.command === 'vllm-copilot.harness.setPersonality')).toBe(true);
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
