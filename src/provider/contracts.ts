import type * as vscode from 'vscode';
import type { VllmConfig, ServerType } from '../config.js';
import type { OpenAIChatMessage, StreamEvent, VllmChatOptions, RuntimeModelLimits } from '../types.js';
import type { ServerConfig } from './requestBuilder.js';

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
  /**
   * Resolve the model's runtime limits — context window plus an optional
   * server-reported output ceiling — switching strictly on `serverType`. THROWS
   * when the server is unreachable OR the standard documented path for that
   * backend reports no window — we never fabricate metadata (user directive).
   * Callers skip the model on throw. Backends that report no output ceiling
   * leave `maxOutputTokens` undefined.
   */
  getModelContextWindow(
    serverType: ServerType,
    serverUrl: string,
    requestHeaders?: Record<string, string>,
    vllmModelId?: string
  ): Promise<RuntimeModelLimits>;
  chatCompletionStream(
    model: string,
    messages: OpenAIChatMessage[],
    options: VllmChatOptions,
    token: vscode.CancellationToken,
    serverConfig?: ServerConfig
  ): AsyncGenerator<StreamEvent>;
}
