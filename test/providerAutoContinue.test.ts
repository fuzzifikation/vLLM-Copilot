import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import { VllmChatModelProvider } from '../src/provider.js';
import type { StreamEvent } from '../src/types.js';

/**
 * Unit tests for the auto-continue retry loop in
 * {@link VllmChatModelProvider.provideLanguageModelChatResponse}.
 *
 * Strategy: stub the request-assembly phase ({@link VllmChatModelProvider.buildRequest})
 * and the HTTP layer ({@link VllmClient.chatCompletionStream}) so the loop runs against
 * deterministic streams. Each `chatCompletionStream` call's messages + options are
 * captured so we can assert the exact request shape per retry trigger.
 */

function makeContext(): any {
  return {
    secrets: { get: async () => undefined },
    extension: { extensionKind: 1 }, // ExtensionKind.UI — default for tests (no remote)
  };
}
function makeOutput(): any { return { appendLine: vi.fn() }; }
function makeToken(): any {
  return { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
}

async function* streamOf(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of events) yield e;
}

/** Build a StreamEvent with sensible empty defaults. */
function ev(partial: Partial<StreamEvent>): StreamEvent {
  return { content: '', finishedToolCalls: [], ...partial } as StreamEvent;
}

interface Captured {
  messages: any[];
  options: Record<string, unknown>;
}

/**
 * Wire up a provider whose retry loop will see `streams` in order — one array of
 * StreamEvents per `chatCompletionStream` call. The last entry is reused if the loop
 * makes more calls than provided.
 */
function setupProvider(streams: StreamEvent[][], autoContinueRetries = 1) {
  const provider = new VllmChatModelProvider(makeContext(), makeOutput());

  (provider as any).client.getConfigCached = async () => ({
    models: [{ id: 'm', serverUrl: 'http://localhost:8000', autoContinueRetries }],
  });
  (provider as any).buildRequest = async () => ({
    vllmModelId: 'm',
    openaiMessages: [{ role: 'user', content: 'hi' }],
    mergedOptions: { temperature: 0 },
    serverConfig: { serverUrl: 'http://localhost:8000', requestHeaders: {} },
  });

  const captured: Captured[] = [];
  let call = 0;
  const spy = vi.fn((_modelId: string, messages: any[], options: Record<string, unknown>) => {
    captured.push({ messages: structuredClone(messages), options: structuredClone(options) });
    const stream = streams[Math.min(call, streams.length - 1)];
    call++;
    return streamOf(stream);
  });
  (provider as any).client.chatCompletionStream = spy;

  return { provider, captured, spy };
}

async function run(provider: VllmChatModelProvider, progress: { report: ReturnType<typeof vi.fn> }) {
  const messages = [{ content: [] }];
  await provider.provideLanguageModelChatResponse(
    { id: 'm', maxOutputTokens: 100 } as any,
    messages as any,
    {} as any,
    progress as any,
    makeToken(),
  );
}

/** Concatenate the text reported to Copilot (LanguageModelTextPart instances carry `.value`). */
function reportedText(progress: { report: ReturnType<typeof vi.fn> }): string {
  return progress.report.mock.calls
    .map(c => c[0])
    .filter((p: any) => typeof p?.value === 'string')
    .map((p: any) => p.value)
    .join('');
}

function lastMessage(c: Captured) {
  return c.messages[c.messages.length - 1];
}

describe('provideLanguageModelChatResponse auto-continue', () => {
  it('does not retry a normal response', async () => {
    const { provider, spy } = setupProvider([
      [ev({ content: 'Hello world', finishReason: null as any }), ev({ finishReason: 'stop' })],
    ]);
    const progress = { report: vi.fn() };

    await run(provider, progress);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(reportedText(progress)).toBe('Hello world');
  });

  it('retries an empty response with an empty assistant prefill (nudge, no continuation flags)', async () => {
    const { provider, captured, spy } = setupProvider([
      [ev({ finishReason: 'stop' })], // empty: no content, stops
      [ev({ content: 'Answer', finishReason: null as any }), ev({ finishReason: 'stop' })],
    ]);
    const progress = { report: vi.fn() };

    await run(provider, progress);

    expect(spy).toHaveBeenCalledTimes(2);
    // The retry appends an EMPTY assistant prefill and uses the DEFAULT chat-template flags.
    expect(lastMessage(captured[1])).toEqual({ role: 'assistant', content: '' });
    expect(captured[1].options.continue_final_message).toBeUndefined();
    expect(captured[1].options.add_generation_prompt).toBeUndefined();
    expect(reportedText(progress)).toBe('Answer');
  });

  it('continues a colon-truncated response using vLLM continuation flags', async () => {
    const { provider, captured, spy } = setupProvider([
      [ev({ content: 'Here are the steps:', finishReason: null as any }), ev({ finishReason: 'stop' })],
      [ev({ content: '\n1. Do it', finishReason: null as any }), ev({ finishReason: 'stop' })],
    ]);
    const progress = { report: vi.fn() };

    await run(provider, progress);

    expect(spy).toHaveBeenCalledTimes(2);
    // The retry prefills the assistant turn with everything streamed so far...
    expect(lastMessage(captured[1])).toEqual({ role: 'assistant', content: 'Here are the steps:' });
    // ...and switches vLLM into true continuation mode.
    expect(captured[1].options.continue_final_message).toBe(true);
    expect(captured[1].options.add_generation_prompt).toBe(false);
    // No duplication: the colon lead-in is streamed exactly once.
    expect(reportedText(progress)).toBe('Here are the steps:\n1. Do it');
  });

  it('does not continuation-retry when the colon stop is on the last allowed attempt', async () => {
    // autoContinueRetries: 0 disables retries entirely.
    const { provider, spy } = setupProvider(
      [[ev({ content: 'Trailing colon:', finishReason: null as any }), ev({ finishReason: 'stop' })]],
      0,
    );
    const progress = { report: vi.fn() };

    await run(provider, progress);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does not retry a colon-terminated reply that stopped on length, not stop', async () => {
    // Ends with a colon (would trigger continuation) BUT finish_reason is 'length',
    // so the stop-only gate must suppress the retry. This isolates the finish_reason check.
    const { provider, spy } = setupProvider([
      [ev({ content: 'Here are the steps:', finishReason: null as any }), ev({ finishReason: 'length' })],
    ]);
    const progress = { report: vi.fn() };

    await run(provider, progress);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('accumulates the prefill across multiple continuation retries', async () => {
    const { provider, captured, spy } = setupProvider(
      [
        [ev({ content: 'Step:', finishReason: null as any }), ev({ finishReason: 'stop' })],
        [ev({ content: ' more:', finishReason: null as any }), ev({ finishReason: 'stop' })],
        [ev({ content: ' done', finishReason: null as any }), ev({ finishReason: 'stop' })],
      ],
      2,
    );
    const progress = { report: vi.fn() };

    await run(provider, progress);

    expect(spy).toHaveBeenCalledTimes(3);
    // Third request continues from the concatenation of the first two streamed chunks.
    expect(lastMessage(captured[2])).toEqual({ role: 'assistant', content: 'Step: more:' });
    expect(captured[2].options.continue_final_message).toBe(true);
    expect(captured[2].options.add_generation_prompt).toBe(false);
    expect(reportedText(progress)).toBe('Step: more: done');
  });
});

describe('remote-install guard', () => {
  it('shows an error when extension runs locally on a remote session', async () => {
    const originalRemoteName = vscode.env.remoteName;

    // Simulate: connected to WSL, extension running locally (UI kind)
    (vscode.env as any).remoteName = 'wsl';
    const context = {
      secrets: { get: async () => undefined },
      extension: { extensionKind: vscode.ExtensionKind.UI },
    };
    const provider = new VllmChatModelProvider(context as any, makeOutput());

    const progress = { report: vi.fn() };
    await provider.provideLanguageModelChatResponse(
      { id: 'm', maxOutputTokens: 100 } as any,
      [] as any,
      {} as any,
      progress as any,
      makeToken(),
    );

    // Should have reported a text part with install instructions
    const calls = progress.report.mock.calls.map(c => (c[0] as any)?.value ?? '');
    expect(calls.some((t: string) => t.includes('not installed on the remote'))).toBe(true);
    expect(calls.some((t: string) => t.includes('wsl'))).toBe(true);

    // Restore
    (vscode.env as any).remoteName = originalRemoteName;
  });

  it('does not show guard when extension runs on remote workspace', async () => {
    const originalRemoteName = vscode.env.remoteName;

    // Simulate: connected to WSL, extension installed on remote (Workspace kind)
    (vscode.env as any).remoteName = 'wsl';
    const context = {
      secrets: { get: async () => undefined },
      extension: { extensionKind: vscode.ExtensionKind.Workspace },
    };
    const provider = new VllmChatModelProvider(context as any, makeOutput());

    // Stub the downstream so we can verify the guard doesn't short-circuit
    (provider as any).client.getConfigCached = async () => ({ models: [] });
    (provider as any).buildRequest = async () => ({
      vllmModelId: 'm',
      openaiMessages: [],
      mergedOptions: {},
      serverConfig: { serverUrl: '', requestHeaders: {}, streamInactivityTimeout: 0 },
    });

    const progress = { report: vi.fn() };
    await provider.provideLanguageModelChatResponse(
      { id: 'm', maxOutputTokens: 100 } as any,
      [] as any,
      {} as any,
      progress as any,
      makeToken(),
    );

    // Should NOT have reported the remote-install error
    const calls = progress.report.mock.calls.map(c => (c[0] as any)?.value ?? '');
    expect(calls.some((t: string) => t.includes('not installed on the remote'))).toBe(false);

    // Restore
    (vscode.env as any).remoteName = originalRemoteName;
  });

  it('does not show guard when not connected to a remote', async () => {
    const originalRemoteName = vscode.env.remoteName;

    // Simulate: no remote
    (vscode.env as any).remoteName = undefined;
    const context = {
      secrets: { get: async () => undefined },
      extension: { extensionKind: vscode.ExtensionKind.UI },
    };
    const provider = new VllmChatModelProvider(context as any, makeOutput());

    (provider as any).client.getConfigCached = async () => ({ models: [] });
    (provider as any).buildRequest = async () => ({
      vllmModelId: 'm',
      openaiMessages: [],
      mergedOptions: {},
      serverConfig: { serverUrl: '', requestHeaders: {}, streamInactivityTimeout: 0 },
    });

    const progress = { report: vi.fn() };
    await provider.provideLanguageModelChatResponse(
      { id: 'm', maxOutputTokens: 100 } as any,
      [] as any,
      {} as any,
      progress as any,
      makeToken(),
    );

    const calls = progress.report.mock.calls.map(c => (c[0] as any)?.value ?? '');
    expect(calls.some((t: string) => t.includes('not installed on the remote'))).toBe(false);

    // Restore
    (vscode.env as any).remoteName = originalRemoteName;
  });
});
