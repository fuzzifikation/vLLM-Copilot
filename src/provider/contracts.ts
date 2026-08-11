import type * as vscode from 'vscode';
import type { VllmConfig } from '../config.js';
import type { OpenAIChatMessage, StreamEvent, VllmChatOptions } from '../types.js';

/**
 * Narrow client surface the provider needs. Structural — `VllmClient` satisfies
 * it and tests inject a fake, so provider logic never depends on the transport
 * implementation. (Injected via the optional `dependencies` constructor arg.)
 *
 * Implementations MUST NOT mutate `messages` or `options` passed to
 * `chatCompletionStream`: the provider hands over live arrays/objects that it
 * mutates across retry attempts (the auto-continue loop appends an assistant
 * prefill message in place and re-passes the same array each attempt). The real
 * client copies `options` into a fresh body and passes `messages` by reference
 * without modifying either.
 *
 * Lives here (not `types.ts`) because it references `VllmConfig`, and `config.ts`
 * imports from `types.ts` — putting it in `types.ts` would create a
 * `config.ts ↔ types.ts` cycle.
 */
export interface ProviderClient {
  getConfigCached(): Promise<VllmConfig>;
  invalidateConfigCache(): void;
  getModelContextWindow(
    serverUrl: string,
    requestHeaders?: Record<string, string>,
    vllmModelId?: string
  ): Promise<number | undefined>;
  chatCompletionStream(
    model: string,
    messages: OpenAIChatMessage[],
    options: VllmChatOptions,
    token: vscode.CancellationToken,
    serverConfig?: { serverUrl?: string; requestHeaders?: Record<string, string>; streamInactivityTimeout?: number }
  ): AsyncGenerator<StreamEvent>;
}
