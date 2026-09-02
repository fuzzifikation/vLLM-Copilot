import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { reportPostStreamDiagnostics, handleResponseError } from '../src/provider/postStream.js';
import { createOutcome, type StreamOutcome } from '../src/provider/outcome.js';

function makeOutput(): vscode.OutputChannel & { appendLine: ReturnType<typeof vi.fn> } {
  return {
    name: 'test',
    append: vi.fn(),
    appendLine: vi.fn<(value: string) => void>(),
    replace: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
  };
}

function makeProgress(): { reports: unknown[]; report: (p: unknown) => void } {
  const reports: unknown[] = [];
  return { reports, report: (p: unknown) => { reports.push(p); } };
}

function makeModel(id = 'model-x'): any {
  return { id, maxOutputTokens: 4096 };
}

function makeToken(cancelled = false): any {
  return { isCancellationRequested: cancelled };
}

function makeOptions(toolMode?: vscode.LanguageModelChatToolMode): any {
  return { tools: toolMode === undefined ? undefined : [{ name: 'tool-1' }], toolMode };
}

function outcome(partial: Partial<StreamOutcome> = {}): StreamOutcome {
  return {
    ...createOutcome(),
    hadContent: false,
    hadToolCalls: false,
    hadReasoning: false,
    sawRawThinkTags: false,
    finishReason: undefined,
    contentBuffer: '',
    ...partial,
  };
}

function lines(output: { appendLine: ReturnType<typeof vi.fn> }): string {
  return output.appendLine.mock.calls.map(c => c[0]).join('\n');
}

describe('handleResponseError', () => {
  it('logs user cancellation quietly without reporting a part', () => {
    const output = makeOutput();
    const progress = makeProgress();
    handleResponseError(
      new Error('boom'),
      makeModel(),
      outcome(),
      makeToken(true),
      progress,
      output,
    );
    expect(lines(output)).toContain('request cancelled by user');
    expect(progress.reports).toHaveLength(0);
  });

  it('treats graceful termination as quiet and reports a minimal part when empty', () => {
    const output = makeOutput();
    const progress = makeProgress();
    const terminated = new TypeError('terminated');
    handleResponseError(
      terminated,
      makeModel(),
      outcome(),
      makeToken(false),
      progress,
      output,
    );
    expect(lines(output)).toContain('request terminated');
    expect(progress.reports).toHaveLength(1);
    expect(String((progress.reports[0] as any).value)).toBe('\n');
  });

  it('does not report a part on graceful termination when content was produced', () => {
    const output = makeOutput();
    const progress = makeProgress();
    handleResponseError(
      new TypeError('terminated'),
      makeModel(),
      outcome({ hadContent: true }),
      makeToken(false),
      progress,
      output,
    );
    expect(lines(output)).toContain('request terminated');
    expect(progress.reports).toHaveLength(0);
  });

  it('surfaces a generic error as an ERROR log and a warning part', () => {
    const output = makeOutput();
    const progress = makeProgress();
    handleResponseError(
      new Error('connection refused'),
      makeModel('m-err'),
      outcome(),
      makeToken(false),
      progress,
      output,
    );
    expect(lines(output)).toContain('[ERROR] Chat response failed for m-err');
    expect(progress.reports).toHaveLength(1);
    expect(String((progress.reports[0] as any).value)).toContain('⚠️');
  });

  it('surfaces a server JSON error to the chat with the code and message (no stack)', () => {
    const output = makeOutput();
    const progress = makeProgress();
    const err = new Error(
      'HTTP 402: Payment Required — {"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 50000 tokens, but can only afford 6666."}}'
    );
    handleResponseError(
      err,
      makeModel('x-ai/grok-4.6 on openrouter.ai'),
      outcome(),
      makeToken(false),
      progress,
      output,
    );
    expect(lines(output)).toContain('[ERROR] Chat response failed for x-ai/grok-4.6 on openrouter.ai');
    expect(progress.reports).toHaveLength(1);
    const text = String((progress.reports[0] as any).value);
    expect(text).toContain('Server error [402]');
    expect(text).toContain('This request requires more credits');
    // The chat part must never carry the stack trace or backend-specific wording.
    expect(text).not.toContain('at fetchWithRetry');
    expect(text).not.toContain('vLLM');
  });
});
