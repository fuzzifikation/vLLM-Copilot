/**
 * SSE stream reader with inactivity timeout.
 *
 * Uses `eventsource-parser` (same library as Vercel AI SDK) for robust,
 * spec-compliant SSE line parsing — chunk boundaries, comment handling,
 * field validation. Our `sseParser.ts` handles vLLM-specific JSON parsing
 * and tool call accumulation on top.
 */

import * as vscode from 'vscode';
import { processSSEChunk, finalizePendingToolCalls, type PendingToolCall } from './sseParser.js';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import type { StreamEvent } from '../types.js';
import type { FileLogger } from '../shared/logger.js';

interface StreamReaderOptions {
  /** Inactivity timeout in ms. 0 = disabled (wait indefinitely). */
  inactivityMs: number;
  /** File logger for stream chunk logging. Optional. */
  fileLogger?: FileLogger;
  /** Output channel for user-visible SSE parse warnings. Optional. */
  output?: vscode.OutputChannel;
}

/**
 * Normalize SSE data for eventsource-parser.
 *
 * eventsource-parser follows the W3C SSE spec strictly — it requires an empty
 * line (\n\n) to mark the end of an event. OpenAI/vLLM servers send each
 * "data:" line followed by a single \n, without empty lines between events.
 * This prepends \n before each "data:" line to create proper event boundaries.
 */
function normalizeSSE(text: string): string {
  return text.replace(/^data:/gm, '\ndata:');
}

/**
 * Read and parse an SSE stream, yielding structured StreamEvents.
 *
 * Inactivity timeout is measured by the time between successive `read()` calls
 * returning data — not by wall-clock time. This means the timeout is unaffected
 * by generator pauses (yields) during tool execution, which can last minutes.
 *
 * @param reader - ReadableStream reader (from response.body.getReader())
 * @param token - Cancellation token
 * @param options - StreamReader options
 */
export async function* readSseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  token: vscode.CancellationToken,
  options: StreamReaderOptions
): AsyncGenerator<StreamEvent> {
  const { inactivityMs, fileLogger, output } = options;
  const pendingToolCalls = new Map<number, PendingToolCall>();
  let contentChunks = 0;

  // Wire cancellation directly to reader.cancel() so the HTTP stream is torn
  // down immediately. While AbortSignal can cancel the body stream in modern
  // Node/undici, reader.cancel() is a more direct path that guarantees the
  // reader is released and the underlying source is told to stop producing
  // data. This also works as a cleanup in the finally block regardless of
  // whether the reader is already closed or errored.
  const disposeCancel = token.onCancellationRequested(() => {
    reader.cancel(new Error('Request cancelled by user')).catch(() => {});
  });

  // ── SSE parsing via eventsource-parser ─────────────────────────────
  // eventsource-parser handles all SSE protocol mechanics: chunk boundaries,
  // "data:" prefix stripping, comment lines, field validation. We collect
  // parsed events in a queue and yield them from the generator.
  const eventQueue: StreamEvent[] = [];
  let streamDone = false;
  let streamError: Error | undefined;

  const parser = createParser({
    onEvent: (msg: EventSourceMessage) => {
      const data = msg.data.trim();

      // [DONE] — finalize any pending tool calls (belt-and-suspenders)
      if (data === '[DONE]') {
        const remaining = finalizePendingToolCalls(pendingToolCalls);
        if (remaining.length > 0) {
          eventQueue.push({
            content: '',
            finishedToolCalls: remaining,
          });
        }
        streamDone = true;
        return;
      }

      // Parse the vLLM-specific JSON payload
      const event = processSSEChunk(data, pendingToolCalls);
      if (event === null) return;

      // Server error mid-stream — surface immediately
      if (event.error) {
        // No backend-specific wording (formatError classifies this marker for ANY backend).
        streamError = new Error(`Server error (mid-stream): ${event.error}`);
        streamDone = true;
        return;
      }

      eventQueue.push(event);

      if (event.content || event.reasoning_content || event.finishedToolCalls.length > 0) {
        contentChunks++;
        fileLogger?.logStreamChunk(contentChunks, event.content, event.finishedToolCalls, event.reasoning_content);
      }
    },
    onError: (err) => {
      // Parse errors from eventsource-parser (malformed SSE). Log to the output
      // channel (user-visible) and continue — never hide them in the extension
      // host console only.
      const msg = `SSE parse error: ${err instanceof Error ? err.message : String(err)}`;
      output?.appendLine(`[WARN] ${msg}`);
      console.warn(msg);
    },
  });

  /**
   * Helper generator that yields all currently queued events, then checks for
   * stream-level errors and completion. Returns `true` once the stream reached
   * its natural end (`[DONE]` marker or server error), so the read loop can
   * break out; stream errors are thrown and propagate. Callers only need
   * `if (yield* drainAndCheck()) break;` — no per-site try/catch. This
   * consolidates the four near-identical drain sites into one so a future
   * edit cannot diverge one site from the others.
   */
  function* drainAndCheck(): Generator<StreamEvent, boolean> {
    while (eventQueue.length > 0) {
      yield eventQueue.shift()!;
    }
    if (streamError) throw streamError;
    return streamDone;
  }
  try {
    const decoder = new TextDecoder();

    while (true) {
      if (token.isCancellationRequested) {
        break;
      }

      // Drain any events queued by the parser callback, check error/done
      if (yield* drainAndCheck()) break;

      // ── Read next chunk with timeout ────────────────────────────────
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        if (inactivityMs > 0) {
          // Race reader.read() against a live inactivity timer. This correctly
          // detects stalled streams regardless of how long a single read() blocks
          // (e.g. 10-min TTFT on DeepSeek). The post-hoc approach (measuring how
          // long read() took after it returned) would false-fire on slow TTFT:
          // read() blocks silently for 10 min, returns the first token, then the
          // check immediately kills the stream because idleMs > inactivityMs.
          let timeoutId: ReturnType<typeof setTimeout>;
          const readPromise = reader.read();
          const timeoutPromise = new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => {
              reader.cancel().catch(() => {});
              reject(new Error(`Stream inactivity timeout (${inactivityMs}ms without data)`));
            }, inactivityMs);
          });
          let result: Awaited<typeof readPromise>;
          try {
            result = await Promise.race([readPromise, timeoutPromise]);
          } finally {
            clearTimeout(timeoutId!);
            // If the timeout won the race, reader.cancel() was called above and
            // readPromise will eventually reject. Suppress that to avoid an
            // unhandled-rejection warning.
            readPromise.catch(() => {});
          }
          done = result.done;
          value = result.value;
        } else {
          const result = await reader.read();
          done = result.done;
          value = result.value;
        }
      } catch (err) {
        // The cancellation token triggers reader.cancel() above. Per the WHATWG
        // Streams spec, cancel() FULFILLS a pending read() with { done: true }
        // — it does NOT reject (only abort() does), so the loop normally exits
        // via the done path, not here. A rejection arriving with cancellation
        // already requested is an underlying stream error racing the cancel:
        // tear down quietly via break instead of propagating to the provider.
        // (Do not "fix" this by switching to abort() — it would start rejecting
        // politely-closed reads.)
        if (token.isCancellationRequested) break;
        // Re-throw inactivity timeouts directly — they already have a descriptive message.
        if (err instanceof Error && err.message.startsWith('Stream inactivity timeout')) {
          throw err;
        }
        // Distinguish ERR_STREAM_PREMATURE_CLOSE — a network drop or reverse proxy
        // (Cloudflare, nginx, corporate gateway) closed the response body mid-stream.
        // Surface a specific message instead of wrapping as a generic "stream error"
        // so formatError can map it to an actionable explanation. The error's `.code`
        // is lost when wrapping, so match on the message text too as a fallback.
        const errCode = (err as { code?: unknown })?.code;
        const rawMsg = err instanceof Error ? err.message : String(err);
        if (errCode === 'ERR_STREAM_PREMATURE_CLOSE' || rawMsg === 'Premature close') {
          throw new Error('Connection closed prematurely by the network or a reverse proxy');
        }
        // undici's `TypeError: terminated` fires when something calls
        // .terminate() on the response stream — always an INTENTIONAL action.
        // VS Code's internal fetch does exactly this after reading files during
        // tool orchestration (no cancellation token fired), and postStream's
        // isGracefulTermination() matches this exact name + message to log the
        // turn quietly. Wrapping it here destroyed that evidence and turned a
        // normal cancel into a scary proxy error, so pass the original error
        // through untouched. Genuine network kills surface as
        // ERR_STREAM_PREMATURE_CLOSE / "Premature close", handled above.
        if (rawMsg === 'terminated') {
          throw err instanceof Error ? err : new Error(rawMsg);
        }
        throw new Error(`Stream error during read: ${rawMsg}`);
      }

      // Decode and feed to parser. Normalize SSE format so eventsource-parser
      // sees proper event boundaries (\n\n between events) instead of vLLM's
      // single-\n format.
      if (value && value.length > 0) {
        const chunkText = decoder.decode(value, { stream: !done });
        if (chunkText) {
          parser.feed(normalizeSSE(chunkText));
        }
      }

      // Yield events from this chunk (parser.onEvent fires synchronously)
      if (yield* drainAndCheck()) break;

      if (done) {
        // Flush any buffered event that lacked a trailing \n\n.
        // Feed two newlines: one to terminate the current line (if it lacks \n),
        // one more to create the empty line that triggers event dispatch.
        parser.feed('\n\n');
        yield* drainAndCheck();
        break;
      }
    }

    // Drain any remaining events. A stream error propagates (thrown); reaching
    // the natural end just falls through to the belt-and-suspenders below.
    yield* drainAndCheck();

    // Belt-and-suspenders: if the stream ended without [DONE] or finish_reason,
    // finalize any pending tool calls (e.g., reverse proxy closed connection).
    const remainingOnDone = finalizePendingToolCalls(pendingToolCalls);
    if (remainingOnDone.length > 0) {
      yield {
        content: '',
        finishedToolCalls: remainingOnDone,
      };
    }
  } finally {
    disposeCancel.dispose();
    reader.cancel().catch(() => {});
  }
}