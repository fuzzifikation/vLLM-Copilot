/**
 * New-user onboarding walk: empty settings → Add Server/Model wizard → first
 * prompt, inside the real extension host (docs/automated-user-testing.md
 * Spike B's goal WITHOUT Selenium). The wizard speaks purely in
 * window.showInputBox / showQuickPick / showInformationMessage, and the test
 * file runs in the SAME extension host process as the extension, so the suite
 * stubs those dialog primitives in-process and scripts the user's keystrokes:
 * URL, empty key, empty headers, model pick, 'Save to Settings'. The product
 * code under test is untouched — it believes it is talking to a human.
 *
 * The whole walk is asserted where it matters: the DIALOG SEQUENCE (each
 * scripted answer passes the flow's own validateInput), the SETTINGS WRITE
 * (server entry + model config as actually persisted), and the FIRST PROMPT
 * (vendor select → real sendRequest tool turn against the same loopback
 * backend the wizard discovered).
 *
 * Deliberately OUT of `npm run build`, like the rest of the rail.
 */
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { chunk, doneChunk, startMockBackend, type MockBackend } from './mockBackend.js';

const VENDOR = 'vllm-copilot';
const WIRE_ID = 'mock/e2e-model';

const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Get the current weather for a city',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

function sleep(ms: number): Promise<void> {
  return new Promise(done => setTimeout(done, ms));
}

interface DialogCall {
  kind: 'input' | 'quickpick' | 'info' | 'warn';
  title: string;
}

/**
 * Replace the dialog primitives the wizard uses with scripted answers for the
 * duration of the suite. Answers are chosen by dialog TITLE, not call order:
 * the flows also fire-and-forget non-blocking toasts (`void showInfo...`), so
 * an order-based script would be a timing house of cards. Every scripted
 * value is run through the dialog's own validateInput first, so a scripted
 * keystroke the real UI would reject fails the test instead of being smuggled
 * in.
 */
function installDialogStubs(serverUrl: string, pickLabel: string) {
  const log: DialogCall[] = [];
  const w = vscode.window as unknown as Record<string, unknown>;
  const original = {
    showInputBox: w.showInputBox,
    showQuickPick: w.showQuickPick,
    showInformationMessage: w.showInformationMessage,
    showWarningMessage: w.showWarningMessage,
  };

  w.showInputBox = (options?: { title?: string; validateInput?: (v: string) => string | undefined | Thenable<string | undefined> }) => {
    const title = String(options?.title ?? '');
    log.push({ kind: 'input', title });
    // The URL box is titled "(1/2)"; key and headers boxes take empty Enter,
    // which the flows read as "no key / no headers".
    const value = title.includes('(1/2)') ? serverUrl : '';
    const verdict = options?.validateInput?.(value);
    assert.ok(!(verdict instanceof Promise), `validateInput on "${title}" is async — stub cannot script it`);
    assert.equal(
      verdict as string | undefined,
      undefined,
      `the flow's own validateInput rejected the scripted answer for "${title}": ${String(verdict)}`
    );
    return Promise.resolve(value);
  };

  w.showQuickPick = (items: { label: string }[]) => {
    log.push({ kind: 'quickpick', title: `items=${items.length}` });
    const wanted = items.find(i => i.label === pickLabel);
    assert.ok(wanted, `model "${pickLabel}" was not offered; wizard offered: ${items.map(i => i.label).join(', ')}`);
    return Promise.resolve(wanted);
  };

  // The flows' toasts return undefined (nothing clicked); the confirm modal
  // answers 'Save to Settings' — the wizard's whole point is that the user
  // actually agrees to the write.
  w.showInformationMessage = (...args: unknown[]) => {
    const items = args.filter(a => typeof a === 'string') as string[];
    const answer = items.includes('Save to Settings') ? 'Save to Settings' : undefined;
    log.push({ kind: 'info', title: answer ? 'Save to Settings' : 'toast' });
    return Promise.resolve(answer);
  };

  // No failure paths are scripted; a warning means the flow went off the rails.
  w.showWarningMessage = (...args: unknown[]) => {
    const message = String(args[0] ?? '');
    log.push({ kind: 'warn', title: message.slice(0, 120) });
    return Promise.resolve(undefined);
  };

  return {
    log,
    restore: () => Object.assign(w, original),
  };
}

async function readSeeded(): Promise<{ servers: Record<string, unknown>[]; models: Record<string, unknown>[] }> {
  const cfg = vscode.workspace.getConfiguration('vllm-copilot');
  return {
    servers: (cfg.get<Record<string, unknown>[]>('servers') ?? []).slice(),
    models: (cfg.get<Record<string, unknown>[]>('models') ?? []).slice(),
  };
}

describe('new-user walk: empty settings -> wizard -> first prompt', function () {
  let backend: MockBackend;
  let stubs: ReturnType<typeof installDialogStubs>;

  this.timeout(180_000);

  before(async () => {
    backend = await startMockBackend();
    // The blank slate: a true new user starts with no servers and no models.
    const cfg = vscode.workspace.getConfiguration('vllm-copilot');
    await cfg.update('servers', [], vscode.ConfigurationTarget.Global);
    await cfg.update('models', [], vscode.ConfigurationTarget.Global);
    stubs = installDialogStubs(backend.base, WIRE_ID);
  });

  after(async () => {
    stubs?.restore();
    await backend?.close();
  });

  it('walks the wizard: URL, auth, model pick, confirm, settings written', async () => {
    // Contributed command: invoking it activates the extension like a palette
    // keystroke would.
    await vscode.commands.executeCommand('vllm-copilot.addServerModel');

    // The dialog sequence the user actually lived through.
    const kinds = stubs.log.map(c => `${c.kind}:${c.title}`);
    const wanted = [
      'input:Add or Reconfigure Server/Model (1/2)',
      'input:Add or Reconfigure Server/Model - API Key',
      'input:Add or Reconfigure Server/Model - Custom Headers',
      `quickpick:items=1`,
      'info:Save to Settings',
    ];
    for (const step of wanted) {
      assert.ok(kinds.includes(step), `wizard never reached dialog "${step}"; walked: ${kinds.join(' | ')}`);
    }
    assert.ok(
      !kinds.some(k => k.startsWith('warn:')),
      `wizard hit a warning dialog (off the happy path): ${kinds.filter(k => k.startsWith('warn:')).join(' | ')}`
    );

    // What the wizard PERSISTED — the artifact the user walks away with.
    const { servers, models } = await readSeeded();
    assert.equal(servers.length, 1, 'exactly one server entry written');
    assert.equal(servers[0].serverUrl, backend.base, 'entry carries the entered URL');
    assert.equal(servers[0].serverType, 'vllm', 'backend detection landed on the entry');
    assert.equal(models.length, 1, 'exactly one model config written');
    assert.equal(models[0].vllmModelId, WIRE_ID, 'model config carries the picked wire id');
    assert.equal(models[0].server, servers[0].id, 'model references the registered server entry');
  });

  it('the just-added model answers the first prompt with a tool turn', async () => {
    // Publish happens through the provider change event after the settings
    // write; poll like a user reopening the picker.
    const deadline = Date.now() + 90_000;
    let model: vscode.LanguageModelChat | undefined;
    for (;;) {
      const models = await vscode.lm.selectChatModels({ vendor: VENDOR });
      model = models.find(m => m.id.includes(WIRE_ID));
      if (model) break;
      if (Date.now() > deadline) assert.fail('the wizard-added model never reached the model picker');
      await sleep(2000);
    }

    backend.queue.push({
      sse:
        chunk({ role: 'assistant', content: 'One moment' }) +
        chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }) +
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }) +
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] }) +
        chunk({}, 'tool_calls', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) +
        doneChunk(),
    });

    const requestsBefore = backend.requests.length;
    const cts = new vscode.CancellationTokenSource();
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User('Weather in Paris?')],
      { tools: [WEATHER_TOOL] },
      cts.token
    );
    const texts: string[] = [];
    const toolCalls: vscode.LanguageModelToolCallPart[] = [];
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) texts.push(part.value);
      else if (part instanceof vscode.LanguageModelToolCallPart) toolCalls.push(part);
    }
    cts.dispose();

    assert.equal(texts.join(''), 'One moment', 'text parts arrive in order');
    assert.equal(toolCalls.length, 1, 'exactly one tool call');
    assert.equal(toolCalls[0].name, 'get_weather');
    assert.deepEqual(toolCalls[0].input, { city: 'Paris' });

    const chats = backend.requests.slice(requestsBefore);
    assert.equal(chats.length, 1, 'first prompt is exactly one wire request');
    assert.equal(chats[0].model, WIRE_ID, 'the wizard-derived wire id is what the server saw');
  });
});
