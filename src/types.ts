/**
 * Shared type definitions for stream events.
 * Lives here (not in vllmClient.ts) to avoid circular imports between vllmClient and sseParser.
 */

/**
 * A finalized (complete) tool call ready for JSON parsing.
 */
export interface FinalizedToolCall {
  id: string;
  name: string;
  arguments: string;
}

// ── OpenAI/vLLM wire contracts ───────────────────────────────────────────────
// These describe the exact JSON we send to and receive from the vLLM server.
// We own this contract (it is the OpenAI/vLLM chat-completions format), so it is
// fully typed — unlike the VS Code provider API, where some fields are undocumented
// and must be reached via casts.

/** A single tool call we send back to the server inside an assistant message. */
export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** A content part of a user message (multimodal text/image). */
export type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** An OpenAI chat-completions message in request format. */
export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIContentPart[];
  /** Structured assistant reasoning supplied by VS Code's thinking-history API. */
  reasoning?: string;
  /** Present on assistant messages that invoked tools. */
  tool_calls?: OpenAIToolCall[];
  /** Present on `role: 'tool'` messages, linking back to the assistant's call. */
  tool_call_id?: string;
}

/** Authoritative token usage reported by vLLM at end of stream. */
export interface WireUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** vLLM details — may include `cached_tokens`, `prompt_time`, etc. */
  prompt_tokens_details?: Record<string, number>;
  /** vLLM details — may include `reasoning_tokens`, `decode_time` / `completion_time`, etc. */
  completion_tokens_details?: Record<string, number>;
}

/** A partial tool call as it arrives across streaming chunks. */
export interface WireToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** The incremental `delta` object on a streaming choice. */
export interface WireDelta {
  content?: string;
  /** Reasoning/thinking text. vLLM's streaming field (formerly `reasoning_content`). */
  reasoning?: string;
  tool_calls?: WireToolCallDelta[];
}

/** A single choice within a streamed chunk. */
export interface WireChoice {
  delta?: WireDelta;
  finish_reason?: string | null;
}

/** One parsed SSE `data:` chunk from the vLLM chat-completions stream. */
export interface WireChunk {
  choices?: WireChoice[];
  usage?: WireUsage;
  /** Per-request timing metrics (requires `--enable-per-request-metrics` on server). */
  metrics?: WireMetrics;
  error?: { message?: string } | string;
}

/**
 * Per-request timing metrics from vLLM.
 * Only available when server is started with `--enable-per-request-metrics`.
 */
export interface WireMetrics {
  /** Time to first token in ms. */
  time_to_first_token_ms?: number;
  /** Total generation time in ms. */
  generation_time_ms?: number;
  /** Time spent in queue before generation started in ms. */
  queue_time_ms?: number;
}

/** A single model entry in the vLLM `/v1/models` response `data` array. */
export interface VllmModel {
  id: string;
  object: string;
  owned_by: string;
  max_model_len?: number;
  /** Underlying checkpoint id. vLLM sets this to the HF repo when the model is a
   *  `--served-model-name` alias, so it links aliases back to their real model. */
  root?: string;
  permission?: unknown[];
}

/** Wire-format for vLLM repetition_detection parameter. */
export interface WireRepetitionDetectionConfig {
  max_pattern_size: number;
  min_count: number;
  min_pattern_size: number;
}

/**
 * Wire-format for vLLM structured_outputs parameter.
 * Enforces output constraints at the token level. Exactly one field should be set.
 * This type is re-exported as `StructuredOutputConfig` in config.ts for the VS Code settings shape.
 */
export interface WireStructuredOutputConfig {
  /** JSON schema the output must conform to (object or JSON string). */
  json?: object | string;
  /** Regular expression the output must match. */
  regex?: string;
  /** Output must be exactly one of these choices. */
  choice?: string[];
  /** Context-free EBNF grammar the output must follow. */
  grammar?: string;
}

/**
 * Sampling parameters for vLLM chat completion requests.
 * Covers standard OpenAI params plus vLLM-specific extensions.
 */
export interface VllmChatOptions {
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  repetition_penalty?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  seed?: number;
  stop?: string | string[];
  min_tokens?: number;
  tools?: any[];
  tool_choice?: 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };
  parallel_tool_calls?: boolean;
  /**
   * vLLM continuation: leave the final (assistant) message open — no EOS token — so the
   * model resumes it instead of starting a new turn. Used to continue a truncated reply.
   * Mutually exclusive with `add_generation_prompt` (vLLM rejects both being true).
   */
  continue_final_message?: boolean;
  /**
   * vLLM: whether to append a fresh assistant generation prompt. Defaults to true server-side.
   * Must be set to false when `continue_final_message` is true.
   */
  add_generation_prompt?: boolean;
  /**
   * vLLM-specific: words the model must not generate.
   * Sent as `bad_words` to vLLM.
   */
  bad_words?: string[];
  /**
   * vLLM-specific: ignore EOS token and keep generating.
   * Sent as `ignore_eos` to vLLM.
   */
  ignore_eos?: boolean;
  /**
   * vLLM-specific: detect repetitive N-gram patterns and stop early.
   * Sent as `repetition_detection` to vLLM.
   */
  repetition_detection?: WireRepetitionDetectionConfig;
  /**
   * vLLM-specific: enforce structured output constraints (JSON schema, regex, choice, grammar).
   * Sent as `structured_outputs` to vLLM.
   */
  structured_outputs?: WireStructuredOutputConfig;
}

/**
 * Structured stream event returned by chatCompletionStream.
 * Incremental deltas (content, reasoning, tool call args) are accumulated internally
 * by sseParser.ts into finalized tool calls — the caller consumes only the result.
 */
export interface StreamEvent {
  content: string;
  reasoning_content?: string;
  finishedToolCalls: FinalizedToolCall[];
  finishReason?: string;
  /**
   * Error reported by the server inside the SSE stream (e.g. `{"error": {...}}`).
   * Set when vLLM aborts a request mid-stream. The client turns this into a thrown
   * Error so the reason reaches the user, the Output channel, and the log file.
   */
  error?: string;
  usage?: WireUsage;
  /** Per-request timing metrics (requires `--enable-per-request-metrics`). */
  metrics?: WireMetrics;
}
