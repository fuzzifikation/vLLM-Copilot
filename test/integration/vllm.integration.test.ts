import { describe, it, expect, beforeAll, vi } from 'vitest';
import { VllmClient } from '../../src/provider/vllmClient.js';
import * as configModule from '../../src/state/config.js';

/**
 * Integration tests that hit a real vLLM-compatible server.
 *
 * To run (any OS — the flag is set by the vitest mode, no shell env-prefix needed):
 *   npm run test:integration
 *
 * Environment knobs (all optional):
 *   VLLM_SERVER_URL  default http://localhost:8000
 *   VLLM_API_KEY     sent as Authorization: Bearer when set
 *   VLLM_MODEL_ID    default: first model the server lists
 *
 * Skipped unless the integration mode sets VLLM_INTEGRATION=1 (vitest.config.ts),
 * so `npm test` never dials a server.
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
  streamInactivityTimeout: 60000,
  initialResponseTimeoutMs: 60000,
  serverType: 'vllm' as const,
};

const d = ENABLED ? describe : describe.skip;

function makeContext(): any { return { secrets: { get: async () => undefined } }; }
function makeOutput(): any { return { appendLine: (line: string) => process.env.VLLM_TRACE && console.log(line) }; }

function stubConfig() {
  vi.spyOn(configModule, 'getConfig').mockResolvedValue({
    models: [],
    servers: [],
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
    const data = (await resp.json()) as { data?: Array<{ id: string }> };
    const models = data.data || [];
    expect(models.length).toBeGreaterThan(0);
    modelId = MODEL_OVERRIDE || models[0].id;
    console.log(`[integration] using model: ${modelId}`);
  });

  it('can reach the server and get a context window', async () => {
    const limits = await client.getModelContextWindow('vllm', SERVER_URL, REQUEST_HEADERS, modelId);
    expect(limits.contextWindow).toBeDefined();
    expect(typeof limits.contextWindow).toBe('number');
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
    // Two guarantees, both falsifiable: the loop TERMINATED (no hang — the
    // await itself would time out otherwise) and cancellation actually cut
    // generation short. A server ignoring the abort would stream the full
    // 1024-token essay as hundreds of delta events; honoring it stops within a
    // few chunks of the cancel (CR-105: the old `Array.isArray` assertion was
    // true either way and could not fail).
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeLessThan(100);
  }, 60_000);
});
