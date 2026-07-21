import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { VllmClient } from '../src/vllmClient.js';
import * as configModule from '../src/config.js';

function makeContext(): any { return { secrets: { get: async () => undefined } }; }
function makeOutput(): any { return { appendLine: () => {} }; }

function stubConfig() {
  vi.spyOn(configModule, 'getConfig').mockResolvedValue({
    serverUrl: 'http://test', apiKey: '',
    models: [], temperature: 0, topP: 1, topK: -1, minP: 0,
    repetitionPenalty: 1, maxOutputTokens: 100, presencePenalty: 0, frequencyPenalty: 0,
    seed: -1, stopSequences: [], minOutputTokens: 0,
    requestHeaders: {}, enableFileLogging: false, estimateCharsPerToken: 3.5,
    streamInactivityTimeout: 0, autoContinueRetries: 1,
    badWords: [],
    ignoreEos: false,
    repetitionDetection: null,
    structuredOutput: null,
  } as any);
}

/** Build a Response with an SSE body composed of the given lines (one per `data:` line). */
function sseResponse(lines: string[]): Response {
  const body = lines.map(l => `data: ${l}\n`).join('') + '\n';
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Same as above but emits each line in a separate chunk to exercise the line buffer. */
function sseResponseChunked(lines: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) {
        controller.enqueue(new TextEncoder().encode(`data: ${l}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('VllmClient.chatCompletionStream', () => {
  beforeEach(() => stubConfig());
  afterEach(() => vi.restoreAllMocks());

  it('yields text content from a basic streamed response', async () => {
    const lines = [
      JSON.stringify({ choices: [{ delta: { content: 'Hello' }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: { content: ' world' }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      '[DONE]',
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(lines));

    const client = new VllmClient(makeContext(), makeOutput());
    const events: any[] = [];
    for await (const e of client.chatCompletionStream('m', [], {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any)) {
      events.push(e);
    }

    const text = events.map(e => e.content).join('');
    expect(text).toBe('Hello world');
    expect(events.some(e => e.finishReason === 'stop')).toBe(true);
  });

  it('accumulates tool call arguments across multiple chunks', async () => {
    const lines = [
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'readFile', arguments: '' } }] }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"/foo"}' } }] }, finish_reason: null }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }),
      '[DONE]',
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(lines));

    const client = new VllmClient(makeContext(), makeOutput());
    const events: any[] = [];
    for await (const e of client.chatCompletionStream('m', [], {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any)) {
      events.push(e);
    }

    const finished = events.flatMap(e => e.finishedToolCalls);
    expect(finished).toHaveLength(1);
    expect(finished[0].name).toBe('readFile');
    expect(finished[0].arguments).toBe('{"path":"/foo"}');
  });

  it('survives chunk boundaries that split lines (line buffer)', async () => {
    // Emit lines in separate fetch chunks to ensure the internal newline buffer works.
    const lines = [
      JSON.stringify({ choices: [{ delta: { content: 'A' } }] }),
      JSON.stringify({ choices: [{ delta: { content: 'B' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      '[DONE]',
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponseChunked(lines));

    const client = new VllmClient(makeContext(), makeOutput());
    let text = '';
    for await (const e of client.chatCompletionStream('m', [], {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any)) {
      text += e.content;
    }
    expect(text).toBe('AB');
  });

  it('processes a final line that lacks a trailing newline (buffer flush)', async () => {
    // Stream ends right after a complete data line with no trailing "\n" and no [DONE].
    const body =
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi' }, finish_reason: null }] })}\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: '!' }, finish_reason: 'stop' }] })}`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });
    const response = new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

    const client = new VllmClient(makeContext(), makeOutput());
    let text = '';
    let finish: string | undefined;
    for await (const e of client.chatCompletionStream('m', [], {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any)) {
      text += e.content;
      if (e.finishReason) finish = e.finishReason;
    }
    expect(text).toBe('Hi!');
    expect(finish).toBe('stop');
  });

  it('emits a final usage event when the server sends usage as the last chunk', async () => {
    const lines = [
      JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }),
      '[DONE]',
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(lines));

    const client = new VllmClient(makeContext(), makeOutput());
    const usages: any[] = [];
    for await (const e of client.chatCompletionStream('m', [], {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any)) {
      if (e.usage) usages.push(e.usage);
    }
    expect(usages).toHaveLength(1);
    expect(usages[0]).toEqual({ prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 });
  });

  it('skips malformed SSE lines without aborting the stream', async () => {
    const lines = [
      'not json',
      JSON.stringify({ choices: [{ delta: { content: 'ok' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      '[DONE]',
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(lines));

    const client = new VllmClient(makeContext(), makeOutput());
    let text = '';
    for await (const e of client.chatCompletionStream('m', [], {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any)) {
      text += e.content;
    }
    expect(text).toBe('ok');
  });

  it('throws when the server sends an error chunk mid-stream', async () => {
    const lines = [
      JSON.stringify({ choices: [{ delta: { content: 'partial' } }] }),
      JSON.stringify({ error: { message: 'context length exceeded' } }),
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(lines));

    const client = new VllmClient(makeContext(), makeOutput());
    const run = async () => {
      for await (const _e of client.chatCompletionStream('m', [], {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any)) {
        // drain
      }
    };
    await expect(run()).rejects.toThrow(/context length exceeded/);
  });

  it('surfaces ERR_STREAM_PREMATURE_CLOSE as a targeted message (not a generic stream error)', async () => {
    // Simulate a reverse proxy / network drop mid-stream: the ReadableStream
    // errors with code ERR_STREAM_PREMATURE_CLOSE after emitting one chunk.
    // The user should see "prematurely" in the message so formatError maps it
    // to the actionable explanation. This verifies streamReader's detection
    // (code OR message match) and that we don't wrap it into a generic dump.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n`));
        // Emulate undici's ERR_STREAM_PREMATURE_CLOSE rejection from reader.read()
        queueMicrotask(() => controller.error(Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })));
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    );

    const client = new VllmClient(makeContext(), makeOutput());
    let caught: unknown;
    try {
      for await (const _e of client.chatCompletionStream('m', [], {}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) } as any)) {
        // drain
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toMatch(/prematurely/i);
  });
});

