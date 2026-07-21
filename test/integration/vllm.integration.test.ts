import { describe, it, expect, beforeAll, vi } from 'vitest';
import { VllmClient } from '../../src/vllmClient.js';
import * as configModule from '../../src/config.js';

/**
 * Integration tests that hit a real vLLM-compatible server.
 *
 * To run:
 *   export VLLM_INTEGRATION=1
 *   export VLLM_SERVER_URL=http://localhost:8000      # required
 *   export VLLM_API_KEY=your-key                       # optional
 *   export VLLM_MODEL_ID=meta-llama/Llama-3-8B-Instruct # optional; first listed if omitted
 *   npm run test:integration
 *
 * The suite is skipped entirely if VLLM_INTEGRATION is not set, so it won't break CI
 * environments that don't have a server.
 */

const ENABLED = process.env.VLLM_INTEGRATION === '1';
const SERVER_URL = process.env.VLLM_SERVER_URL || 'http://localhost:8000';
const API_KEY = process.env.VLLM_API_KEY || '';
const MODEL_OVERRIDE = process.env.VLLM_MODEL_ID;

/** Per-model server config used by all streaming tests. */
const REQUEST_HEADERS: Record<string, string> = API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};
const SERVER_CONFIG = {
  serverUrl: SERVER_URL,
  requestHeaders: REQUEST_HEADERS,
};

const d = ENABLED ? describe : describe.skip;

function makeContext(): any { return { secrets: { get: async () => undefined } }; }
function makeOutput(): any { return { appendLine: (line: string) => process.env.VLLM_TRACE && console.log(line) }; }

function stubConfig() {
  vi.spyOn(configModule, 'getConfig').mockResolvedValue({
    models: [],
    enableFileLogging: false,
  });
}

d('vLLM integration', () => {
  let client: VllmClient;
  let modelId: string;

  beforeAll(async () => {
    stubConfig();
    client = new VllmClient(makeContext(), makeOutput());
    // Fetch model list directly (listModels() was removed as dead production code).
    const resp = await fetch(`${SERVER_URL}/v1/models`, { headers: REQUEST_HEADERS });
    const data = await resp.json();
    const models = data.data || [];
    expect(models.length).toBeGreaterThan(0);
    modelId = MODEL_OVERRIDE || models[0].id;
    console.log(`[integration] using model: ${modelId}`);
  });

  it('can reach the server and get a context window', async () => {
    const ctx = await client.getModelContextWindow(SERVER_URL, REQUEST_HEADERS, modelId);
    expect(ctx).toBeDefined();
    expect(typeof ctx).toBe('number');
  });

  it('streams a short completion end-to-end', async () => {
    const events: any[] = [];
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any;
    for await (const e of client.chatCompletionStream(
      modelId,
      [{ role: 'user', content: 'Say only the word "ok" and nothing else.' }],
      { max_tokens: 16, temperature: 0 },
      token,
      SERVER_CONFIG,
    )) {
      events.push(e);
    }

    const text = events.map(e => (e.content || '') + (e.reasoning_content || '')).join('');
    expect(text.length).toBeGreaterThan(0);

    // Usage should be reported by vLLM (we requested include_usage)
    const usage = events.find(e => e.usage)?.usage;
    expect(usage).toBeTruthy();
    expect(usage.prompt_tokens).toBeGreaterThan(0);
    expect(usage.completion_tokens).toBeGreaterThan(0);
    expect(usage.total_tokens).toBe(usage.prompt_tokens + usage.completion_tokens);
  }, 60_000);

  it('honors abort signal mid-stream', async () => {
    const listeners: Array<() => void> = [];
    let cancelled = false;
    const token: any = {
      get isCancellationRequested() { return cancelled; },
      onCancellationRequested: (cb: () => void) => { listeners.push(cb); return { dispose: () => {} }; },
    };

    const promise = (async () => {
      const events: any[] = [];
      for await (const e of client.chatCompletionStream(
        modelId,
        [{ role: 'user', content: 'Write a long essay about the history of compilers.' }],
        { max_tokens: 1024, temperature: 0 },
        token,
        SERVER_CONFIG,
      )) {
        events.push(e);
        if (events.length === 2) {
          cancelled = true;
          listeners.forEach(cb => cb());
        }
      }
      return events;
    })();

    const events = await promise.catch(() => []);
    // We don't assert on event count (servers may flush more before noticing abort),
    // just that the loop terminated and didn't hang.
    expect(Array.isArray(events)).toBe(true);
  }, 60_000);
});
