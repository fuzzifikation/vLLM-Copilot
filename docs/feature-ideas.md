# Feature Ideas: vLLM Capabilities → Better VS Code Experience

**Generated:** 2026-06-06
**Updated:** 2026-08-11 (completed items removed; only open, unimplemented ideas remain)
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
3. Store in `usageStore` (the combined last-request + cumulative store) alongside token counts and timing
4. Dashboard shows "Token Confidence" node under Last Request
5. Clicking opens Logprob Viewer webview with color-coded output
6. Separate sections for reasoning tokens and content tokens

**Open questions:**
- **How much data to store?** Logprobs can be large (top N candidates × tokens). Last request only, or configurable?
- **Color scheme?** Green→yellow→red gradient? Or configurable?
- **Show top alternatives?** Just the chosen token + confidence, or the top 3 candidates?
- **Integrate with Deep-Dive?** Or standalone webview? Could complement the metrics view.

**Effort:** Medium-high. Requires new webview, stream capture changes, and storage in `usageStore`. But the moat value is significant — BYOK literally cannot do this.

---

## 🛡️ Cache `/v1/models` Responses in Model Settings Webview

**Category:** Painkiller (performance)
**Status:** Not implemented

**What:** `serverSettingsView.ts::refreshWebview()` fetches `/v1/models` from ALL configured servers on every webview refresh: initial load and every config change (`onDidChangeConfiguration` — which covers each model save, since a save writes `vllm-copilot.models`). The model list is static until the vLLM server restarts — re-fetching it on every interaction is wasteful.

**Suggestion:** Cache the model list per server URL in a `Map<string, string[]>` with lazy invalidation. Re-fetch only when:
- The webview first loads
- The user explicitly triggers a refresh
- A fetch fails (server might have restarted)
- Settings change (new server added, URL changed)

Since the model list is small (typically < 20 entries) and the server is local/close, the actual cost is negligible for one user. But repeated fetches on every save/config change accumulate — especially with multiple servers.

---

## 🛡️ Centralized Engine Header Update Path

**Category:** Painkiller (correctness)
**Status:** Implemented — `registerUpdateServerAuthCommand` now calls `updateMetricsEngineHeaders()` (update-if-present) to push new headers to any existing engine. See CHANGELOG v1.32.1.

---

## 🛡️ Token & Credit Usage Tracker

---

## ✨ OpenRouter Provider Selection (in Model Settings)

**Category:** Vitamin (OpenRouter UX)
**Status:** Planned — not implemented. Decision recorded in [openrouter-plan.md](../openrouter-plan.md).

**What:** When an **OpenRouter** model is selected in Model Settings, show a **provider dropdown** below the model. It lists only the **providers available for that specific model** (not the whole catalog), with an **Auto** (default) option. Choosing a provider persists it on the model config and is applied as a routing suffix on the wire model id at request time.

**Key decisions (fixed, do not revisit without product direction):**
- **No provider picker in the Add Server flow.** The Add flow keeps its model-only pick. Provider choice is a Model Settings refinement, not an onboarding concern.
- **Per-model, not global.** The provider is stored per model (alongside `serverUrl`, `vllmModelId`, headers) and applies only to that model.
- **"Auto" is the default.** `Auto` = let OpenRouter route (no suffix). A manual choice forces routing to that provider.
- **Scope to the selected model's providers.** The dropdown shows only the providers OpenRouter exposes for the currently selected model — never the full provider list.

**Suggested implementation:**
1. Extend `normalizeOpenRouterModel`/`fetchOpenRouterModel` (`src/openRouter.ts`) to also return the model's provider list from the exact-model API (`data:provider`, plus the `data:provider` routing data if present).
2. Add a `provider?: string` field to the OpenRouter model config (default `undefined` = Auto).
3. Model Settings webview: when `serverType === 'openrouter'`, render the provider dropdown from the fetched provider list + Auto.
4. At request time (`requestBuilder.ts`), when `provider` is set, send the wire id with a `:provider` suffix (e.g. `openai/gpt-5:anthropic`). The base id stays the canonical identity; the suffix only affects routing.
5. Keep the metadata lookup on the **base** id (strip the provider suffix like the existing `:free` handling).

**Open questions:**
- Which OpenRouter API field is authoritative for a model's available providers, and does it require auth?
- Should a manual provider choice be validated against the current provider list on model settings save, or just passed through?
- Does the provider suffix interact with the existing `:free` routing variant (e.g. `:provider:free` vs `:free:provider` ordering)?

**Effort:** Low-medium. One config field, one dropdown in the existing Model Settings webview, one suffix append in the request builder, and a metadata field return. No new webview or transport.

---

**Category:** Painkiller (transparency)
**Status:** ✅ **Implemented** — see [`src/usageStore.ts`](../src/usageStore.ts), the dashboard **Token Usage** node, and [docs/configuration-reference.md](../docs/configuration-reference.md) → *Token Usage & Cost*.

**What (as built):** A persistent counter showing cumulative token consumption (input, output, cached, reasoning) and estimated cost per model — per session, per day, or total. Displayed in the dashboard's **Token Usage** node under each server, live (no poll-interval lag), with a per-server **Reset Usage** action. Cost is derived at render time from optional per-model `cost` rates (per 1M tokens, in USD or AI Credits).

**How it's built:**
- A single ingestion point (`recordRequest` in `src/usageStore.ts`) runs at the completion of every prompt carrying a usage payload. It both stores the server's **Last Request** and accumulates the **Today / Session / Total** counters per `(server, model)`.
- **Live UI:** the store fires one change event (`onUsageStoreDidChange`) that the dashboard subscribes to, so both the Last Request and Token Usage nodes re-render immediately — no poll-interval lag (this also fixed a pre-existing staleness bug in the Last Request node).
- **Persistence:** day buckets + all-time totals in `globalState` (`vllm-copilot.usage.v1`), serialized writes, 90-day retention. Session counters are in-memory.
- **Cost:** optional per-model `cost` rates (`input` / `output` / `cachedInput`, per 1M tokens, `currency` label default `USD`). Derived at render time — never stored, so editing a rate re-prices all history. Supports `"AI Credits"` display for Copilot-picker comparison.
- **Reset:** per-server row in the Token Usage node, plus a `vLLM-Copilot: Reset Usage` palette command (all / per-server scope). Last Request survives a reset.

**What it is NOT:** This is not a replacement for server-side metrics (`/metrics`). The vLLM `/metrics` endpoint already reports cumulative token counts from server start. This tracker is about *client-side* usage that the user can see without looking at the metrics endpoint, and that survives restarts of individual vLLM server instances.

**Deferred:** a status bar item showing "tokens used today" (the tree node already delivers the value).

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
2. **Store** — add routed experts data to `usageStore` alongside token counts and timing
3. **Display** — show per-token expert assignments in a collapsible section, or add a new "Routed Experts" node under Last Request in the dashboard
4. **Parameter** — add `enable_return_routed_experts` to `KNOWN_PARAMS` (string: true/false) and document `routed_experts_prompt_start`

**Moat value:** BYOK cannot request routed experts — `modelOptions` is limited to `temperature` and `top_p`. This is pure moat.

**Effort:** Medium. Requires SSE response parsing, new storage fields, and dashboard UI. No server-side changes needed — all data comes from the existing vLLM response.
