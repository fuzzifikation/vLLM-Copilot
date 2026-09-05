# Auto-Continue

Auto-continue recovers from **empty or truncated model responses** automatically. When a model thinks but produces no answer - or stops mid-sentence on a trailing colon - the extension retries the request up to `autoContinueRetries` times using assistant prefill / vLLM continuation, so you get a real response instead of a blank one. Shipped and on by default (`autoContinueRetries` defaults to `1`).

---

## What it fixes

Some models - most notably Qwen-family reasoning models - occasionally return an incomplete response:

1. **Thinking → stop:** the model produces reasoning tokens, then `finish_reason: stop` with zero text content. It thought, but never answered.
2. **Tool result → thinking → stop:** after Copilot executes tool calls and sends results back in a new turn, the model again produces only reasoning and no text response.

Without auto-continue these would surface as a ⚠️ "model produced only reasoning tokens" warning (or a silent `\n` to dodge VS Code's "no response returned" popup). With it, the extension retries transparently and you get your answer.

A third "empty" case - the model produces nothing at all (no reasoning, no content, no tool calls) - usually indicates a server/configuration problem rather than an incomplete response. Auto-continue still retries it (same trigger, same budget) as cheap insurance against a transient hiccup; if it stays empty, the budget runs out and the ⚠️ diagnostic reports it as "empty response after N attempt(s)".

---

## How it works

### Trigger conditions

Auto-continue fires when **all** of the following hold after the stream completes:

```
(!hadContent || (endsWithColon && serverType === 'vllm'))   // no content, OR ends with ':' on vLLM (truncated mid-sentence)
&& finishReason === 'stop'          // model explicitly chose to stop
&& !hadToolCalls                    // a pure tool-call turn is complete - never retried
&& attempt < maxRetries             // still have budget (maxRetries = autoContinueRetries)
```

The `!hadToolCalls` guard is deliberate, not redundant: in the OpenAI/vLLM convention, `finish_reason: 'stop'` *after* a tool call means "done, here's my tool call" - a pure tool-call turn is a complete turn and must not be retried.

Excluded by design: `content_filter` (blocked content), `finish_reason: 'length'` (token limit - different fix, still shows the truncation warning), and a null/missing finish reason (abnormal stream end - connection issue).

### Two retry shapes

1. **Empty response** (no content): retried with an **empty assistant prefill** (`{role: 'assistant', content: ''}`) under the default chat-template flags - a harmless "nudge" since nothing was streamed yet. Works on every backend.
2. **Truncated mid-sentence** (content ends with `:`): genuinely **continues** the already-streamed text. The full buffered content becomes the assistant prefill and the request goes out in vLLM **continuation mode** (`continue_final_message: true`, `add_generation_prompt: false`), so the model resumes the open assistant message and returns only NEW tokens. Without it, vLLM would close the prefill as a finished turn and regenerate - duplicating what Copilot already saw.

Colon-continuation retries are **vLLM-only**: `continue_final_message` is what lets the server resume an open assistant turn. Secondary backends (llama.cpp, LM Studio, Ollama, OpenRouter) always retry empty-style - a colon retry there would drop the already-streamed text, nudge with an empty message, and produce a disjoint fresh answer (or a reject). Empty-response nudges are backend-agnostic.

---

## Configuration

A per-model integer in `vllm-copilot.models`:

```json
"autoContinueRetries": 1
```

- `0` = disabled (behavior reverts to the ⚠️ warning / `\n` fallback).
- `n` = up to `n` retry attempts using assistant prefill/continuation before giving up.
- Default `1` - most transient empty responses resolve on the first retry.

Each retry is a full round-trip: the entire message history is re-sent plus the model's thinking time. On slow models this is expensive, so raise it only if your model is especially prone to empty responses. Negative or fractional values are rejected by config validation (must be a finite integer ≥ 0).

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

- **Retry loop:** `runChatResponse` in `src/provider/streamOrchestrator.ts` - a `for` loop from `attempt = 0` to `attempt <= maxRetries`. Iteration 0 is the normal request; each subsequent iteration appends the (growing) assistant prefill to `openaiMessages`, calls `resetOutcome()` (in `src/provider/outcome.ts`) to zero all `StreamOutcome` fields, and logs the retry.
- **Continuation flags:** vLLM-only; injected into the request body in `streamOrchestrator.ts` (`continue_final_message: true`, `add_generation_prompt: false`) and stripped for non-vLLM backends in `src/provider/chatProtocol.ts`.
- **Config:** `autoContinueRetries` on `ModelConfig` (`src/config.ts`), resolved by `resolveModelSettings()` against `DEFAULT_MODEL_SETTINGS.autoContinueRetries` (default `1`), floored and validated (finite integer ≥ 0). Schema declared per-model in `package.json`.
- **Diagnostics:** `reportPostStreamDiagnostics` in `src/provider/postStream.ts` receives `actualAttempts` to fold attempt counts into user-facing hints.
- **Tests:** `test/providerAutoContinue.test.ts` (empty-prefill nudge, colon continuation, non-vLLM colon no-op, no-retry-on-length, budget exhaustion).

---

## Known limitations

- **Stop mid-sentence with plausible content:** `finish_reason: stop` with content that merely *looks* incomplete isn't detectable without heuristics; a manual "Continue" command is a separate, unimplemented feature.
- **Persistent reasoning loops:** if a model consistently thinks and produces nothing, retries won't fix it - the root cause is model configuration (thinking token budget too low, wrong reasoning parser, mode mismatch). Auto-continue buys a few more chances; after exhaustion, the diagnostic message guides you.
- **Tool-call continuation within a turn:** a model stopping after tool calls is a *complete* turn. Copilot executes the tools and starts a new turn, which the existing flow handles - not auto-continue.
- **`finish_reason: length` with partial content:** still shows the truncation warning; auto-continue deliberately does not cover this (would need token-budget recalculation).

**Related:** [Manual → Reliability & tooling](manual.md) · [README](https://github.com/fuzzifikation/vLLM-Copilot/blob/main/README.md).
