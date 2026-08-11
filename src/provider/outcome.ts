/**
 * Mutable accounting for a single streamed response, shared across the phases
 * of the provider's `provideLanguageModelChatResponse`. `consumeStream` updates
 * it as chunks arrive so that the post-stream diagnostics and the error handler
 * can both reason about exactly what reached the user — even when the stream
 * throws partway through.
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

/** Fresh outcome for the start of a request/attempt. */
export function createOutcome(): StreamOutcome {
  return {
    hadContent: false,
    hadToolCalls: false,
    hadReasoning: false,
    sawRawThinkTags: false,
    contentBuffer: undefined,
  };
}

/**
 * Reset all mutable fields on the outcome object for a retry attempt.
 */
export function resetOutcome(outcome: StreamOutcome): void {
  outcome.hadContent = false;
  outcome.hadToolCalls = false;
  outcome.hadReasoning = false;
  outcome.sawRawThinkTags = false;
  outcome.finishReason = undefined;
  outcome.firstTokenTime = undefined;
  outcome.contentBuffer = undefined;
}
