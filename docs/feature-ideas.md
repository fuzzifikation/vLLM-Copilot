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

## ✨ OpenRouter Provider Selection (in Model Settings)

**Category:** Vitamin (OpenRouter UX)
**Status:** Implemented (2026-08-20). See `src/openRouter.ts` (`fetchOpenRouterModelEndpoints`), `src/serverSettingsView.ts` (lazy fetch on open), `resources/serverSettings.js` (Provider dropdown after the Model select), and `src/provider/requestBuilder.ts` (`provider: { only: [tag] }` injection).

**What:** When an **OpenRouter** model is selected in Model Settings, show a **provider dropdown** right after the Model select. It lists only the **providers available for that specific model** (from `GET /api/v1/models/{id}/endpoints`), with an **Auto** (default) option. Choosing a provider persists it on the model config and is applied at request time through OpenRouter's request-body `provider` object.

**Key decisions (fixed, do not revisit without product direction):**
- **No provider picker in the Add Server flow.** The Add flow keeps its model-only pick. Provider choice is a Model Settings refinement, not an onboarding concern.
- **Per-model, not global.** The provider is stored per model (alongside `serverUrl`, `vllmModelId`, headers) and applies only to that model.
- **"Auto" is the default.** `Auto` = let OpenRouter route. A manual choice forces routing to that provider.
- **Scope to the selected model's providers.** The dropdown shows only the providers OpenRouter exposes for the currently selected model — never the full provider list.
- **All slugs come from the API, verbatim.** The dropdown's option values are the exact `tag` values from `/endpoints` (e.g. `"together"`, `"gmicloud/fp8"`), sent to `provider.only` unchanged. No derivation, no guessing, no string synthesis.

**Implementation notes:**
1. Provider list sourced from the model-endpoints API (`GET /api/v1/models/{author}/{slug}/endpoints`), fetched lazily when Model Settings opens (per configured OpenRouter model, keyed by wire id). The `:free` variant is passed verbatim and resolves to only its own providers.
2. `provider?: string` on the OpenRouter model config (default `undefined` = Auto); the value is the exact `tag`.
3. Model Settings webview: when `serverType === 'openrouter'`, render the provider dropdown from `providersByModel[wireId]` + Auto. Unavailable list → only Auto, nothing fabricated.
4. At request time (`requestBuilder.ts`), when `provider` is set, send `provider: { only: [tag] }` in the chat body — the tag verbatim, `vllmModelId` stays canonical (no `:provider` suffix).

**Open question (pricing, next):** the same `/endpoints` response carries per-provider `pricing` (per-token prompt/completion/input_cache_read + time-of-day `overrides` + `discount`), `max_completion_tokens`, and `status`/uptime — surfaced per-provider in the dropdown (price) and usable for per-provider cost estimation in the dashboard when a provider is pinned.

**Effort:** Done — one config field, one lazy fetch + webview dropdown, one `provider`-object injection in the request builder, and tests for each surface.

---

## ✨ Shareable Model-Mode Profiles (team task presets)

**Category:** Vitamin (team workflow)
**Status:** Idea — not implemented.

**What:** Make model modes *shareable* across a team. Today a mode is a per-model, per-user setting. For the enterprise/team audience, the value is defining a task profile once (e.g. "Precise Code", "Deep Reasoning", "Structured JSON") and having every engineer on the team pick it from the Copilot model picker without each person hand-copying JSON.

**Why it matters (moat + team adoption):**
- Model modes are already a differentiator (BYOK can't send arbitrary body params). Making them **shareable** multiplies their value: one operator defines the presets, the whole team gets consistent behavior.
- Lowers the onboarding cost for the enterprise story ("run Copilot against your own vLLM servers for many users").
- Pure moat — BYOK has no equivalent concept at all.

**Design directions (pick one, don't build all):**
- **Import/export of a `modelModes` block** as a JSON snippet that can be pasted into the Model Settings UI or a settings file — simplest, works with existing per-model storage.
- **A team-level presets file** (e.g. an optional `teamModes` or referenced presets JSON) that Model Settings can load and apply to a model, distinct from the bundled per-model presets.
- **Named, shared task profiles** stored once and referenced by many models, rather than duplicated per model.

**Open questions:**
- Where should shared profiles live — global storage, a workspace file, or a referenced JSON like `systemMessageReplacementsFile` already does?
- Are profiles model-agnostic (a "Precise Code" preset applies to any model) or model-scoped (per family)?
- How do shared profiles merge with per-model overrides if both define the same param?

**Effort:** Low (import/export) to Medium (shared profile store + Model Settings UI).

---

## 🛡️ Cost Governance: Per-Model Budgets & Alerts

**Category:** Painkiller (enterprise cost control)
**Status:** Idea — not implemented.

**What:** Build on the existing Token Usage & Cost tracker to add **budgets and thresholds** — warn when a model or team exceeds a spend limit (per day / per month), and optionally block new requests once a hard cap is hit.

**Why it matters:**
- The tracker already records actual spend (`usage.cost` for OpenRouter, derived rates otherwise). Budgets turn that data from *reporting* into *governance* — the thing an enterprise operator actually needs.
- Differentiates against BYOK, which has no cost tracking at all.
- Aligns with the professional positioning; only worth building if there's evidence users want it (per the repo's "ignore for now" rule, don't pre-build).

**Scope options (pick the smallest useful slice):**
- **Soft alert:** show a warning row/badge when a model's spend passes a configured threshold this period.
- **Hard cap:** refuse new requests to a model once its cap is reached (with an override).
- **Per-model vs per-server vs per-team:** a threshold lives on a model entry, or is aggregated across a server.

**Open questions:**
- Is a per-model soft alert the minimal first slice, or does a hard block need to ship together for the feature to be credible?
- Where does the threshold live in config, and does it need a UI in Model Settings or just a settings field?
- Interaction with OpenRouter's own account-level limits and `usage.cost` reporting.

**Effort:** Low (soft alert on existing tracker) to Medium (hard cap + request-time enforcement + UI).

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
