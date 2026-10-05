import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { consumeStream } from '../src/vscode/copilot/consumeStream.js';
import {
  createExecutionState,
  executeChatRequest,
  type ExecutionInput,
  type ExecutionState,
} from '../src/core/request/execute.js';
import { getLastRequest } from '../src/vscode/state/usageStore.js';
import type { StreamEvent } from '../src/core/types.js';

/**
 * Pipeline tests for the Phase 6 split: the neutral execution core
 * (`executeChatRequest`) observes and the Copilot consumer (`consumeStream`)
 * reports/records. The auto-continue tests run the full provider path; these
 * pin the part-reporting + observation + recording contract end to end over a
 * fake transport, with the retry budget pinned to zero (one attempt).
 */

function ev(p: Partial<StreamEvent>): StreamEvent {
  return { content: '', finishedToolCalls: [], ...p } as StreamEvent;
}
function setup() {
  const progress = { report: vi.fn() };
  const output = { appendLine: vi.fn() } as any;
  return { progress, output };
}
const model = { id: 'm', maxInputTokens: 1000, maxOutputTokens: 100 } as any;
const serverConfig = { serverUrl: 'http://host', serverType: 'vllm', requestHeaders: {} } as any;

/**
 * Run one request through executor + consumer. `feed` receives the abort
 * signal so cancellation tests can abort mid-stream; the default transport
 * yields every event regardless (the executor's per-event abort check is
 * what drops them, as in production).
 */
async function run(
  events: StreamEvent[],
  progress: any,
  output: any,
  state: ExecutionState,
  feed: (signal: AbortSignal) => StreamEvent[] = () => events,
  inputOver: Partial<ExecutionInput> = {},
): Promise<void> {
  const transport = {
    chatCompletionStream: async function* (_m: string, _msgs: any, _opts: any, signal: AbortSignal) {
      for (const e of feed(signal)) yield e;
    },
  };
  const input: ExecutionInput = {
    transport,
    modelId: 'm',
    vllmModelId: 'm',
    openaiMessages: [],
    mergedOptions: {},
    serverConfig,
    maxRetries: 0,
    signal: new AbortController().signal,
    log: output,
    limits: { wireModelId: 'm', maxInputTokens: 1000, maxOutputTokens: 100 },
    ...inputOver,
  };
  await consumeStream(executeChatRequest(input, state), model, progress, state.outcome, output);
}

describe('consumeStream', () => {
  it('reports text, accumulates the buffer, records firstTokenTime and finishReason', async () => {
    const { progress, output } = setup();
    const state = createExecutionState(Date.now());

    await run([ev({ content: 'Hello ' }), ev({ content: 'world', finishReason: 'stop' })], progress, output, state);

    expect(progress.report).toHaveBeenCalledWith(new vscode.LanguageModelTextPart('Hello '));
    expect(progress.report).toHaveBeenCalledWith(new vscode.LanguageModelTextPart('world'));
    expect(state.outcome.hadContent).toBe(true);
    expect(state.outcome.contentBuffer).toBe('Hello world');
    expect(state.outcome.finishReason).toBe('stop');
    expect(state.outcome.firstTokenTime).toBeDefined();
  });

  it('reports reasoning/thinking parts and flags hadReasoning', async () => {
    const { progress, output } = setup();
    const state = createExecutionState(Date.now());

    await run([ev({ reasoning_content: 'thinking...' }), ev({ content: 'answer' })], progress, output, state);

    expect(progress.report).toHaveBeenCalledWith(new vscode.LanguageModelThinkingPart('thinking...'));
    expect(state.outcome.hadReasoning).toBe(true);
    expect(state.outcome.hadContent).toBe(true);
  });

  it('reports tool calls once each (dedup by id) and parses arguments', async () => {
    const { progress, output } = setup();
    const state = createExecutionState(Date.now());
    const tc = { id: 'c1', name: 'get_weather', arguments: '{"city":"Berlin"}' } as any;

    await run([ev({ finishedToolCalls: [tc] }), ev({ finishedToolCalls: [tc] })], progress, output, state);

    expect(state.outcome.hadToolCalls).toBe(true);
    expect(progress.report).toHaveBeenCalledWith(new vscode.LanguageModelToolCallPart('c1', 'get_weather', { city: 'Berlin' }));
    const toolParts = progress.report.mock.calls.filter(c => c[0] instanceof vscode.LanguageModelToolCallPart);
    expect(toolParts).toHaveLength(1); // deduplicated by the executor
  });

  it('filters duplicate tool calls without discarding the event that carried them', async () => {
    const { progress, output } = setup();
    const state = createExecutionState(Date.now());
    const tc = { id: 'c1', name: 'f', arguments: '{}' } as any;

    await run(
      [ev({ finishedToolCalls: [tc] }), ev({ content: 'after the dup', reasoning_content: 'r', finishedToolCalls: [tc] })],
      progress, output, state,
    );

    // The baseline consumer reported per FIELD, so the executor dedups per
    // tool call: text and reasoning riding an all-duplicate tool batch must
    // still reach the user — only the duplicate call itself disappears.
    expect(progress.report).toHaveBeenCalledWith(new vscode.LanguageModelTextPart('after the dup'));
    expect(progress.report).toHaveBeenCalledWith(new vscode.LanguageModelThinkingPart('r'));
    expect(state.outcome.contentBuffer).toBe('after the dup');
    const toolParts = progress.report.mock.calls.filter(c => c[0] instanceof vscode.LanguageModelToolCallPart);
    expect(toolParts).toHaveLength(1);
  });

  it('retry prefills live on a copy — the caller message array is never mutated', async () => {
    const { progress, output } = setup();
    const state = createExecutionState(Date.now());
    const caller = [{ role: 'user' as const, content: 'hi' }];
    const bodies: any[][] = [];
    const transport = {
      chatCompletionStream: async function* (_m: string, msgs: any[], _o: any, _s: AbortSignal) {
        bodies.push(msgs.map((msg) => ({ ...msg })));
        // Attempt 1: empty stop (the nudge trigger). Attempt 2: a real answer.
        const events = bodies.length === 1 ? [ev({ finishReason: 'stop' })] : [ev({ content: 'ok', finishReason: 'stop' })];
        for (const e of events) yield e;
      },
    };
    const input: ExecutionInput = {
      transport, modelId: 'm', vllmModelId: 'm', openaiMessages: caller, mergedOptions: {},
      serverConfig, maxRetries: 1, signal: new AbortController().signal, log: output,
      limits: { wireModelId: 'm', maxInputTokens: 1000, maxOutputTokens: 100 },
    };

    await consumeStream(executeChatRequest(input, state), model, progress, state.outcome, output);

    expect(state.attemptCount).toBe(2); // the empty stop triggered the nudge
    // Plan Phase 6: caller-owned history is cloned once at entry — the second
    // attempt carries the prefill, the caller's array never sees it.
    expect(caller).toEqual([{ role: 'user', content: 'hi' }]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '' },
    ]);
  });

  it('falls back to {} and warns when tool arguments are unparseable', async () => {
    const { progress, output } = setup();
    const state = createExecutionState(Date.now());
    const tc = { id: 'c2', name: 'f', arguments: 'not json' } as any;

    await run([ev({ finishedToolCalls: [tc] })], progress, output, state);

    expect(progress.report).toHaveBeenCalledWith(new vscode.LanguageModelToolCallPart('c2', 'f', {}));
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining('args unparseable'));
  });

  it('detects raw thinking tags leaking into content', async () => {
    const { progress, output } = setup();
    const state = createExecutionState(Date.now());

    await run([ev({ content: 'before <thinking>after</thinking>' })], progress, output, state);

    expect(state.outcome.sawRawThinkTags).toBe(true);
  });

  it('reports usage once and records the last request for the dashboard', async () => {
    const { progress, output } = setup();
    const state = createExecutionState(Date.now());
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } as any;

    await run(
      [ev({ content: 'hi', usage, metrics: { generation_time_ms: 12 } })],
      progress, output, state, undefined,
      { limits: { wireModelId: 'm', contextWindow: 32768, maxInputTokens: 1000, maxOutputTokens: 100 } },
    );

    expect(progress.report).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'usage' }));
    expect(output.appendLine).toHaveBeenCalled();
    const last = getLastRequest('http://host');
    expect(last?.modelId).toBe('m');
    expect(last?.promptTokens).toBe(10);
    expect(last?.totalTokens).toBe(15);
    expect(last?.maxModelLen).toBe(32768);
    // Client-measured total time is always recorded, so the dashboard can compute
    // throughput even when the server reports no per-request metrics.
    expect(last?.totalTimeMs).toBeTypeOf('number');
  });

  it('captures OpenRouter actual cost and BYOK flag into the last request', async () => {
    const { progress, output } = setup();
    const state = createExecutionState(Date.now());
    const usage = {
      prompt_tokens: 10, completion_tokens: 5, total_tokens: 15,
      cost: 0.0012, usedByok: true,
    } as any;

    await run([ev({ content: 'hi', usage })], progress, output, state);

    const last = getLastRequest('http://host');
    expect(last?.actualCost).toBe(0.0012);
    expect(last?.usedByok).toBe(true);
  });

  it('does not invent actual cost when the server reports none', async () => {
    const { progress, output } = setup();
    const state = createExecutionState(Date.now());
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } as any;

    await run([ev({ content: 'hi', usage })], progress, output, state);

    const last = getLastRequest('http://host');
    expect(last?.actualCost).toBeUndefined();
    expect(last?.usedByok).toBeUndefined();
  });

  it('stops early when the signal is aborted before any part is reported', async () => {
    const { progress, output } = setup();
    const state = createExecutionState(Date.now());
    const controller = new AbortController();
    controller.abort('User cancelled');

    await run([ev({ content: 'hi' })], progress, output, state, undefined, {
      signal: controller.signal,
    });

    expect(progress.report).not.toHaveBeenCalled();
    expect(state.outcome.hadContent).toBe(false);
  });

  it('preserves already-reported output when cancellation arrives mid-stream', async () => {
    const { progress, output } = setup();
    const state = createExecutionState(Date.now());
    // The signal aborts after the FIRST event was yielded: the executor checks
    // per event, so the first part was already reported and the second must be
    // dropped. Partial output must not be lost on cancellation.
    const controller = new AbortController();
    const transport = {
      chatCompletionStream: async function* () {
        yield ev({ content: 'first ' });
        controller.abort('User cancelled');
        yield ev({ content: 'second' });
      },
    };
    const input: ExecutionInput = {
      transport, modelId: 'm', vllmModelId: 'm', openaiMessages: [], mergedOptions: {},
      serverConfig, maxRetries: 0, signal: controller.signal, log: output,
      limits: { wireModelId: 'm', maxInputTokens: 1000, maxOutputTokens: 100 },
    };

    await consumeStream(executeChatRequest(input, state), model, progress, state.outcome, output);

    expect(progress.report).toHaveBeenCalledWith(new vscode.LanguageModelTextPart('first '));
    expect(progress.report).not.toHaveBeenCalledWith(new vscode.LanguageModelTextPart('second'));
    expect(state.outcome.hadContent).toBe(true);
    expect(state.outcome.contentBuffer).toBe('first ');
  });
});
