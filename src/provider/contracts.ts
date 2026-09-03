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

/**
 * Mutable accounting for a single streamed response, shared across the phases
 * of the provider's `provideLanguageModelChatResponse`. `consumeStream` updates
 * it as chunks arrive so that the post-stream diagnostics and the error handler
 * can both reason about exactly what reached the user — even when the stream
 * throws partway through. Owner: `streamOrchestrator` (create/reset live
 * there); the rest of the pipeline only reads and writes fields.
 */
export interface StreamOutcome {
  /** At least one text content part was reported to the user. */
  hadContent: boolean;
  /** At least one tool call was reported to the user. */
  hadToolCalls: boolean;
  /** At least one reasoning/thinking part was reported. */
  hadReasoning: boolean;
  /** Raw `.githubusercontent` tags leaked into content (server is missing a `--reasoning-parser`). */
  sawRawThinkTags: boolean;
  /** The server's `finish_reason` for the turn, once known. */
  finishReason?: string;
  /** Time-to-first-token, in ms since the request started. */
  firstTokenTime?: number;
  /** Full accumulated text content for this turn (used as assistant prefill/continuation on retry). */
  contentBuffer?: string;
}
