import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { consumeStream } from '../src/provider/consumeStream.js';
import { createOutcome } from '../src/provider/outcome.js';
import { getLastRequest } from '../src/usageStore.js';
import type { StreamEvent } from '../src/types.js';

/**
 * Direct tests for the extracted stream consumer (`consumeStream.ts`).
 * The auto-continue tests run it through the real provider path; these pin the
 * part-reporting contract (text, reasoning, tool calls, usage, cancellation).
 */

async function* streamOf(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}
function ev(p: Partial<StreamEvent>): StreamEvent {
  return { content: '', finishedToolCalls: [], ...p } as StreamEvent;
}
function setup() {
  const progress = { report: vi.fn() };
  const output = { appendLine: vi.fn() } as any;
  return { progress, output };
}
const model = { id: 'm', maxInputTokens: 1000, maxOutputTokens: 100 } as any;
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as any;
const startTime = Date.now();

describe('consumeStream', () => {
  it('reports text, accumulates the buffer, records firstTokenTime and finishReason', async () => {
    const { progress, output } = setup();
    const outcome = createOutcome();

    await consumeStream(
      streamOf([ev({ content: 'Hello ' }), ev({ content: 'world', finishReason: 'stop' })]),
      model, progress, token, startTime, outcome, 'http://host', 'm', output,
    );

    expect(progress.report).toHaveBeenCalledWith(new vscode.LanguageModelTextPart('Hello '));
    expect(progress.report).toHaveBeenCalledWith(new vscode.LanguageModelTextPart('world'));
    expect(outcome.hadContent).toBe(true);
    expect(outcome.contentBuffer).toBe('Hello world');
    expect(outcome.finishReason).toBe('stop');
    expect(outcome.firstTokenTime).toBeDefined();
  });

  it('reports reasoning/thinking parts and flags hadReasoning', async () => {
    const { progress, output } = setup();
    const outcome = createOutcome();

    await consumeStream(
      streamOf([ev({ reasoning_content: 'thinking...' }), ev({ content: 'answer' })]),
      model, progress, token, startTime, outcome, 'http://host', 'm', output,
    );

    expect(progress.report).toHaveBeenCalledWith(new vscode.LanguageModelThinkingPart('thinking...'));
    expect(outcome.hadReasoning).toBe(true);
    expect(outcome.hadContent).toBe(true);
  });

  it('reports tool calls once each (dedup by id) and parses arguments', async () => {
    const { progress, output } = setup();
    const outcome = createOutcome();
    const tc = { id: 'c1', name: 'get_weather', arguments: '{"city":"Berlin"}' } as any;

    await consumeStream(
      streamOf([ev({ finishedToolCalls: [tc] }), ev({ finishedToolCalls: [tc] })]),
      model, progress, token, startTime, outcome, 'http://host', 'm', output,
    );

    expect(outcome.hadToolCalls).toBe(true);
    expect(progress.report).toHaveBeenCalledWith(new vscode.LanguageModelToolCallPart('c1', 'get_weather', { city: 'Berlin' }));
    const toolParts = progress.report.mock.calls.filter(c => c[0] instanceof vscode.LanguageModelToolCallPart);
    expect(toolParts).toHaveLength(1); // deduplicated
  });

  it('falls back to {} and warns when tool arguments are unparseable', async () => {
    const { progress, output } = setup();
    const outcome = createOutcome();
    const tc = { id: 'c2', name: 'f', arguments: 'not json' } as any;

    await consumeStream(
      streamOf([ev({ finishedToolCalls: [tc] })]),
      model, progress, token, startTime, outcome, 'http://host', 'm', output,
    );

    expect(progress.report).toHaveBeenCalledWith(new vscode.LanguageModelToolCallPart('c2', 'f', {}));
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining('args unparseable'));
  });

  it('detects raw thinking tags leaking into content', async () => {
    const { progress, output } = setup();
    const outcome = createOutcome();

    await consumeStream(
      streamOf([ev({ content: 'before <thinking>after</thinking>' })]),
      model, progress, token, startTime, outcome, 'http://host', 'm', output,
    );

    expect(outcome.sawRawThinkTags).toBe(true);
  });

  it('reports usage once and records the last request for the dashboard', async () => {
    const { progress, output } = setup();
    const outcome = createOutcome();
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } as any;

    await consumeStream(
      streamOf([ev({ content: 'hi', usage, metrics: { generation_time_ms: 12 } })]),
      model, progress, token, startTime, outcome, 'http://host', 'm', output,
    );

    expect(progress.report).toHaveBeenCalledWith(expect.objectContaining({ mimeType: 'usage' }));
    expect(output.appendLine).toHaveBeenCalled();
    const last = getLastRequest('http://host');
    expect(last?.modelId).toBe('m');
    expect(last?.promptTokens).toBe(10);
    expect(last?.totalTokens).toBe(15);
    expect(last?.maxModelLen).toBe(1100);
  });

  it('stops early when the token is cancelled before any part is reported', async () => {
    const { progress, output } = setup();
    const outcome = createOutcome();
    const cancelling = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }) } as any;

    await consumeStream(
      streamOf([ev({ content: 'hi' })]),
      model, progress, cancelling, startTime, outcome, 'http://host', 'm', output,
    );

    expect(progress.report).not.toHaveBeenCalled();
    expect(outcome.hadContent).toBe(false);
  });

  it('preserves already-reported output when cancellation arrives mid-stream', async () => {
    const { progress, output } = setup();
    const outcome = createOutcome();
    // The token flips to cancelled before the SECOND event is pulled: the loop
    // checks per iteration, so the first event was already reported and the
    // second must be dropped. Partial output must not be lost on cancellation.
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as any;
    async function* cancellingStream(): AsyncGenerator<StreamEvent> {
      yield ev({ content: 'first ' });
      token.isCancellationRequested = true;
      yield ev({ content: 'second' });
    }

    await consumeStream(
      cancellingStream(),
      model, progress, token, startTime, outcome, 'http://host', 'm', output,
    );

    expect(progress.report).toHaveBeenCalledWith(new vscode.LanguageModelTextPart('first '));
    expect(progress.report).not.toHaveBeenCalledWith(new vscode.LanguageModelTextPart('second'));
    expect(outcome.hadContent).toBe(true);
    expect(outcome.contentBuffer).toBe('first ');
  });
});
