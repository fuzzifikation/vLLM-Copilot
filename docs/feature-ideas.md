# Feature Ideas: vLLM Capabilities → Better VS Code Experience

**Generated:** 2026-06-06
**Updated:** 2026-07-21 (consolidated; shipped items removed or marked done)
**Source:** [vLLM SamplingParams API Reference](https://docs.vllm.ai/en/latest/api/vllm/sampling_params.html)

**Context:** vLLM supports many per-request sampling parameters that the extension doesn't expose yet. These represent opportunities to build features that VS Code's built-in Copilot doesn't have — making vLLM-Copilot the superior local model integration.

> **Tracking:** Only two docs are maintained: this file (new ideas) and [known-bugs.md](../known-bugs.md) (real bugs and nice-to-have refactors). There is no consolidated roadmap.

---

## The Moat: What Makes This Extension Irreplaceable

VS Code's built-in BYOK (Custom Endpoint provider) now covers plain chat, tool calling, vision, streaming, and a thinking-effort picker. Verified against the VS Code source (`extensions/copilot/src/extension/byok/`), the **only** thing BYOK structurally _cannot_ do is send arbitrary request-body parameters:

- `modelOptions` is hard-limited to `temperature` and `top_p` — any other keys are silently dropped.
- `reasoningEffortFormat` only emits a fixed `reasoning_effort` enum; it cannot produce `chat_template_kwargs.enable_thinking`.
- `requestHeaders` touches HTTP headers only, never the body.
- There is no body-passthrough field anywhere in its schema.

**Every feature that sends a vLLM-specific request-body param is therefore something BYOK can never replicate. That is the moat.**

Two buckets:

- 🛡️ **Painkillers (the moat)** — sampling / structured-output params BYOK literally cannot send. These make the extension _irreplaceable_.
- ✨ **Vitamins (on-brand, but replaceable)** — informational / UX features like the Server Status UI and the Model Configuration UI. Genuinely differentiating and worth building, but Microsoft could add equivalents.

> **Fixed.** All six vLLM-specific params (`response_format`, `bad_words`, `structured_outputs`, `repetition_detection`, `ignore_eos`, `min_tokens`) now have `KNOWN_PARAMS` UI entries.

---

## ✅ Custom System Prompt Override

**Done.** Solved by **Model Personalities** (`setModelPersonality` command with predefined presets) and **System Message Replacements** (`systemMessageReplacementsFile` for custom find/replace rules). Users can control what the model sees without full prompt replacement.

---

## ✅ Server Status Dashboard

**Done.** Shipped as a native VS Code Tree View (not a webview). Polls `/metrics`, shows per-server health, loaded models, KV cache, running/waiting requests, TTFT/TPOT, cache hit rate, preemptions, and evictions. Configurable poll interval.

---

## ✅ Last Request Details Dashboard Entry

**Done.** Shipped as a collapsible tree node under each server in the Dashboard. Shows model ID, relative timestamp, input/output tokens, cached tokens, reasoning tokens, and timing metrics (TTFT, generation time, throughput). Displays a hint suggesting `--enable-prompt-tokens-details` and/or `--enable-per-request-metrics` when those server flags aren't set.

## Currently Exposed via KNOWN_PARAMS ✅

These params are available in the Server Settings UI (`KNOWN_PARAMS` in `serverSettingsView.ts`) and also work via `defaultParams`/`modelModes`:

| Param                                                         | Type                | Notes             |
| ------------------------------------------------------------- | ------------------- | ----------------- |
| `temperature`, `top_p`, `top_k`, `min_p`                      | number              | Sampling control  |
| `repetition_penalty`, `presence_penalty`, `frequency_penalty` | number              | Penalty control   |
| `max_tokens`, `min_tokens`                                    | number              | Output length     |
| `stop`                                                        | json (array)        | Stop sequences    |
| `response_format`                                             | json                | Output format     |
| `seed`                                                        | number              | Reproducibility   |
| `skip_special_tokens`                                         | string (true/false) | Output formatting |
| `parallel_tool_calls`                                         | string (true/false) | Tool calling      |
| `chat_template_kwargs`                                        | json                | Template control  |
| `reasoning_effort`                                            | string (options)    | Thinking depth    |
| `bad_words`                                                   | json                | Blocked tokens    |
| `structured_outputs`                                          | json                | Token constraints |
| `repetition_detection`                                        | json                | N-gram early-stop |
| `ignore_eos`                                                  | string (true/false) | Ignore EOS        |

(All params supported via `defaultParams`/`modelModes` now also have `KNOWN_PARAMS` UI entries.)

---

## Not Exposed — 12 Remaining Parameters

These params are defined in vLLM's `SamplingParams` but not exposed by the extension:

| Param                           | Type               | Category           | Interest                                        |
| ------------------------------- | ------------------ | ------------------ | ----------------------------------------------- |
| `allowed_token_ids`             | `list[int]`        | Logits Processing  | 🔧 P4 — specialized vocabulary restriction      |
| `detokenize`                    | `bool`             | Output Formatting  | 🔧 P5 — debug only                              |
| `extra_args`                    | `dict[str, Any]`   | Plugin/Custom      | 🔧 P5 — forward compat hook                     |
| `flat_logprobs`                 | `bool`             | Logprobs/Perf      | 🔧 P5 — needs logprobs first                    |
| `include_stop_str_in_output`    | `bool`             | Output Formatting  | 🔧 P3 — minor convenience                       |
| `logit_bias`                    | `dict[int, float]` | Logits Processing  | 💡 P2 — token steering (power users)            |
| `logprob_token_ids`             | `list[int]`        | Logprobs/Scoring   | 💡 P2 — needs logprobs first                    |
| `logprobs`                      | `int`              | Logprobs/Scoring   | 💡 P2 — token confidence (needs UI for display) |
| `n`                             | `int`              | Generation Control | 💡 Future — blocked on Copilot API              |
| `prompt_logprobs`               | `int`              | Logprobs/Prompt    | 🔧 P4 — prompt analysis                         |
| `routed_experts_prompt_start`   | `int`              | Experts/Routing    | 🔧 P5 — MoE niche                               |
| `spaces_between_special_tokens` | `bool`             | Output Formatting  | 🔧 P5 — formatting tweak                        |
| `stop_token_ids`                | `list[int]`        | Generation Control | 💡 P2 — precise stop control                    |

All are niche or debugging-focused. No P1 (high-impact, general-purpose) features remain.

---

## ✅ Personality Presets Should Be Global, Not Workspace-Local

**Category:** Vitamins (UX polish)
**Status:** Implemented — personalities now copy into the extension's global storage (`personalities/`), follow the user across workspaces, and the **Set Model Personality** command works without an open workspace. The **Server Settings** sidebar has a personality dropdown in each model's **General** section.

### Problem (original)

The **Set Model Personality** command copies the chosen preset file to `.vllm/` in the current workspace root and sets `systemMessageReplacementsFile` to a workspace-relative path (e.g. `.vllm/prompt-replacements-tough-love.json`). This means:

- The personality is tied to one workspace — opening a different folder loses it. Users who work across multiple repos must re-run the command for each.
- The `.vllm/` directory is workspace-scoped state that doesn't belong in version control (it's user preference, not project config), yet it lives inside the workspace tree.
- Personality selection should logically be a **model-level** (or user-level) preference, not a workspace artifact.

### Suggestion (original)

Store the personality file in the extension's global storage directory (`context.globalStorageUri`) and set `systemMessageReplacementsFile` to its absolute path there. This way:

- The personality follows the user across all workspaces.
- No `.vllm/` directory is created in the workspace.
- The Set Personality command works even when no workspace folder is open (currently it bails with "Open a folder first").

### Status

Implemented as suggested: personalities are materialized in global storage and referenced by absolute path. Legacy workspace copies (`.vllm/prompt-replacements-*.json`) are no longer discovered as personalities — the picker only lists bundled and global ones. Such `.vllm/` files still work as custom replacement files when pointed at by `systemMessageReplacementsFile`, but they are not offered in the personality picker.

| Param                           | Category           | Notes                                                                                                                         |
| ------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `n`                             | Generation Control | **Blocked** — Chat Provider API can't render parallel outputs. Would need `InlineCompletionItemProvider` + `/v1/completions`. |
| `logprobs`                      | Logprobs           | **See below** — Logprob Viewer (P2, researched)                                                          |
| `prompt_logprobs`               | Logprobs           | Input token analysis. Dependent on logprobs infrastructure.                                                                   |
| `flat_logprobs`                 | Logprobs           | Perf optimization. Dependent on logprobs infrastructure.                                                                      |
| `logprob_token_ids`             | Logprobs           | Targeted scoring. Dependent on logprobs infrastructure.                                                                       |
| `logit_bias`                    | Logits Processing  | Token steering. Requires tokenizer access to convert strings → IDs.                                                           |
| `stop_token_ids`                | Generation Control | Precise stop control. Tokenizer-dependent.                                                                                    |
| `allowed_token_ids`             | Logits Processing  | Vocabulary restriction. Tokenizer-dependent.                                                                                  |
| `include_stop_str_in_output`    | Output Formatting  | Simple boolean toggle. Minor convenience.                                                                                     |
| `detokenize`                    | Output Formatting  | Debug-only. Rarely useful.                                                                                                    |
| `extra_args`                    | Plugin/Custom      | Forward-compat hook. No validation.                                                                                           |
| `routed_experts_prompt_start`   | Experts/Routing    | MoE niche.                                                                                                                    |
| `spaces_between_special_tokens` | Output Formatting  | Formatting tweak. Minor.                                                                                                      |

**Common theme:** Logprobs and logits-processing params are interesting but require tokenizer access or new UI infrastructure to be useful. Output formatting params are debugging-only.

---

## 💡 Logprob Viewer (P2 — Researched)

> **Category:** Token confidence visualization — a power-user feature that makes the extension irreplaceable. BYOK cannot send `logprobs` in the request body, so this is pure moat.

**What it does:** Shows per-token confidence scores for the last request, color-coded from confident (green) to uncertain (red), covering both reasoning tokens and final output tokens.

**Why it matters:**
- **Debug model quality:** "Why did it generate this wrong answer?" → see where confidence dropped
- **Compare models:** "Which model is more confident in this output?"
- **Reasoning transparency:** See where the model was uncertain **during its thinking process**, not just in the final answer
- **Prompt analysis:** Check if the model actually paid attention to your system prompt

**What vLLM returns (per token):**
```
{
  "token": "hello",
  "logprob": -0.012,        // ~99.8% confident
  "top_logprobs": [
    { "token": "hello", "logprob": -0.012 },
    { "token": "hi", "logprob": -2.34 },
    { "token": "hey", "logprob": -3.11 }
  ]
}
```

**What vLLM returns (reasoning tokens):**
- ✅ Reasoning CONTENT tokens get logprobs
- ❌ Hidden reasoning delimiters (`ground`, `ground`) have logprobs suppressed
- Content tokens get logprobs as usual

**Why a webview (not chat window):**
- VS Code chat markdown renderer strips inline HTML (`<span style="...">`)
- KaTeX works because it's an explicit markdown plugin
- Webview gives full CSS control for color-coded rendering
- Follows existing Deep-Dive webview pattern
- Keeps streaming intact in chat (no buffering needed)

**Implementation plan:**
1. Add `logprobs` to `KNOWN_PARAMS` (number field: top N candidates per token)
2. Capture logprobs from SSE stream alongside usage/metrics
3. Store in `lastRequestStore` alongside token counts and timing
4. Dashboard shows "Token Confidence" node under Last Request
5. Clicking opens Logprob Viewer webview with color-coded output
6. Separate sections for reasoning tokens and content tokens

**Open questions:**
- **How much data to store?** Logprobs can be large (top N candidates × tokens). Last request only, or configurable?
- **Color scheme?** Green→yellow→red gradient? Or configurable?
- **Show top alternatives?** Just the chosen token + confidence, or the top 3 candidates?
- **Integrate with Deep-Dive?** Or standalone webview? Could complement the metrics view.

**Effort:** Medium-high. Requires new webview, stream capture changes, and storage in `lastRequestStore`. But the moat value is significant — BYOK literally cannot do this.

---

## 🛡️ Cache `/v1/models` Responses in Server Settings Webview

**Category:** Painkiller (performance)
**Status:** Not implemented

**What:** `serverSettingsView.ts::refreshWebview()` fetches `/v1/models` from ALL configured servers on every webview refresh: initial load, config change (`onDidChangeConfiguration`), and after every model save (`saveModelConfig`). The model list is static until the vLLM server restarts — re-fetching it on every interaction is wasteful.

**Suggestion:** Cache the model list per server URL in a `Map<string, string[]>` with lazy invalidation. Re-fetch only when:
- The webview first loads
- The user explicitly triggers a refresh
- A fetch fails (server might have restarted)
- Settings change (new server added, URL changed)

Since the model list is small (typically < 20 entries) and the server is local/close, the actual cost is negligible for one user. But repeated fetches on every save/config change accumulate — especially with multiple servers.

---

## 🛡️ Centralized Engine Header Update Path

**Category:** Painkiller (correctness)
**Status:** Not implemented

**What:** When `registerUpdateServerAuthCommand` changes auth headers, it updates settings and calls `provider.clearCache()` but does NOT propagate the new headers to `ServerMetricsEngine` instances. The dashboard's `refreshSubscriptions()` does this on re-subscribe (via `getMetricsEngine` which calls `setHeaders`), but only when the dashboard is visible.

If only the deep-dive is open (dashboard hidden) when auth is updated, the engine's subscription continues using old headers until the dashboard is shown and re-subscribes.

**Suggestion:** Either:
1. Have `updateServerAuthCommand` call `updateEngineHeaders()` to push new headers to any existing engine, or
2. Have the `onDidChangeConfiguration` handler in the dashboard also update engine headers even when not visible

The fix is small (< 10 lines) and eliminates a correctness gap.

---

## 🛡️ Token & Credit Usage Tracker

**Category:** Painkiller (transparency)
**Status:** Not implemented

**What:** A persistent counter showing cumulative token consumption (input, output, cached, reasoning) and estimated AI credits used by the local vLLM model — per session, per day, or total. Displayed somewhere accessible: the dashboard, a status bar item, or a hover tooltip.

**Why it matters:**
- Users with limited compute budgets (cloud vLLM instances, API proxies) need to track how much they've consumed
- Unlike GitHub Copilot's own credit tracker (which only counts Copilot API calls), this tracks tokens flowing through the local vLLM server — both chat and tool-call usage
- Helps identify expensive sessions or unexpectedly high token consumption
- Gives a sense of "how much work did this model do today"

**What we already have:**
- `usageReporting.ts` already reports per-request token counts to VS Code via `LanguageModelDataPart` with MIME type `'usage'`
- `lastRequestStore.ts` stores the last request's token counts per server
- `WireUsage` in `types.ts` already carries `prompt_tokens`, `completion_tokens`, `total_tokens`, cached tokens, and reasoning tokens

**What's missing:**
- An accumulator that sums token usage across multiple requests (not just the last one)
- A persistence layer (extension local storage or globalState) so counts survive window reloads
- A UI element to display the running totals

**Suggestion:**
1. Create a `TokenAccumulator` in a new `src/tokenTracker.ts` that reads the last request from `setLastRequest` and increments running totals stored in `context.globalState`
2. Accumulate per model ID (or per server URL) so users with multiple models can see individual usage
3. Store counters with timestamps for daily/weekly/monthly breakdowns
4. Display in the Dashboard as a collapsible "Token Usage" node under each server, showing:
   - Total tokens consumed today (input + output)
   - Total tokens this session
   - Estimated credits (if a conversion rate is configured — e.g. 1 credit = 1000 tokens)
   - Percentage of any configured budget
5. Optionally add a status bar item showing total tokens used today

**What it is NOT:** This is not a replacement for server-side metrics (`/metrics`). The vLLM `/metrics` endpoint already reports cumulative token counts from server start. This tracker is about *client-side* usage that the user can see without looking at the metrics endpoint, and that survives restarts of individual vLLM server instances.

**Effort:** Low-Medium (~1-2h). The data flows already exist; the work is in the accumulator, persistence, and dashboard tree items. No changes to the chat or stream path are needed.

---

## 🛡️ Surface Routed Experts Information

**Category:** Painkiller (MoE transparency)
**Status:** Not implemented

**What:** vLLM supports `--enable-return-routed-experts` (server flag) and `enable_return_routed_experts` (per-request sampling param). When enabled, vLLM returns which experts were used for each token in the response. This is a **per-request output field** — not a Prometheus metric. Currently the extension ignores it.

**Why it matters:**
- **MoE load balancing insight:** See which experts are actually being used for your requests — reveals routing skew
- **Debug unexpected behavior:** If a model is not using certain experts, you can spot it
- **Purely per-request data:** No server-wide Prometheus metrics exist for expert routing — the only way to get this is from the response body

**What vLLM exposes:**
- `--enable-return-routed-experts` CLI flag enables per-request expert routing data
- `routed_experts_prompt_start` sampling param skips N prompt tokens from the returned routing data (multi-turn dedup)
- Response includes per-token expert assignments alongside generated tokens
- No Prometheus metrics for expert utilization — only the per-request response path

**Limits:**
- No server-wide aggregated expert stats in `/metrics`
- vLLM has `count_expert_num_tokens()` and `RoutedExpertsCapturer.get()` internally, but those are Python APIs, not HTTP endpoints
- Exposing aggregated stats would need a custom vLLM plugin or new `/metrics` endpoint
- Only works with MoE (Mixture of Experts) models like Qwen3.6, DeepSeek, Mixtral, etc.

**Implementation sketch:**
1. **Request level** — parse `routed_experts` from the SSE response in `sseParser.ts` alongside tool calls and usage
2. **Store** — add routed experts data to `lastRequestStore` alongside token counts and timing
3. **Display** — show per-token expert assignments in a collapsible section, or add a new "Routed Experts" node under Last Request in the dashboard
4. **Parameter** — add `enable_return_routed_experts` to `KNOWN_PARAMS` (string: true/false) and document `routed_experts_prompt_start`

**Moat value:** BYOK cannot request routed experts — `modelOptions` is limited to `temperature` and `top_p`. This is pure moat.

**Effort:** Medium. Requires SSE response parsing, new storage fields, and dashboard UI. No server-side changes needed — all data comes from the existing vLLM response.
