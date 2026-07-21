# Auto-Continue: Implementation Plan

**Created:** 2026-06-24
**Updated:** 2026-06-24 (implementation complete, v0.9.0)
**Status:** ✅ Implemented, compiled, tests pass

---

## Ecosystem Research: Does This Exist Anywhere?

Searched across vLLM, OpenAI, LangChain, Microsoft AutoGen, and the broader ecosystem. Key findings:

### vLLM (server side)
**Nothing exists.** vLLM is an inference engine — it generates tokens until `finish_reason` triggers. It has no concept of "the response is incomplete, retry." The decision to retry belongs to the client. vLLM does have one related note in its Responses API serving code:

```python
# Skip empty string input when previous_input_messages supplies
# the full conversation history --- an empty trailing user message
# confuses the model into thinking nothing was sent.
```

This is the opposite problem — vLLM warns against empty user messages confusing the model. Our approach (empty assistant prefill) is a different pattern and not addressed by vLLM.

### OpenAI (API / docs)
**Assistant prefill is documented and supported.** Ending the `messages` array with a partial `assistant` message causes the model to continue from that prefix. This is the well-known mechanism we're leveraging. However, OpenAI has no documented pattern for *automatically* retrying empty responses — their platform rarely produces empty responses in the first place (the problem is local/self-hosted models).

### LangChain
**Nothing.** No auto-retry on empty responses. LangChain has generic retry decorators for transient errors (network, rate limits) but no logic for detecting or recovering from semantically incomplete model outputs (thinking with no answer).

### Microsoft AutoGen
**Nothing.** AutoGen handles multi-agent conversation orchestration and tool loops, but has no mechanism for detecting empty responses or auto-continuing within a single agent turn.

### Conclusion
**This pattern does not exist in the ecosystem.** The combination of (1) detecting an empty response after reasoning and (2) auto-retrying with assistant prefill is novel. The building blocks exist separately (assistant prefill in OpenAI API, reasoning parsers in vLLM), but no one has wired them together for this use case. This makes sense — the problem is specific to local self-hosted reasoning models where the thinking/output split can misfire.

---

## Problem

The extension frequently receives empty responses from the model in two distinct but related scenarios:

1. **Thinking → stop:** The model produces reasoning/thinking tokens, then `finish_reason: stop`, and zero text content. The model thought but did not answer.

2. **Tool result → thinking → stop:** After Copilot executes tool calls and sends results back in a new turn, the model again produces only reasoning and no text response.

These are unambiguously incomplete. The current handling is:

- Scenario 1: Shows a `⚠️` warning message to the user ("model produced only reasoning tokens — try again").
- Scenario 2: Emits a `\n` to avoid the VS Code "no response returned" error popup. Silent, invisible to the user.

Both are workarounds. Neither helps the user get an actual response.

A third "empty" case exists — model produces nothing at all (no reasoning, no content, no tool calls) — but this indicates a server/configuration issue, not an incomplete response. Auto-continue does not apply there.

---

## Proposed Solution

When an empty response is detected in scenarios 1 or 2, automatically retry the request up to `autoContinueRetries` times using **assistant prefill**: append the partial assistant turn (empty content) to the message history and re-send to vLLM. The model is then in its own response turn and should generate content.

This all happens within a single `provideLanguageModelChatResponse` call, invisible to Copilot. The `progress` reporter is shared across both attempts, so Copilot sees one continuous stream.

This is a well-established pattern in the OpenAI Chat Completions API (and vLLM's implementation): ending the `messages` array with a partial `assistant` message causes the model to continue completing it, rather than starting fresh.

---

## Retry Count

- Default is `1`. Most transient empty responses resolve on the first retry.
- User can increase if their model is particularly prone to empty responses, or set to `0` to disable entirely.
- Each retry adds a full round-trip: resending the entire message history plus vLLM thinking time. On slow models this is expensive.

---

## Trigger Conditions

Auto-continue fires when ALL of the following are true after `consumeStream` returns:

```
(!hadContent || endsWithColon)      // no content at all, OR content ends with ':' (truncated mid-sentence)
&& finishReason === 'stop'          // model explicitly chose to stop
&& autoContinueRetries > 0          // per-model setting, default 1
&& currentAttempt < autoContinueRetries
```

Note: `!hadToolCalls` is redundant — if the model produced tool calls, `finishReason` would be `tool_calls`, not `stop`. So `finishReason === 'stop'` already guarantees no tool calls in this response.

This covers both scenario 1 (reasoning with no answer) and scenario 2 (tool result received, model says nothing). It excludes `content_filter` (blocked), `length` (token limit — different fix), and `null`/missing finish reason (stream ended abnormally — connection issue).

Two distinct triggers, each with its own request shape:

1. **Empty response** (no content): retry with an empty `assistant` prefill under the default chat-template flags. vLLM starts a fresh assistant turn — a harmless "nudge" since nothing was streamed yet.

2. **Truncated mid-sentence** (content ends with `:`): genuinely CONTINUE the text already streamed. Uses vLLM's continuation mode (`continue_final_message: true`, `add_generation_prompt: false`) so the model resumes the open assistant message and returns only NEW tokens. Without it, vLLM closes the prefill as a finished turn and regenerates — duplicating what Copilot already saw.

---

## Setting

A per-model integer in `vllm-copilot.models`: `autoContinueRetries`, default `1`.

- `0` = disabled. Behavior reverts exactly to current: warning message or `\n` hack.
- `n` = up to n retry attempts using assistant prefill before giving up.
- Resolved via `resolveModelSettings()` which reads the per-model value against `DEFAULT_MODEL_SETTINGS.autoContinueRetries`.

---

## Mechanism: Assistant Prefill

The retry loop lives inside `provideLanguageModelChatResponse` as a `for` loop from `attempt = 0` to `attempt <= maxRetries`:

1. **First iteration (attempt 0):** Normal request — no special handling.
2. **Subsequent iterations:** Before each retry, append `{role: 'assistant', content: ''}` to `openaiMessages`, call `resetOutcome()` to zero all `StreamOutcome` fields, and log the retry to the output channel.
3. After each `consumeStream`, check trigger: `!hadContent && finishReason === 'stop' && attempt < maxRetries`. If true, loop continues. If false, break.
4. After the loop exits (success or exhaustion), run `reportPostStreamDiagnostics` with `maxRetries` so it knows how many attempts were made.
5. `resetOutcome()` is a private helper that resets all mutable fields on the shared `StreamOutcome` object.

Key design decisions:
- No changes to `consumeStream` — keeping it simple. No accumulated text tracking needed for the current use case (would only be needed for future `finish_reason: length` extension).
- `reportPostStreamDiagnostics` receives `maxRetries` to format attempt counts in diagnostics.
- Tool-result empty case always emits the `\n` hack regardless of retry count (the model is genuinely done; retries were just a nudge).

---

## Implementation

### `src/config.ts`
- Added `autoContinueRetries: number` to `ModelConfig` interface (per-model).
- Resolved via `resolveModelSettings()` against `DEFAULT_MODEL_SETTINGS.autoContinueRetries` (default `1`).

### `package.json`
- Configuration is now per-model within `vllm-copilot.models`:
  ```json
  "autoContinueRetries": {
    "type": "number",
    "default": 1,
    "markdownDescription": "How many times to automatically retry when the model returns an empty or truncated response..."
  }
  ```

### `src/provider.ts`

**`provideLanguageModelChatResponse`:**
- `openaiMessages` built once via `buildRequest`, then mutated in-place by retry loop.
- `for (let attempt = 0; attempt <= maxRetries; attempt++)` wraps the stream call.
- On retry: push prefill message, reset outcome, log attempt number.
- Break on first non-empty response or when `attempt >= maxRetries`.

**`resetOutcome`:** New private method that resets all `StreamOutcome` mutable fields to initial state.

**`reportPostStreamDiagnostics`:** Now receives `maxRetries` parameter. Two paths:
1. **Tool-result empty case:** Always emits `\n` hack (model is done). Log shows attempt count if retries occurred.
2. **Genuine empty response:** Single diagnostic line. Attempt count folded into the message when `totalAttempts > 1`. ⚠️ warning in chat with contextual hint.

---

## Logging

The output channel should clearly indicate each retry:

```
[INFO] qwen3-27b: empty response after reasoning — retrying with assistant prefill (attempt 2/3)
[INFO] qwen3-27b: empty response after reasoning — retrying with assistant prefill (attempt 3/3)
[WARN] qwen3-27b: empty response after 3 attempts — giving up. Check model configuration.
```

The `⚠️` warning message in chat only fires after all retries are exhausted. If any retry produces content, the user sees only the content — no indication a retry occurred (it is transparent).

---

## What Stays the Same

- **`isEmptyStopAfterTool` detection** — The `\n` hack always fires for tool-result empty responses regardless of retry count. Auto-continue tries harder first, but if still empty, silently passes.
- **Server error case** (no reasoning, not after tool, not length/filter) — no change, still shows the diagnostic warning immediately.
- **`finish_reason: length` with partial content** — no change, still shows the truncation warning. Auto-continue for this case is deferred (would need token budget recalculation, different problem).
- **`consumeStream`** — unchanged. No accumulated text tracking needed for current scope.

---

## What This Does Not Solve

- **Stop mid-sentence:** `finish_reason: stop` with some content that "looks" incomplete. Not detectable without heuristics. Requires a manual user-triggered "Continue" command (separate feature).
- **Persistent reasoning loops:** If a model consistently thinks and produces nothing, retries won't fix it. The root cause is model configuration (thinking token budget too low, wrong reasoning parser, model mode mismatch). Auto-continue buys a few more chances; after exhausting retries, the diagnostic message should guide the user.
- **Tool-call continuation within a turn:** If the model stops after making tool calls, Copilot executes the tools and calls us again in a new turn. That is handled by the existing flow, not by auto-continue.
