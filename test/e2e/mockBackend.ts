/**
 * Loopback mock vLLM backend for the extension-host E2E spike (Spike A).
 *
 * Runs IN the extension-host test process — the same process the extension's
 * fetch() talks to — so the request journal is plain in-object state, no
 * cross-process plumbing. Same response-queue discipline as the packed-core
 * proof (scripts/core-proof.mjs): a request arriving with an empty queue is
 * an unexplained retry or re-ask and fails the test loudly, not silently.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ResponseSpec {
  /** HTTP status for a non-SSE reply (error-path tests). */
  status?: number;
  /** JSON body paired with `status`. */
  json?: unknown;
  /** Complete SSE payload, terminated by the caller with [DONE]. */
  sse?: string;
  /**
   * Keep the response open after the first chunk: the cancellation scenario's
   * stream never ends on its own, only when the client tears the connection down.
   */
  slow?: boolean;
}

export interface MockBackend {
  /** Base URL (http://127.0.0.1:<port>) to seed into vllm-copilot.servers. */
  base: string;
  /** Parsed JSON bodies of every POST /v1/chat/completions received, in order. */
  requests: Record<string, unknown>[];
  /** Responses served for chat completions, in order; empty queue is a failure. */
  queue: ResponseSpec[];
  /** Chat responses still open (slow specs): .closed flips when the client aborts. */
  open: { closed: boolean; destroy(): void }[];
  close(): Promise<void>;
}

const MODEL_ID = 'mock/e2e-model';
const CONTEXT_WINDOW = 32768;

export async function startMockBackend(): Promise<MockBackend> {
  const backend: MockBackend = {
    base: '',
    requests: [],
    queue: [],
    open: [],
    close: async () => {},
  };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url || '').startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ object: 'model', id: MODEL_ID, root: MODEL_ID, max_model_len: CONTEXT_WINDOW }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c; });
      req.on('end', () => {
        backend.requests.push(JSON.parse(raw));
        const spec = backend.queue.shift();
        if (!spec) {
          // An unexplained request (extra retry, re-ask, double-fire): answer 500
          // so the test path fails visibly instead of hanging on a missing reply.
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'mock backend: unexpected request beyond the queued specs' } }));
          return;
        }
        if (spec.status) {
          res.writeHead(spec.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(spec.json));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (spec.slow) {
          const entry = { closed: false, destroy: () => res.destroy() };
          backend.open.push(entry);
          // res.close is the connection-teardown signal — req.close fires BEFORE
          // a client abort (probed 2026-10-04 in core-proof) and would lie.
          res.on('close', () => { entry.closed = true; });
          res.write(`data: ${JSON.stringify(chunk({ content: 'partial answer that never finishes' }))}\n\n`);
          return;
        }
        res.end(spec.sse ?? '');
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  backend.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  backend.close = async () => {
    // destroy still-open slow responses so server.close() can finish
    for (const entry of backend.open) entry.destroy();
    await new Promise<void>(done => server.close(() => done()));
  };
  return backend;
}

/** One OpenAI-compatible SSE chunk. */
export function chunk(delta: unknown, finish: string | null = null, usage?: unknown): string {
  const c: Record<string, unknown> = {
    id: 'cmpl-e2e',
    object: 'chat.completion.chunk',
    created: 1,
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  if (usage) {
    c.choices = [];
    c.usage = usage;
  }
  return `data: ${JSON.stringify(c)}\n\n`;
}

/** Close the SSE stream with the usage chunk (choices empty, as vLLM sends) and [DONE]. */
export function finishWithUsage(prompt: number, completion: number): string {
  return chunk({}, 'stop', {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  }) + 'data: [DONE]\n\n';
}

export function doneChunk(): string {
  return 'data: [DONE]\n\n';
}
