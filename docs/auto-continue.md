# Auto-Continue

Auto-continue retries **empty or truncated model responses and replayable early stream failures**. Empty and truncated responses use assistant prefill or vLLM continuation; an early server error replays the original request. All three share the per-model `autoContinueRetries` budget. A retry is best-effort and cannot guarantee a complete or correct answer. Shipped and on by default (`autoContinueRetries` defaults to `1`).

---

## What it fixes

Auto-continue handles four observable failure cases:

1. **Thinking → stop:** the model produces reasoning tokens, then `finish_reason: stop` with zero answer text. It thought, but never answered.
2. **Tool result → thinking → stop:** after Copilot executes tool calls and sends results back in a new turn, the model again produces only reasoning and no answer text.
3. **Completely empty response:** the model emits no reasoning, answer text, or tool calls. This often indicates a server or configuration problem, but one replay is still useful insurance against a transient failure.
4. **Mid-stream server error before committed output:** the provider returns HTTP 200, then emits an SSE error before any answer text or finalized tool call reaches Copilot. This includes OpenRouter's "JSON error injected into SSE stream" errors after an upstream endpoint crashes, load-sheds, or times out.

The first two otherwise surface as a ⚠️ "model produced only reasoning tokens" warning (or a silent `\n` to avoid VS Code's "no response returned" popup). The fourth otherwise fails the turn immediately. All are retried transparently within the same budget.

A retry is attempted only while no answer text or tool call has reached Copilot. Reasoning-only output is still considered replayable because no answer or action has been committed. Once answer text or a tool call has been reported, retrying could duplicate or disconnect output, so the partial turn stands and the error surfaces normally.

---

## How it works

### Trigger conditions

For a normally completed model stream, auto-continue fires when **all** of the following hold:

```
(!hadContent || (endsWithColon && serverType === 'vllm'))   // no answer text, OR ends with ':' on vLLM (truncated mid-sentence)
&& finishReason === 'stop'          // model explicitly chose to stop
&& !hadToolCalls                    // a pure tool-call turn is complete - never retried
&& attempt < maxRetries             // still have budget (maxRetries = autoContinueRetries)
```

The `!hadToolCalls` guard is deliberate, not redundant: in the OpenAI/vLLM convention, `finish_reason: 'stop'` *after* a tool call means "done, here's my tool call" - a pure tool-call turn is a complete turn and must not be retried.

An explicitly recognized mid-stream server error is handled separately while consuming the stream: it retries when no answer text or finalized tool call has reached Copilot, the user has not cancelled, and budget remains. A normally completed stream excluded by design is `content_filter` (blocked content) or `finish_reason: 'length'` (token limit - different fix, still shows the truncation warning). A null/missing finish reason without a recognized server error is treated as an abnormal stream end and is not auto-retried.

### Three retry shapes

1. **Empty response** (no answer text): retried with an **empty assistant prefill** (`{role: 'assistant', content: ''}`) under the default chat-template flags - a harmless "nudge" since no answer or tool call reached Copilot. Works on every backend.
2. **Truncated mid-sentence** (answer text ends with `:`): genuinely **continues** the already-streamed text on vLLM. The full buffered content becomes the assistant prefill and the request goes out in **continuation mode** (`continue_final_message: true`, `add_generation_prompt: false`), so the model resumes the open assistant message and returns only NEW tokens. Without it, vLLM would close the prefill as a finished turn and regenerate - duplicating what Copilot already saw.
3. **Early mid-stream server error:** replays the identical request shape with no prefill or continuation flags. This is backend-agnostic because the original request never committed an answer or tool call.

Colon-continuation retries are **vLLM-only**: `continue_final_message` is what lets the server resume an open assistant turn. Secondary backends (llama.cpp, LM Studio, Ollama, OpenRouter) do not retry a non-empty colon-ending response; doing so would drop the visible text or produce a disjoint answer. Empty-response nudges and same-request replays are backend-agnostic.

---

## Configuration

A per-model integer in `vllm-copilot.models`:

```json
"autoContinueRetries": 1
```

- `0` = disabled for all three retry shapes (incomplete responses retain the ⚠️ warning / `\n` fallback; early server errors surface immediately).
- `n` = up to `n` retries using the request shape appropriate to the failure.
- Default `1` - most transient incomplete responses and early provider failures resolve on the first retry.

Each retry is a full round-trip: the entire message history is re-sent plus the model's thinking time. On slow models this is expensive, so raise it only if your model is especially prone to incomplete responses or early provider failures. Negative or fractional values are rejected by config validation (must be a finite integer ≥ 0).

---

## What you see

Retries are transparent. If any attempt produces content, you see only that content - no indication a retry happened. The ⚠️ warning appears only after **all** retries are exhausted. The output channel shows the retry log:

```
[INFO] qwen3-27b: empty response - retrying with assistant prefill (attempt 2/3)
[INFO] qwen3-27b: response ended with colon (incomplete sentence) - retrying with assistant continuation (attempt 3/3)
[WARN] qwen3-27b: empty response after 3 attempts - giving up. Check model configuration.
```

Post-stream diagnostics receive the actual attempt count, so the failure message tells you how many attempts were made.

---

## Implementation

- **Retry loop:** `runChatResponse` in `src/provider/streamOrchestrator.ts` - a `for` loop from `attempt = 0` to `attempt <= maxRetries`. Iteration 0 is the normal request. Empty/continuation retries update the assistant prefill before the next attempt; an early server-error retry keeps the request unchanged. Every retry resets the per-attempt `StreamOutcome` while preserving the request-wide fact that output was previously visible.
- **Continuation flags:** vLLM-only; injected into the request body in `streamOrchestrator.ts` (`continue_final_message: true`, `add_generation_prompt: false`) and stripped for non-vLLM backends in `src/provider/chatProtocol.ts`.
- **Config:** `autoContinueRetries` on `ModelConfig` in `src/state/config.ts`, resolved by `resolveModelSettings()` against `DEFAULT_MODEL_SETTINGS.autoContinueRetries` (default `1`), floored and validated (finite integer ≥ 0). Schema declared per-model in `package.json` and `schemas/vllm-copilot-models.schema.json`.
- **Diagnostics:** `reportPostStreamDiagnostics` in `src/provider/postStream.ts` receives `actualAttempts` to fold attempt counts into user-facing hints.
- **Tests:** `test/providerAutoContinue.test.ts` covers empty-prefill nudges, vLLM colon continuation, non-vLLM colon no-ops, retry-disabled behavior, same-shape mid-stream replay before committed output, and no replay after answer text.

---

## Known limitations

- **Stop mid-sentence with plausible content:** `finish_reason: stop` with content that merely *looks* incomplete isn't detectable without heuristics; a manual "Continue" command is a separate, unimplemented feature.
- **Persistent reasoning loops:** if a model consistently thinks and produces nothing, retries won't fix it - the root cause is model configuration (thinking token budget too low, wrong reasoning parser, mode mismatch). Auto-continue buys a few more chances; after exhaustion, the diagnostic message guides you.
- **Tool-call continuation within a turn:** a model stopping after tool calls is a *complete* turn. Copilot executes the tools and starts a new turn, which the existing flow handles - not auto-continue.
- **`finish_reason: length` with partial content:** still shows the truncation warning; auto-continue deliberately does not cover this (would need token-budget recalculation).

**Related:** [Manual → Reliability & tooling](manual.md) · [README](https://github.com/fuzzifikation/vLLM-Copilot/blob/main/README.md).
