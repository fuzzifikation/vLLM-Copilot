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

import type { StreamOutcome } from '../src/provider/contracts.js';
import type { StreamEvent } from '../src/types.js';

async function* streamOf(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}
function ev(p: Partial<StreamEvent>): StreamEvent {
  return { content: '', finishedToolCalls: [], ...p } as StreamEvent;
}
const createOutcome = (): StreamOutcome => ({
  hadContent: false,
  hadToolCalls: false,
  hadReasoning: false,
  sawRawThinkTags: false,
});

describe('consumeStream with LanguageModelThinkingPart gated off', () => {
  it('reports reasoning as a plain text part and warns once instead of throwing', async () => {
    const { consumeStream } = await import('../src/provider/consumeStream.js');
    const { LanguageModelTextPart, LanguageModelThinkingPart } = await import('vscode');
    expect(LanguageModelThinkingPart).toBeUndefined();

    const progress = { report: vi.fn() };
    const output = { appendLine: vi.fn() } as any;
    const outcome = createOutcome();

    await consumeStream(
      streamOf([ev({ reasoning_content: 'thinking...' }), ev({ content: 'answer' })]),
      { id: 'm', maxInputTokens: 1000, maxOutputTokens: 100 } as any,
      progress,
      { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) } as any,
      Date.now(), outcome, 'http://host', 'm', output,
    );

    expect(progress.report).toHaveBeenCalledWith(new LanguageModelTextPart('thinking...'));
    expect(progress.report).toHaveBeenCalledWith(new LanguageModelTextPart('answer'));
    expect(outcome.hadReasoning).toBe(true);
    expect(output.appendLine).toHaveBeenCalledTimes(1);
    expect(output.appendLine).toHaveBeenCalledWith(expect.stringContaining('unavailable in this VS Code build'));
  });
});
