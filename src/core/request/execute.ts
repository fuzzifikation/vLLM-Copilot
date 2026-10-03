/**
 * Shared request execution: the bounded retry loop and the neutral stream
 * observations, as one pull-based async iterable. An adapter (the Copilot
 * provider today, the harness gateway tomorrow) supplies an assembled
 * request, plain accounting/model limits, a signal and a transport, consumes
 * the events, and owns its output vocabulary (parts, tool-argument repair
 * presentation, usage reporting/recording) and its user-facing diagnostics.
 *
 * Two kinds of event (the existing `StreamEvent` vocabulary plus attempt
 * completion):
 *   - a `StreamEvent` already observed (timing, content buffer, think-tag
 *     detection, per-attempt tool-call id dedup applied to `state.outcome`);
 *   - an `AttemptCompletionEvent` — the final sanitized usage, the completed
 *     request record, and the attempt's measured time — emitted once per
 *     attempt that ended normally with usage, including a quiet cancellation
 *     after usage was seen. A stream THROW skips the record (as before), and
 *     this iterable never emits a terminal "harness finish" for a retriable
 *     backend finish. Final request status lives in `state.outcome`.
 *
 * Retry triggers (defaults/budget from the caller; semantics unchanged):
 *   0. Mid-stream server error with nothing streamed (provider died after
 *      the 200): replay the SAME request shape — a fresh request re-enters
 *      the server's routing.
 *   1. Empty response (reasoning only, then stop): re-ask with an empty
 *      assistant prefill under the DEFAULT chat-template flags (a nudge).
 *   2. Truncated mid-sentence (content ends with ':'): CONTINUE the streamed
 *      text — vLLM-only (continue_final_message); secondary backends retry
 *      in nudge mode.
 * All retry eligibility is judged from what the CONSUMER has made visible
 * (`hadContent`/`hadToolCalls`/`hadVisibleReasoning` on the shared outcome),
 * never from what the server merely emitted. The caller owns `openaiMessages`
 * and may see the trailing prefill slot mutated in place, as before.
 */
import type { OpenAIChatMessage, StreamEvent, WireMetrics, WireUsage } from '../types.js';
import type { ServerConfig } from './assemble.js';
import type { RequestLog } from '../shared/trace.js';
import type { LastRequestData } from '../usage/record.js';

/**
 * Mutable accounting for one streamed response, shared across the phases of
 * a request. The executor updates it as chunks arrive so the consumer's error
 * handler and post-stream diagnostics can both reason about exactly what
 * reached the user — even when the stream throws partway through.
 */
export interface StreamOutcome {
  /** At least one text content part was reported to the user. */
  hadContent: boolean;
  /** At least one tool call was reported to the user. */
  hadToolCalls: boolean;
  /** At least one reasoning/thinking part was reported. */
  hadReasoning: boolean;
  /**
   * Reasoning was reported as PLAIN TEXT because this host has no thinking
   * part, so it is real answer content the user can see and cannot be
   * discarded. Distinct from `hadReasoning`, which is true either way and is
   * therefore not enough to decide whether a turn can be replayed.
   */
  hadVisibleReasoning: boolean;
  /** Raw `<thinking>` tags leaked into content (server is missing a `--reasoning-parser`). */
  sawRawThinkTags: boolean;
  /** The server's `finish_reason` for the turn, once known. */
  finishReason?: string;
  /** Time-to-first-token, in ms since the request started. */
  firstTokenTime?: number;
  /** Full accumulated text content for this turn (used as assistant prefill/continuation on retry). */
  contentBuffer?: string;
  /**
   * Sticky across auto-continue resets: ANY attempt of this request streamed
   * visible output to the user — content, a tool call, or reasoning they
   * watched. Per-attempt fields reset between retries; this bit survives so
   * post-stream diagnostics can never report "the model returned no output"
   * over output the user already saw (CR-38). It gates only the chat warning;
   * the retry decision reads the fresh per-attempt fields, so a
   * reasoning-then-empty turn is still nudged.
   */
  everStreamed?: boolean;
}

/**
 * Fresh outcome for the start of a request/attempt. FULL-zero literal: every
 * mutable field is listed, so `resetOutcome` can reuse it — a literal that
 * omitted finishReason/firstTokenTime would leak a stale finish_reason across
 * auto-continue attempts.
 */
export function createOutcome(): StreamOutcome {
  return {
    hadContent: false,
    hadToolCalls: false,
    hadReasoning: false,
    hadVisibleReasoning: false,
    sawRawThinkTags: false,
    finishReason: undefined,
    firstTokenTime: undefined,
    contentBuffer: undefined,
    everStreamed: false,
  };
}

/**
 * Reset all per-attempt fields on the outcome object for a retry. `everStreamed`
 * is STICKY across the whole request (CR-38): once any attempt has put visible
 * output on the user's screen — answer, tool call, or a thinking block they
 * watched — post-stream diagnostics must not later claim the model "returned no
 * output". The reset final attempt still judges itself for the retry decision:
 * the retry gate reads the fresh fields, so reasoning-then-empty keeps nudging.
 */
export function resetOutcome(outcome: StreamOutcome): void {
  const everStreamed = outcome.everStreamed || outcome.hadContent || outcome.hadToolCalls || outcome.hadReasoning;
  Object.assign(outcome, createOutcome(), { everStreamed });
}

/** Caller-owned execution state — survives throws, shared with the consumer. */
export interface ExecutionState {
  /** The shared outcome (observations land here as events pass). */
  outcome: StreamOutcome;
  /** Request-wide start (epoch ms) — drives consumer-side diagnostics. */
  requestStartTime: number;
  /** Start of the attempt currently in flight (epoch ms) — TTFT/total basis. */
  attemptStartTime: number;
  /** Actual number of attempts made (initial + retries) — for diagnostics. */
  attemptCount: number;
}

export function createExecutionState(startTime: number): ExecutionState {
  return { outcome: createOutcome(), requestStartTime: startTime, attemptStartTime: startTime, attemptCount: 0 };
}

/** Transport seam: a signal-based streaming call, `VllmClient` satisfies it. */
export interface ExecutionTransport {
  chatCompletionStream(
    model: string,
    messages: OpenAIChatMessage[],
    options: Record<string, unknown>,
    signal: AbortSignal,
    serverConfig: ServerConfig,
  ): AsyncIterable<StreamEvent>;
}

/** Inputs to {@link executeChatRequest} — plain data, explicit everything. */
export interface ExecutionInput {
  transport: ExecutionTransport;
  /** Config id — used only in retry log lines. */
  modelId: string;
  /** Wire id SENT for this request (may carry an OpenRouter routing suffix). */
  vllmModelId: string;
  /**
   * Caller-owned message array. The executor mutates ONLY a trailing
   * assistant prefill slot it appends (auto-continue), as the provider loop
   * has always done.
   */
  openaiMessages: OpenAIChatMessage[];
  mergedOptions: Record<string, unknown>;
  serverConfig: ServerConfig;
  /** Retry budget: retries ADDED to the initial attempt. */
  maxRetries: number;
  signal: AbortSignal;
  log: RequestLog;
  /** Plain accounting/model limits for the completed-request record. */
  limits: {
    /** CANONICAL wire id (base slug) — the usage/cost key. */
    wireModelId: string;
    /** Authoritative context window when known (discovery), else derived. */
    contextWindow?: number;
    maxInputTokens: number;
    maxOutputTokens: number;
  };
}

/** Emitted once per normally-completed attempt that saw usage. */
export interface AttemptCompletionEvent {
  attemptCompletion: {
    /** Sanitized cumulative usage (garbage-proofed at the wire). */
    usage: WireUsage;
    metrics?: WireMetrics;
    /** The complete request record, ready to record/aggregate. */
    lastRequest: LastRequestData;
    /** Measured wall time of the FINAL attempt, in ms. */
    elapsedMs: number;
    /** Measured TTFT of the final attempt, in ms (null when no token). */
    firstTokenTimeMs: number | null;
  };
}

export type ExecutionEvent = StreamEvent | AttemptCompletionEvent;

export function isAttemptCompletionEvent(e: ExecutionEvent): e is AttemptCompletionEvent {
  return 'attemptCompletion' in e;
}

/**
 * Third-party servers do not get to poison the persisted counters: clamp every
 * usage number to a finite non-negative value at the single capture point. A
 * lying `completion_tokens: "500"` string would string-concat into the
 * all-time totals forever (0 + "500" = "0500"); NaN/null would crash the
 * reporting lines AFTER the full answer already streamed. Garbage reads as 0.
 * `cost` is clamped here too, not just in the ledger's accumulateCost: the raw
 * value also flows through `lastRequest` into `formatAmount`-style consumers
 * (`.toFixed`) and the token-usage log line, paths the accumulation guard
 * never covers. A lying relay's `"cost": "0.00002"` would throw AFTER the
 * answer completed and permanently poison the dashboard's Last Request node.
 */
export function sanitizeUsage(u: WireUsage): WireUsage {
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const nums = (d: Record<string, number> | undefined): Record<string, number> | undefined =>
    d && typeof d === 'object'
      ? Object.fromEntries(Object.entries(d).map(([k, v]) => [k, n(v)]))
      : undefined;
  return {
    ...u,
    prompt_tokens: n(u.prompt_tokens),
    completion_tokens: n(u.completion_tokens),
    total_tokens: n(u.total_tokens),
    prompt_tokens_details: nums(u.prompt_tokens_details),
    completion_tokens_details: nums(u.completion_tokens_details),
    cost: typeof u.cost === 'number' && Number.isFinite(u.cost) && u.cost >= 0 ? u.cost : undefined,
  };
}

/**
 * Matches raw reasoning tags (`</thinking>`, `<thinking>`, etc.) that
 * leak into the content stream when vLLM has no matching `--reasoning-parser`.
 */
const RAW_THINK_TAG = /<\/?think(?:ing)?>/i;

/**
 * Run the assembled request: attempt loop + observations + completion events.
 *
 * Per-attempt timing basis is `state.attemptStartTime`: a retried request
 * records only the FINAL attempt's duration (the one whose output the user
 * actually saw) — a request-wide basis would make totalTimeMs span all
 * attempts while firstTokenTime was the last attempt's, producing a garbage
 * "Generation (measured)" row. `state.requestStartTime` still drives the
 * consumer's overall post-stream diagnostics.
 */
export async function* executeChatRequest(
  input: ExecutionInput,
  state: ExecutionState,
): AsyncGenerator<ExecutionEvent> {
  const { transport, modelId, vllmModelId, openaiMessages, mergedOptions, serverConfig, maxRetries, signal, log, limits } = input;
  const outcome = state.outcome;

  let prefillIndex = -1;       // index of the trailing assistant prefill message, once added
  let assistantPrefill = '';   // text to continue; empty string keeps us in nudge mode

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    state.attemptCount++;
    state.attemptStartTime = Date.now();
    // Per-attempt tool-call id dedup (a finalized call is reported once).
    const reportedToolCallIds = new Set<string>();
    // Look up the final usage AFTER the loop — some servers send usage on
    // every chunk; the last one wins and it is reported once per attempt.
    let pendingUsage: WireUsage | undefined;
    let pendingMetrics: WireMetrics | undefined;
    // Trailing characters of the last content chunk, for split-tag detection.
    let thinkWindow = '';

    // Continuation mode (continue_final_message) is a vLLM-only feature. The
    // secondary backends' chat protocol strips those flags but KEEPS the assistant
    // prefill — so a colon-continuation would send the partial text as a COMPLETE
    // assistant turn and the server would regenerate from scratch, making the user
    // see the partial text twice. Non-vLLM backends always retry in nudge mode.
    const continuing = assistantPrefill.length > 0 && serverConfig.serverType === 'vllm';
    const requestOptions = continuing
      ? { ...mergedOptions, continue_final_message: true, add_generation_prompt: false }
      : mergedOptions;

    try {
      for await (const event of transport.chatCompletionStream(
        vllmModelId,
        openaiMessages,
        requestOptions,
        signal,
        serverConfig,
      )) {
        if (signal.aborted) {
          break;
        }

        // Handle reasoning/thinking tokens (deep thinking models like QwQ, DeepSeek R1)
        if (event.reasoning_content) {
          if (outcome.firstTokenTime === undefined) outcome.firstTokenTime = Date.now() - state.attemptStartTime;
          outcome.hadReasoning = true;
        }

        // Handle text content
        if (event.content) {
          if (outcome.firstTokenTime === undefined) outcome.firstTokenTime = Date.now() - state.attemptStartTime;
          outcome.hadContent = true;
          outcome.contentBuffer = (outcome.contentBuffer ?? '') + event.content;
          // Detect raw thinking tags leaking into content. When vLLM is started without
          // a matching --reasoning-parser, the model's <thinking>...</thinking> markers arrive
          // as plain content instead of the `reasoning` field, then the editor strips them.
          if (!outcome.sawRawThinkTags) {
            // Sliding tail window: a <thinking> tag straddling two network chunks
            // must not silently defeat the missing-parser diagnostic (CR-20).
            // '</thinking>' is the longest needle at 11 chars; 16 carried chars
            // cover any split point.
            const probe = thinkWindow + event.content;
            if (RAW_THINK_TAG.test(probe)) outcome.sawRawThinkTags = true;
            thinkWindow = probe.slice(-16);
          }
        }

        // Handle finalized tool calls — per-attempt id dedup lives HERE, so
        // the consumer never sees a duplicate and never re-reports it. Usage,
        // metrics and finishReason on an all-duplicate event still pass
        // through the bookkeeping below; only the tool calls are dropped.
        let toYield: StreamEvent | undefined = event;
        if (event.finishedToolCalls.length > 0) {
          // A tool call is the model's first output just as much as text is; without
          // this stamp a pure tool-call turn reported TTFT as null (CR-19).
          if (outcome.firstTokenTime === undefined) outcome.firstTokenTime = Date.now() - state.attemptStartTime;
          const fresh = event.finishedToolCalls.filter((tc) => {
            // tc.name is guaranteed: finalizePendingToolCalls (the sole producer)
            // drops name-less entries. Only the id-dedup is a real guard here.
            if (reportedToolCallIds.has(tc.id)) return false;
            reportedToolCallIds.add(tc.id);
            outcome.hadToolCalls = true;
            return true;
          });
          if (fresh.length === 0) toYield = undefined;
          else if (fresh.length < event.finishedToolCalls.length) toYield = { ...event, finishedToolCalls: fresh };
        }
        if (toYield) yield toYield;

        if (event.usage) pendingUsage = sanitizeUsage(event.usage);
        if (event.metrics) pendingMetrics = event.metrics;
        if (event.finishReason) outcome.finishReason = event.finishReason;
      }
    } catch (err) {
      // Mid-stream server error — the provider died after the HTTP 200 was
      // already committed (e.g. OpenRouter's "JSON error injected into SSE
      // stream" when an upstream endpoint crashes, load-sheds, or times out
      // — these can arrive even BEFORE the first token). When nothing
      // reached the consumer this attempt, the turn is fully replayable and a
      // fresh request re-enters the server's routing, so retry within the
      // same auto-continue budget. Once content or a tool call was reported,
      // a retry would duplicate or disconnect output (continuation mode is
      // vLLM-only) — rethrow and let the consumer report the partial turn
      // like before. `hadVisibleReasoning` joins them because a host without
      // a thinking part reports reasoning as TEXT, which is visible output
      // that a replay would duplicate; reasoning rendered as a real thinking
      // part is still discardable and retries, matching the empty-response
      // nudge, which tolerates shown-then-discarded thinking.
      const midStream = err instanceof Error && err.message.startsWith('Server error (mid-stream)');
      if (
        !midStream
        || outcome.hadContent
        || outcome.hadToolCalls
        || outcome.hadVisibleReasoning
        || signal.aborted
        || attempt >= maxRetries
      ) {
        throw err;
      }
      resetOutcome(outcome);
      log.appendLine(
        `[INFO] ${modelId}: server error mid-stream with no output - retrying (attempt ${attempt + 1}/${maxRetries + 1})`
      );
      continue;
    }

    // A normally-ended attempt that saw usage completes its record —
    // including a quiet cancellation after usage was seen. A stream throw
    // skipped this block (the record survives only completed attempts).
    if (pendingUsage) {
      const elapsedMs = Date.now() - state.attemptStartTime;
      const firstTokenTimeMs = outcome.firstTokenTime ?? null;
      const hasCacheDetails = !!pendingUsage.prompt_tokens_details;
      const hasMetrics = !!pendingMetrics;
      const lastRequest: LastRequestData = {
        serverUrl: serverConfig.serverUrl,
        modelId: limits.wireModelId,
        timestamp: Date.now(),
        promptTokens: pendingUsage.prompt_tokens,
        completionTokens: pendingUsage.completion_tokens,
        totalTokens: pendingUsage.total_tokens,
        cachedTokens: pendingUsage.prompt_tokens_details?.cached_tokens,
        createdCacheTokens: pendingUsage.prompt_tokens_details?.created_cache_tokens,
        reasoningTokens: pendingUsage.completion_tokens_details?.reasoning_tokens,
        actualCost: pendingUsage.cost ?? undefined,
        usedByok: pendingUsage.usedByok === true ? true : undefined,
        metrics: pendingMetrics,
        hasMetrics,
        hasCacheDetails,
        maxModelLen: limits.contextWindow ?? (limits.maxInputTokens + limits.maxOutputTokens),
        maxOutputTokens: limits.maxOutputTokens,
        firstTokenTimeMs,
        totalTimeMs: elapsedMs,
      };
      yield { attemptCompletion: { usage: pendingUsage, metrics: pendingMetrics, lastRequest, elapsedMs, firstTokenTimeMs } };
    }

    // Retry when the model stopped (finish_reason: stop) either with no content at all,
    // or mid-sentence on a trailing colon. Use the full buffer (not the last chunk) so a
    // trailing whitespace-only chunk can't hide the colon.
    //
    // `!outcome.hadToolCalls` guards the empty branch: a pure tool-call turn
    // (no text content, but a finalized tool call) is a COMPLETE turn, not a
    // failed one — `finish_reason: 'stop'` after a tool call is the OpenAI/vLLM
    // convention for "done, here's my tool call." Retrying would re-ask the
    // model after it already took a valid action. The colon branch is already
    // gated by `hadContent`, so `hadToolCalls` only matters for the empty case.
    //
    // `hadVisibleReasoning` closes the same hole the mid-stream gate closes:
    // on a host with no thinking part, reasoning is reported as ordinary text,
    // so `hadContent` is still false while the user is already looking at it.
    // Without this, a reasoning-only stop re-asks the model and prints the
    // same reasoning a second time. The empty-response nudge and the colon
    // continuation both assume the user has seen nothing, which is only true
    // for a genuine thinking part.
    if (signal.aborted) break;
    const endsWithColon = !!outcome.contentBuffer && outcome.contentBuffer.trimEnd().endsWith(':');
    // Colon-continuation retries are vLLM-only. Without vLLM's
    // continue_final_message the server cannot resume an open assistant turn —
    // for secondary backends a colon retry would drop the already-streamed text,
    // nudge with an empty assistant message, and produce a disjoint fresh answer
    // (or a reject). Empty-response nudges are backend-agnostic and stay.
    const shouldRetry = (!outcome.hadContent || (endsWithColon && serverConfig.serverType === 'vllm'))
      && !outcome.hadToolCalls
      && !outcome.hadVisibleReasoning
      && outcome.finishReason === 'stop'
      && attempt < maxRetries;
    if (!shouldRetry) break;

    // Grow the prefill: a colon-truncated reply continues from everything streamed so far.
    // Only for vLLM (true continuation mode). For secondary backends the partial text
    // must NOT be replayed as a completed assistant turn — the chat protocol strips the
    // continuation flags there, so the server would regenerate and duplicate output.
    // An empty response contributes nothing, keeping assistantPrefill empty (nudge mode).
    if (outcome.hadContent && serverConfig.serverType === 'vllm') {
      assistantPrefill += outcome.contentBuffer ?? '';
    }
    const prefillMessage: OpenAIChatMessage = { role: 'assistant', content: assistantPrefill };
    if (prefillIndex === -1) {
      openaiMessages.push(prefillMessage);
      prefillIndex = openaiMessages.length - 1;
    } else {
      openaiMessages[prefillIndex] = prefillMessage;
    }

    const reason = outcome.hadContent
      ? 'response ended with colon (incomplete sentence)'
      : 'empty response';
    const mode = assistantPrefill.length > 0 ? 'continuation' : 'prefill';
    resetOutcome(outcome);
    log.appendLine(
      `[INFO] ${modelId}: ${reason} - retrying with assistant ${mode} (attempt ${attempt + 1}/${maxRetries + 1})`
    );
  }
}
