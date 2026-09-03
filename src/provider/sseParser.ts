/**
 * Pure SSE stream parsing utilities.
 * Only depends on the pure error-envelope helper — fully unit-testable.
 *
 * These functions handle the stateful (but pure) transformation of raw SSE data lines
 * into structured StreamEvents, including incremental tool call accumulation.
 */

import { serverErrorMessage } from '../shared/errorEnvelope.js';
import type { StreamEvent, FinalizedToolCall, WireChunk, WireUsage } from '../types.js';

export type PendingToolCall = { id: string; name: string; args: string };

/**
 * Process a single SSE data line (the JSON string after "data: ").
 *
 * @param data - Raw JSON string from "data: <json>" SSE line
 * @param pendingToolCalls - Mutable map of in-progress tool calls (keyed by index).
 *   This function accumulates deltas into it and clears it on finalization.
 * @returns A StreamEvent, or null if the line produces no meaningful output
 *   (malformed JSON, empty chunk, etc.)
 */
export function processSSEChunk(
  data: string,
  pendingToolCalls: Map<number, PendingToolCall>
): StreamEvent | null {
  let parsed: WireChunk;
  try {
    parsed = JSON.parse(data) as WireChunk;
  } catch {
    return null; // skip malformed SSE lines
  }

  const event: StreamEvent = {
    content: '',
    finishedToolCalls: [],
  };

  // Server-reported error embedded in the stream (e.g. {"error": {"message": "..."}}).
  // vLLM emits this when it aborts a request mid-stream (context too long, bad params,
  // OOM, etc.). Without this branch the chunk has no `choices`/`usage` and would be
  // dropped as null, leaving the user with an empty response and no reason.
  // OpenRouter nests the real provider reason under `error.metadata.raw` with a
  // terse `message` stub — walk the whole envelope so the real reason surfaces.
  if (parsed.error) {
    event.error = serverErrorMessage(parsed.error)
      ?? (typeof parsed.error === 'object' ? JSON.stringify(parsed.error) : String(parsed.error));
    return event;
  }

  const choice = parsed.choices?.[0];

  if (parsed.usage) {
    // OpenRouter sends the BYOK flag as `is_byok`; the wire type carries it as
    // `usedByok` (distinct from VS Code's `isBYOK` — see types.ts). Remap so the
    // rest of the pipeline reads one name AND the raw wire name doesn't leak
    // into logs (the file logger stringifies the usage object). Non-OpenRouter
    // chunks have no field, so this is a no-op for vLLM/local.
    const rawUsage = parsed.usage as WireUsage & { is_byok?: boolean };
    if (rawUsage.is_byok !== undefined) {
      const { is_byok: _raw, ...rest } = rawUsage;
      event.usage = { ...rest, usedByok: rawUsage.is_byok };
    } else {
      event.usage = rawUsage;
    }
  }
  if (parsed.metrics) event.metrics = parsed.metrics;

  // Usage-only chunk (empty choices array) — final stats from vLLM
  if (!choice) {
    return (event.usage || event.metrics) ? event : null;
  }

  const delta = choice.delta;

  // --- Delta format (streaming) ---
  if (delta) {
    if (delta.content) {
      event.content = delta.content;
    }

    // vLLM streams reasoning as `delta.reasoning`; llama.cpp & LM Studio use
    // `delta.reasoning_content`. Read both so third-party reasoning isn't dropped.
    // Additive — vLLM's path is unchanged.
    const reasoning = delta.reasoning ?? delta.reasoning_content;
    if (reasoning) {
      event.reasoning_content = reasoning;
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx: number = tc.index ?? 0;

        let pending = pendingToolCalls.get(idx);
        if (!pending) {
          pending = { id: '', name: '', args: '' };
          pendingToolCalls.set(idx, pending);
        }

        if (tc.id) pending.id = tc.id;
        if (tc.function?.name) pending.name = tc.function.name;
        if (tc.function?.arguments) pending.args += tc.function.arguments;
      }
    }
  }

  // Capture the finish reason for every terminal value (including `content_filter`)
  // so the caller can explain to the user why generation stopped. Tool calls are only
  // finalized for the reasons that actually conclude a normal/truncated generation.
  if (choice.finish_reason) {
    event.finishReason = choice.finish_reason;
    if (
      choice.finish_reason === 'tool_calls' ||
      choice.finish_reason === 'stop' ||
      choice.finish_reason === 'length'
    ) {
      event.finishedToolCalls = finalizePendingToolCalls(pendingToolCalls);
    }
  }

  return event;
}

/**
 * Drain all accumulated pending tool calls into finalized objects and clear the map.
 * Only includes entries that have a name (guards against partial/corrupt deltas).
 *
 * Note: the synthesized id (when the server sends none) uses a nonce suffix so
 * multiple id-less calls don't collide on the empty-string key in the provider's
 * de-dup set. This makes the function non-deterministic for id-less input — it
 * remains deterministic (and unit-testable) whenever ids are present.
 */
export function finalizePendingToolCalls(
  pending: Map<number, PendingToolCall>
): FinalizedToolCall[] {
  const result: FinalizedToolCall[] = [];
  for (const [idx, tc] of pending) {
    if (tc.name) {
      const id = tc.id || `call_${idx}_${tc.name}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      result.push({ id, name: tc.name, arguments: tc.args || '{}' });
    }
  }
  pending.clear();
  return result;
}
