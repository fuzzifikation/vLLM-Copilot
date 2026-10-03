import { describe, it, expect, vi } from 'vitest';

// Tripwire for the proposal-gating fallback: some VS Code installs gate
// `languageModelThinkingPart` at runtime (product.json allowlist / no dev mode),
// so `vscode.LanguageModelThinkingPart` is undefined and an unguarded
// `new ThinkingPart(...)` would throw on the first reasoning token.
// This file mocks vscode WITHOUT that symbol (module registry is per-file,
// so consumeStream.test.ts keeps the happy-path mock untouched).
vi.mock('vscode', async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return { ...mod, LanguageModelThinkingPart: undefined };
});

import { createExecutionState, executeChatRequest, type ExecutionInput } from '../src/core/request/execute.js';
import type { StreamEvent } from '../src/core/types.js';

function ev(p: Partial<StreamEvent>): StreamEvent {
  return { content: '', finishedToolCalls: [], ...p } as StreamEvent;
}

describe('consumeStream with LanguageModelThinkingPart gated off', () => {
  it('reports reasoning as a plain text part and warns once instead of throwing', async () => {
    const { consumeStream } = await import('../src/provider/consumeStream.js');
    const { LanguageModelTextPart, LanguageModelThinkingPart } = await import('vscode');
    expect(LanguageModelThinkingPart).toBeUndefined();

    const progress = { report: vi.fn() };
    const output = { appendLine: vi.fn() } as any;
    const state = createExecutionState(Date.now());

    const transport = {
      chatCompletionStream: async function* () {
        yield ev({ reasoning_content: 'thinking...' });
        yield ev({ content: 'answer' });
      },
    };
    const input: ExecutionInput = {
      transport, modelId: 'm', vllmModelId: 'm', openaiMessages: [], mergedOptions: {},
      serverConfig: { serverUrl: 'http://host', serverType: 'vllm', requestHeaders: {} } as any,
      maxRetries: 0, signal: new AbortController().signal, log: output,
      limits: { wireModelId: 'm', maxInputTokens: 1000, maxOutputTokens: 100 },
    };

    await consumeStream(
      executeChatRequest(input, state),
      { id: 'm', maxInputTokens: 1000, maxOutputTokens: 100 } as any,
      progress,
      state.outcome,
      output,
    );

    expect(progress.report).toHaveBeenCalledWith(new LanguageModelTextPart('thinking...'));
    expect(progress.report).toHaveBeenCalledWith(new LanguageModelTextPart('answer'));
    expect(state.outcome.hadReasoning).toBe(true);
    expect(state.outcome.hadVisibleReasoning).toBe(true);
    expect(output.appendLine).toHaveBeenCalledTimes(1);
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining('unavailable in this VS Code build'));
  });
});
