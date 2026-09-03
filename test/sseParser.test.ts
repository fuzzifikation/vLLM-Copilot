import { describe, it, expect, beforeEach } from 'vitest';
import { processSSEChunk, finalizePendingToolCalls } from '../src/provider/sseParser.js';
import type { PendingToolCall } from '../src/provider/sseParser.js';

function makeChunk(payload: object): string {
  return JSON.stringify(payload);
}

describe('finalizePendingToolCalls', () => {
  it('finalizes a single complete tool call', () => {
    const map = new Map<number, PendingToolCall>([
      [0, { id: 'call_1', name: 'readFile', args: '{"path":"/foo"}' }],
    ]);
    const result = finalizePendingToolCalls(map);
    expect(result).toEqual([{ id: 'call_1', name: 'readFile', arguments: '{"path":"/foo"}' }]);
    expect(map.size).toBe(0); // cleared
  });

  it('skips entries without a name (incomplete deltas)', () => {
    const map = new Map<number, PendingToolCall>([
      [0, { id: 'call_1', name: '', args: '' }],
      [1, { id: 'call_2', name: 'runCommand', args: '{}' }],
    ]);
    const result = finalizePendingToolCalls(map);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('runCommand');
  });

  it('uses {} as default args when args are empty', () => {
    const map = new Map<number, PendingToolCall>([
      [0, { id: 'call_1', name: 'noArgs', args: '' }],
    ]);
    const result = finalizePendingToolCalls(map);
    expect(result[0].arguments).toBe('{}');
  });
});

describe('processSSEChunk', () => {
  let pending: Map<number, PendingToolCall>;

  beforeEach(() => {
    pending = new Map();
  });

  it('returns null for malformed JSON', () => {
    expect(processSSEChunk('not json', pending)).toBeNull();
  });

  it('returns null for empty choices with no usage', () => {
    const data = makeChunk({ choices: [] });
    expect(processSSEChunk(data, pending)).toBeNull();
  });

  it('returns usage-only event when choices are empty but usage present', () => {
    const data = makeChunk({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const event = processSSEChunk(data, pending);
    expect(event).not.toBeNull();
    expect(event!.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    expect(event!.content).toBe('');
    expect(event!.finishedToolCalls).toHaveLength(0);
  });

  it('extracts text content from delta format', () => {
    const data = makeChunk({
      choices: [{ delta: { content: 'Hello world' }, finish_reason: null }],
    });
    const event = processSSEChunk(data, pending)!;
    expect(event.content).toBe('Hello world');
    expect(event.finishedToolCalls).toHaveLength(0);
  });

  it('extracts reasoning_content from delta', () => {
    const data = makeChunk({
      choices: [{ delta: { reasoning: 'let me think...' }, finish_reason: null }],
    });
    const event = processSSEChunk(data, pending)!;
    expect(event.reasoning_content).toBe('let me think...');
  });

  it('extracts reasoning_content from delta.reasoning_content (llama.cpp / LM Studio)', () => {
    const data = makeChunk({
      choices: [{ delta: { reasoning_content: 'thinking...' }, finish_reason: null }],
    });
    const event = processSSEChunk(data, pending)!;
    expect(event.reasoning_content).toBe('thinking...');
  });

  it('accumulates tool call args across multiple chunks', () => {
    // Chunk 1: name arrives
    const chunk1 = makeChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'readFile', arguments: '' } }] }, finish_reason: null }],
    });
    processSSEChunk(chunk1, pending);
    expect(pending.get(0)?.name).toBe('readFile');
    expect(pending.get(0)?.args).toBe('');

    // Chunk 2: args start
    const chunk2 = makeChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] }, finish_reason: null }],
    });
    processSSEChunk(chunk2, pending);
    expect(pending.get(0)?.args).toBe('{"path"');

    // Chunk 3: args continue
    const chunk3 = makeChunk({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"/foo"}' } }] }, finish_reason: null }],
    });
    processSSEChunk(chunk3, pending);
    expect(pending.get(0)?.args).toBe('{"path":"/foo"}');

    // Chunk 4: finish_reason finalizes
    const chunk4 = makeChunk({
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    });
    const event = processSSEChunk(chunk4, pending)!;
    expect(event.finishedToolCalls).toHaveLength(1);
    expect(event.finishedToolCalls[0]).toEqual({ id: 'call_abc', name: 'readFile', arguments: '{"path":"/foo"}' });
    expect(pending.size).toBe(0); // cleared after finalization
  });

  it('handles parallel tool calls (two indexes)', () => {
    // Both arrive in same delta chunk
    const chunk1 = makeChunk({
      choices: [{
        delta: {
          tool_calls: [
            { index: 0, id: 'call_0', type: 'function', function: { name: 'readFile', arguments: '{"path":"a"}' } },
            { index: 1, id: 'call_1', type: 'function', function: { name: 'writeFile', arguments: '{"path":"b"}' } },
          ]
        },
        finish_reason: null,
      }],
    });
    processSSEChunk(chunk1, pending);
    expect(pending.size).toBe(2);

    const chunk2 = makeChunk({
      choices: [{ delta: {}, finish_reason: 'tool_calls' }],
    });
    const event = processSSEChunk(chunk2, pending)!;
    expect(event.finishedToolCalls).toHaveLength(2);
    expect(event.finishedToolCalls.map(t => t.name)).toContain('readFile');
    expect(event.finishedToolCalls.map(t => t.name)).toContain('writeFile');
  });

  it('attaches usage when present on a content chunk', () => {
    const data = makeChunk({
      choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 },
    });
    const event = processSSEChunk(data, pending)!;
    expect(event.content).toBe('hi');
    expect(event.usage?.prompt_tokens).toBe(20);
  });

  it('maps OpenRouter is_byok to usedByok on the wire usage (raw name stripped)', () => {
    const data = makeChunk({
      choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23, cost: 0.0012, is_byok: true },
    });
    const event = processSSEChunk(data, pending)!;
    expect(event.usage?.usedByok).toBe(true);
    expect(event.usage?.cost).toBe(0.0012);
    // The raw wire name must not survive — the file logger stringifies usage,
    // and the whole point of the rename was to keep ONE name in the pipeline.
    expect('is_byok' in (event.usage ?? {})).toBe(false);
  });

  it('maps is_byok: false to usedByok: false (not a real flag)', () => {
    const data = makeChunk({
      choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23, is_byok: false },
    });
    const event = processSSEChunk(data, pending)!;
    expect(event.usage?.usedByok).toBe(false);
    expect('is_byok' in (event.usage ?? {})).toBe(false);
  });

  it('leaves usedByok undefined when the server reports no is_byok', () => {
    const data = makeChunk({
      choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 },
    });
    const event = processSSEChunk(data, pending)!;
    expect(event.usage?.usedByok).toBeUndefined();
  });

  it('surfaces a server error chunk instead of dropping it', () => {
    const data = makeChunk({ error: { message: 'This model maximum context length is 4096 tokens' } });
    const event = processSSEChunk(data, pending)!;
    expect(event).not.toBeNull();
    expect(event.error).toBe('This model maximum context length is 4096 tokens');
  });

  it('recovers the real reason from an OpenRouter error.metadata.raw envelope', () => {
    const data = makeChunk({
      error: {
        message: 'Provider returned error',
        metadata: { raw: 'This model is temporarily unavailable from the selected provider.' },
      },
    });
    const event = processSSEChunk(data, pending)!;
    expect(event).not.toBeNull();
    expect(event.error).toContain('This model is temporarily unavailable');
  });

  it('surfaces a string-form server error chunk', () => {
    const data = makeChunk({ error: 'internal server error' });
    const event = processSSEChunk(data, pending)!;
    expect(event.error).toBe('internal server error');
  });

  it('captures content_filter finish_reason', () => {
    const data = makeChunk({
      choices: [{ delta: {}, finish_reason: 'content_filter' }],
    });
    const event = processSSEChunk(data, pending)!;
    expect(event.finishReason).toBe('content_filter');
    expect(event.finishedToolCalls).toHaveLength(0);
  });
});
