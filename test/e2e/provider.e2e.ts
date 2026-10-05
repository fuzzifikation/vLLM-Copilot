/**
 * Spike A (docs/automated-user-testing.md §Recommendation 1): the extension-host
 * end-to-end rail. These run INSIDE a real, freshly launched VS Code (stable,
 * throwaway profile via @vscode/test-cli) with the REAL extension loaded from
 * out/ and the REAL `vscode` module — no mock host, no vitest alias.
 *
 * What this proves that 1001 unit tests cannot: real manifest-driven activation
 * on the vendor selector query, real discovery through the provider API, the
 * whole Copilot call path (provider -> request assembly -> transport -> SSE ->
 * parts) over loopback HTTP, and genuine mid-request cancellation with real
 * connection teardown. The loopback mock backend journals every wire body, so
 * the assertions run on bytes the server actually received, not on the
 * client's diary about what it meant to send.
 *
 * Deliberately OUT of `npm run build`: a nightly hunter (it pops a real VS
 * Code window), not a per-commit gate. Run with `npm run test:e2e`.
 */
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { chunk, doneChunk, startMockBackend, type MockBackend } from './mockBackend.js';

const VENDOR = 'vllm-copilot';
const MODEL_CFG_ID = 'e2e-test';
const WIRE_ID = 'mock/e2e-model';

const WEATHER_TOOL = {
  name: 'get_weather',
  description: 'Get the current weather for a city',
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise(done => setTimeout(done, ms));
}

/**
 * Poll the vendor query until our configured model appears. The first call
 * triggers activation (activationEvents: languageModel_chatVendor) plus live
 * discovery, so a single immediate miss is normal; never appeared = red.
 */
async function resolveModel(): Promise<vscode.LanguageModelChat> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const models = await vscode.lm.selectChatModels({ vendor: VENDOR });
    const mine = models.find(m => m.id === MODEL_CFG_ID);
    if (mine) return mine;
    if (Date.now() > deadline) {
      assert.fail(`model "${MODEL_CFG_ID}" never appeared for vendor "${VENDOR}" within 90s`);
    }
    await sleep(2000);
  }
}

describe('Spike A: real extension host, real provider, mock backend', function () {
  let backend: MockBackend;

  // Generous per-test budget: the first vendor query pays VS Code startup,
  // activation and discovery. Still nowhere near the manual clicking marathon.
  this.timeout(180_000);

  before(async () => {
    backend = await startMockBackend();
    // Seed settings BEFORE any vendor query. User scope lands in the harness's
    // throwaway profile, so the extension under test reads exactly this.
    const cfg = vscode.workspace.getConfiguration('vllm-copilot');
    await cfg.update(
      'servers',
      [{ id: 'e2e', serverUrl: backend.base, serverType: 'vllm', requestHeaders: {} }],
      vscode.ConfigurationTarget.Global
    );
    await cfg.update(
      'models',
      [{ id: MODEL_CFG_ID, vllmModelId: WIRE_ID, server: 'e2e' }],
      vscode.ConfigurationTarget.Global
    );
  });

  after(async () => {
    await backend.close();
  });

  it('activates on the vendor selector and publishes the configured model', async () => {
    const model = await resolveModel();
    assert.equal(model.vendor, VENDOR, 'vendor must be the registered provider id');
    assert.ok(model.name && model.name.length > 0, 'picker name must survive to the LM API');
  });

  it('streams a full tool turn: text parts, split tool-call deltas, wire bytes as sent', async () => {
    const model = await resolveModel();
    const requestsBefore = backend.requests.length;

    // Wire-accurate vLLM chunk shape (verified against vllm-project/vllm
    // 2026-10-05): the tool NAME arrives complete, exactly once — vLLM's own
    // reconstructor asserts it — while arguments stream as diffs. An earlier
    // fixture here split the name and "proved" a truncation bug that does not
    // exist: the mock was lying, not the product. Text and arguments are
    // genuinely split below, which is what real servers do.
    backend.queue.push({
      sse:
        chunk({ role: 'assistant', content: 'Let me' }) +
        chunk({ content: ' check' }) +
        chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }) +
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }) +
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"Berlin"}' } }] }) +
        chunk({}, 'tool_calls', { prompt_tokens: 25, completion_tokens: 12, total_tokens: 37 }) +
        doneChunk(),
    });

    const cts = new vscode.CancellationTokenSource();
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User('What is the weather in Berlin?')],
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

    assert.equal(texts.join(''), 'Let me check', 'text deltas must arrive in order');
    assert.equal(toolCalls.length, 1, 'split tool-call deltas must finalize to exactly one call');
    assert.equal(toolCalls[0].name, 'get_weather', 'the complete streamed tool name must survive intact');
    assert.deepEqual(toolCalls[0].input, { city: 'Berlin' }, 'split argument fragments must reparse');

    // Server-side wire truth — what the backend actually received.
    const chatRequests = backend.requests.slice(requestsBefore);
    assert.equal(chatRequests.length, 1, 'exactly one HTTP request: no hidden retry or double-fire');
    const body = chatRequests[0];
    assert.equal(body.model, WIRE_ID, 'wire body must carry the vllmModelId, not the config id');
    assert.equal(body.stream, true, 'request must be a streaming request');
    const tools = body.tools as { type: string; function: { name: string } }[];
    assert.equal(tools?.[0]?.function?.name, 'get_weather', 'tool definitions must reach the wire');
  });

  it('cancels mid-stream: stream stops, connection tears down, no re-ask', async () => {
    const model = await resolveModel();
    const requestsBefore = backend.requests.length;
    backend.queue.push({ slow: true }); // one chunk, then silence until the abort

    const cts = new vscode.CancellationTokenSource();
    // The real user gesture: cancel while the request is IN FLIGHT. A
    // provider-API sendRequest promise is not resolved until the provider
    // response settles, so cancelling from inside the drain loop is not just
    // unnatural — it is unreachable (a first draft sat in await sendRequest
    // for the full 180s mocha budget and had the harness close the socket).
    const cancelTimer = setTimeout(() => cts.cancel(), 3000);
    const texts: string[] = [];
    let streamError: unknown;
    try {
      const response = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User('Tell me an endless story')],
        {},
        cts.token
      );
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) texts.push(part.value);
      }
    } catch (err) {
      streamError = err;
    }
    clearTimeout(cancelTimer);
    cts.dispose();

    // VS Code may end the stream quietly or surface a CancellationError; both
    // are legal outcomes of a user cancel. What is NOT legal: the backend
    // connection surviving the cancel, or the client re-asking in secret.
    const openEntry = backend.open[backend.open.length - 1];
    assert.ok(openEntry, 'backend must have registered the open slow stream');
    assert.ok(openEntry.closed, 'cancellation must tear down the backend connection (res close)');

    await sleep(1500); // grace window for any secretly-scheduled re-ask
    assert.equal(backend.requests.length, requestsBefore + 1, 'cancelled request must not be re-asked');
    if (streamError) {
      // If an error surfaced it must be the cancel itself, never a transport
      // classification that would (by product law) invalidate the picker.
      const msg = String(streamError);
      assert.ok(/cancel/i.test(msg), `unexpected non-cancellation error after user cancel: ${msg}`);
    }
    void texts; // partial text may or may not have drained before cancel — timing, not contract
  });
});
