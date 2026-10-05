/**
 * Live-backend smoke: the same extension-host rail as Spike A, but pointed at a
 * REAL vLLM server instead of the loopback mock. This is the automated half of
 * the Phase-9 line "acceptance requires a real vLLM tool turn": real discovery,
 * real tokenizer, real tool parser, real streaming bytes. The mock proves the
 * contract; only a live server can prove we honor someone else's implementation
 * of it.
 *
 * SELF-SKIPPING. Nothing here runs unless the environment opts in, so the
 * normal `npm run test:e2e` stays green on any machine, offline, forever.
 * The ergonomic entry point is `npm run test:e2e:live`: it reads YOUR OWN
 * VS Code user settings, asks which configured model to use, and passes the
 * connection details to this run as child-process env (nothing in the repo).
 * The raw variables, for headless use:
 *   VLLM_E2E_SERVER_URL  (gate) base URL of the vLLM server, e.g. https://host:port
 *   VLLM_E2E_HEADERS     (optional) JSON object of request headers, as the
 *                        server registry entry's requestHeaders carries them
 *   VLLM_E2E_API_KEY     (optional) convenience: sent as Authorization: Bearer
 *                        unless VLLM_E2E_HEADERS already carries Authorization
 *   VLLM_E2E_MODEL       (optional) wire model id; default = first id from /v1/models
 *   VLLM_E2E_SKIP_TOOLS  (optional) set to 1 if the served model has no tool parser
 *
 * PowerShell:  $env:VLLM_E2E_SERVER_URL='...'; npm run test:e2e
 *
 * REPO LAW, NON-NEGOTIABLE: no hostname, no key, no model id from any real
 * deployment ever enters a tracked file. This source reads them from the
 * environment only. A committed URL is a leak, not a convenience.
 *
 * Kept out of `npm run build` like the rest of the rail: local hunter, not a
 * per-commit gate. A test that is red because someone's GPU box is down
 * teaches nobody anything.
 */
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const VENDOR = 'vllm-copilot';
const SERVER_ID = 'e2e-live';
const MODEL_CFG_ID = 'e2e-live-model';

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

/** Poll the vendor query until the live model appears (activation + real discovery). */
async function resolveModel(): Promise<vscode.LanguageModelChat> {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const models = await vscode.lm.selectChatModels({ vendor: VENDOR });
    const mine = models.find(m => m.id === MODEL_CFG_ID);
    if (mine) return mine;
    if (Date.now() > deadline) {
      assert.fail(`live model "${MODEL_CFG_ID}" never appeared for vendor "${VENDOR}" within 120s`);
    }
    await sleep(2000);
  }
}

async function drain(response: vscode.LanguageModelChatResponse): Promise<{ texts: string[]; toolCalls: vscode.LanguageModelToolCallPart[] }> {
  const texts: string[] = [];
  const toolCalls: vscode.LanguageModelToolCallPart[] = [];
  for await (const part of response.stream) {
    if (part instanceof vscode.LanguageModelTextPart) texts.push(part.value);
    else if (part instanceof vscode.LanguageModelToolCallPart) toolCalls.push(part);
  }
  return { texts, toolCalls };
}

describe('live-backend smoke: real vLLM server (env-gated)', function () {
  const serverUrl = process.env.VLLM_E2E_SERVER_URL;
  const apiKey = process.env.VLLM_E2E_API_KEY;
  const skipTools = process.env.VLLM_E2E_SKIP_TOOLS === '1';
  let wireModel = '';

  // Real inference on real hardware: generous, but every scenario is a single
  // short turn, so a green pass still fits in a coffee break.
  this.timeout(240_000);

  before(async function () {
    if (!serverUrl) this.skip();
    // Resolve the wire model id BEFORE seeding settings: the config entry needs
    // it, and a live /v1/models is the honest source when the env var is absent.
    // Headers arrive as the registry-shaped JSON blob (the runner reads them
    // from the user's own settings at runtime); the bare-key var is a fallback.
    const headers: Record<string, string> = process.env.VLLM_E2E_HEADERS
      ? (JSON.parse(process.env.VLLM_E2E_HEADERS) as Record<string, string>)
      : {};
    if (apiKey && !headers.Authorization) headers.Authorization = `Bearer ${apiKey}`;
    let listed: string[] = [];
    try {
      const res = await fetch(new URL('/v1/models', serverUrl), { headers });
      assert.ok(res.ok, `/v1/models answered HTTP ${res.status} — is the configured server up?`);
      const body = (await res.json()) as { data?: { id: string }[] };
      listed = (body.data ?? []).map(m => m.id);
    } catch (err) {
      assert.fail(`live smoke cannot reach /v1/models at the configured server: ${String(err)}`);
    }
    wireModel = process.env.VLLM_E2E_MODEL ?? listed[0] ?? '';
    assert.ok(wireModel, 'no model id: server listed none and VLLM_E2E_MODEL is unset');

    const cfg = vscode.workspace.getConfiguration('vllm-copilot');
    await cfg.update(
      'servers',
      [{ id: SERVER_ID, serverUrl, serverType: 'vllm', requestHeaders: headers }],
      vscode.ConfigurationTarget.Global
    );
    await cfg.update(
      'models',
      [{ id: MODEL_CFG_ID, vllmModelId: wireModel, server: SERVER_ID }],
      vscode.ConfigurationTarget.Global
    );
  });

  it('discovers from the live server and publishes the model', async () => {
    const model = await resolveModel();
    assert.equal(model.vendor, VENDOR);
    assert.ok(model.name && model.name.length > 0, 'picker name must survive real discovery');
  });

  it('real text turn streams non-empty parts and completes', async () => {
    const model = await resolveModel();
    const cts = new vscode.CancellationTokenSource();
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User('Reply with exactly: E2E-OK')],
      {},
      cts.token
    );
    const { texts } = await drain(response);
    cts.dispose();
    const joined = texts.join('');
    assert.ok(joined.trim().length > 0, 'real server must stream non-empty text');
    // Not every model obeys "exactly", so the strong claim is: the answer
    // arrived complete (no mid-stream truncation of a five-word reply).
    assert.match(joined, /E2E-?OK/i, `model answer should contain its mark, got: ${joined.slice(0, 200)}`);
  });

  it('real tool turn: a tool call survives the live SSE path intact', async function () {
    if (skipTools) this.skip();
    const model = await resolveModel();
    const cts = new vscode.CancellationTokenSource();
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User('You must call the get_weather tool for Paris right now. Do not answer in prose.')],
      { tools: [WEATHER_TOOL] },
      cts.token
    );
    const { toolCalls } = await drain(response);
    cts.dispose();
    assert.ok(toolCalls.length >= 1, 'tool-capable server must emit at least one tool call for a forced request');
    for (const call of toolCalls) {
      assert.ok(call.name && call.name.length > 0, 'streamed tool call name must be non-empty');
      assert.equal(typeof call.input, 'object', 'assembled tool input must parse to an object');
    }
  });

  it('real cancellation stops promptly mid-stream', async () => {
    const model = await resolveModel();
    const cts = new vscode.CancellationTokenSource();
    const started = Date.now();
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User('Write a very detailed 2000 word essay about the history of concrete.')],
      {},
      cts.token
    );
    // Cancel after the first streamed part: by definition mid-flight, on a
    // generation that cannot possibly have finished yet.
    const it = response.stream[Symbol.asyncIterator]();
    const first = await it.next();
    void first;
    const cancelTimer = setTimeout(() => cts.cancel(), 1000);
    const settleStart = Date.now();
    let streamError: unknown;
    try {
      for await (const _part of response.stream) void _part;
    } catch (err) {
      streamError = err;
    }
    clearTimeout(cancelTimer);
    cts.dispose();

    const settleMs = Date.now() - settleStart;
    assert.ok(settleMs < 30_000, `stream must stop after cancel, took ${settleMs}ms after cancel`);
    if (streamError) {
      const msg = String(streamError);
      assert.ok(/cancel/i.test(msg), `unexpected non-cancellation error after user cancel: ${msg}`);
    }
    assert.ok(Date.now() - started < 240_000, 'wall clock sanity');
  });
});
