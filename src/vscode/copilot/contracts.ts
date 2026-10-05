import type { VllmConfig } from '../../core/config/config.js';
import type { ServerType } from '../../core/config/serverCore.js';
import type { OpenAIChatMessage, StreamEvent, VllmChatOptions, RuntimeModelLimits } from '../../core/types.js';
import type { ServerConfig } from '../../core/request/assemble.js';

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
 * Lives here (not `types.ts`) because it is a provider-layer contract, not a
 * wire format: it references `VllmConfig` (state) and `ServerConfig`
 * (requestBuilder). `types.ts` stays wire-format-only and knows neither.
 * (No cycle was ever at stake: nothing under `src/state/**` imports `types.ts`.
 * The previous sentence claimed exactly that cycle and was wrong.)
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
    vllmModelId?: string,
    /** Manual fallback for metadata-stripping gateways (`ModelConfig.contextWindow`). */
    configuredContextWindow?: number
  ): Promise<RuntimeModelLimits>;
  /**
   * `signal` is caller-owned: the Copilot boundary converts its cancellation
   * token once per operation and passes the derived signal down; the client
   * forwards it to the transport without subscribing or converting.
   */
  chatCompletionStream(
    model: string,
    messages: OpenAIChatMessage[],
    options: VllmChatOptions,
    signal: AbortSignal,
    serverConfig?: ServerConfig
  ): AsyncGenerator<StreamEvent>;
}

/**
 * Mutable accounting for a single streamed response. The type lives with the
 * execution core (`core/request/execute.ts`), which writes it as chunks pass;
 * re-exported here so the provider pipeline keeps importing from one contract.
 */
export type { StreamOutcome } from '../../core/request/execute.js';
