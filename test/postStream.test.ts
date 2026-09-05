import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { reportPostStreamDiagnostics, handleResponseError } from '../src/provider/postStream.js';
import type { StreamOutcome } from '../src/provider/contracts.js';

// Mirror of the orchestrator's private factory (U2: createOutcome moved into
// streamOrchestrator.ts; the interface in contracts.ts is the public seam).
const createOutcome = (): StreamOutcome => ({
  hadContent: false,
  hadToolCalls: false,
  hadReasoning: false,
  sawRawThinkTags: false,
});

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
      'HTTP 402: Payment Required - {"error":{"message":"This request requires more credits, or fewer max_tokens. You requested up to 50000 tokens, but can only afford 6666."}}'
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
// U4: isGracefulTermination became module-private in postStream.ts (sole
// consumer). The pins moved from direct predicate calls to the observable
// behavior of handleResponseError: graceful = quiet INFO + minimal '\n'
// part, no scary ⚠️ part; everything else must surface as an error.
describe('graceful termination via handleResponseError', () => {
  function run(err: unknown): { output: ReturnType<typeof makeOutput>; progress: ReturnType<typeof makeProgress> } {
    const output = makeOutput();
    const progress = makeProgress();
    handleResponseError(err, makeModel('model-g'), outcome(), makeToken(false), progress as any, output);
    return { output, progress };
  }

  it('recognizes TypeError: terminated (VS Code internal .terminate())', () => {
    const { output, progress } = run(new TypeError('terminated'));
    expect(lines(output)).toContain('model-g: request terminated (connection reset).');
    expect(lines(output)).not.toContain('[ERROR]');
    // No content was produced -> exactly one minimal newline part, no ⚠️.
    expect(progress.reports).toHaveLength(1);
    expect(String((progress.reports[0] as any).value)).toBe('\n');
  });

  it('recognizes TypeError: terminated nested in a cause chain', () => {
    const outer = new Error('fetch failed', { cause: new TypeError('terminated') });
    const { output } = run(outer);
    expect(lines(output)).toContain('request terminated (connection reset).');
    expect(lines(output)).not.toContain('[ERROR]');
  });

  it('does NOT swallow TypeError: terminated with a socket-kill cause (CR-35)', () => {
    // undici wraps EVERY mid-body network kill as TypeError('terminated')
    // with the real culprit in cause. Swallowing this shape means a proxy
    // chopping the stream reads to the user as a complete answer.
    const kill = new Error('other side closed');
    kill.name = 'SocketError';
    const { output, progress } = run(new TypeError('terminated', { cause: kill }));
    expect(lines(output)).toContain('[ERROR]');
    expect(lines(output)).not.toContain('request terminated');
    expect(String((progress.reports[0] as any).value)).toContain('⚠️');
  });

  it('does NOT swallow terminated nested above an ECONNRESET-cause chain (CR-35)', () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const inner = new TypeError('terminated', { cause: reset });
    const outer = new Error('fetch failed', { cause: inner });
    const { output } = run(outer);
    expect(lines(output)).toContain('[ERROR]');
    expect(lines(output)).not.toContain('request terminated');
  });

  it('does NOT swallow ERR_STREAM_PREMATURE_CLOSE (network drop must surface)', () => {
    // A premature close is a network/proxy drop, NOT an intentional
    // .terminate(). Swallowing it silently would hide real failures.
    const err = Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
    const { output, progress } = run(err);
    expect(lines(output)).toContain('[ERROR]');
    expect(String((progress.reports[0] as any).value)).toContain('⚠️');
  });

  it('does NOT swallow bare ECONNRESET', () => {
    const { output } = run(new Error('ECONNRESET'));
    expect(lines(output)).toContain('[ERROR]');
  });

  it('does NOT swallow string throws (our own abort reasons)', () => {
    const a = run('User cancelled');
    expect(lines(a.output)).toContain('[ERROR]');
    const b = run('Stream inactivity timeout (30000ms without data)');
    expect(lines(b.output)).toContain('[ERROR]');
  });
});

// The chat-warning gate of reportPostStreamDiagnostics (CR-38, P2-5 ruling):
// the sticky everStreamed bit decides whether the in-chat "returned no
// output" line contradicts output the user already watched (answer, tool
// call, or a thinking block). The Output-channel diagnostics stay honest
// either way.
describe('empty-response chat warning gate', () => {
  function run(o: StreamOutcome, attempts = 2) {
    const output = makeOutput();
    const progress = makeProgress();
    reportPostStreamDiagnostics(
      makeModel('model-p'), makeOptions(), o, Date.now() - 100, progress as any, attempts, output,
    );
    return { output, progress };
  }

  it('suppresses the chat warning when an earlier attempt streamed visible output', () => {
    // Reasoning streamed on attempt 1 latches everStreamed at reset; the
    // final attempt is empty. Chat must stay silent (the user watched a
    // thinking block), Output stays per-attempt honest.
    const { output, progress } = run(outcome({ finishReason: 'stop', everStreamed: true }));
    expect(lines(output)).toContain('empty response after 2 attempt(s)');
    expect(progress.reports).toHaveLength(0);
  });

  it('warns in chat on a reasoning-only stop when retries are off', () => {
    // autoContinueRetries=0: this warning is the user's only signal. The
    // reason string names the reasoning tokens explicitly - honest even
    // though a thinking block rendered.
    const { output, progress } = run(outcome({ finishReason: 'stop', hadReasoning: true, everStreamed: false }), 1);
    expect(lines(output)).toContain('empty response (');
    expect(progress.reports).toHaveLength(1);
    expect(String((progress.reports[0] as any).value)).toContain('only producing reasoning/thinking tokens');
  });
});