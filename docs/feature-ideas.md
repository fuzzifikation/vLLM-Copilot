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

**Status (provider dropdown + per-provider limits):** Implemented. The dropdown options are annotated with each provider's reported context window + output cap (compact suffix, exact numbers in the hover title), the dashboard's Provider row shows the pinned provider's own limits, and a symmetric Attention icon flags any output budget clamped below the configured value (catalog ceiling or pinned-provider cap). All display-only — never persisted/clamped (the general `maxOutputTokens` budget still comes from the catalog, per the "display live, never persist" decision). **Errors need no special-casing:** the generic OpenRouter error path already surfaces the server HTTP code + the server's formatted message (`constraint_filtered` included) — the proposed per-provider error enrichment was rejected as a redundant special-case.

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

---

## ✨ Output-Length Picker (second model-picker dropdown)

**Category:** Vitamin (UX) — rides the same moat plumbing as model modes
**Status:** ✅ Implemented — see "What actually shipped" at the end of this entry

**What:** A second dropdown in the Copilot model picker (next to the existing Model Mode dropdown) that lets the user pick a predefined output length — e.g. `1K / 4K / 16K / Max` — instead of digging into model settings to change `maxOutputTokens`. VS Code persists the choice per model and sends it on every request.

**Why it matters:**
- Capping output is the cheapest way to control latency and rambling on local models; raising it recovers truncated edits. Both are common enough to belong in the picker, not in JSON.
- Pairs naturally with the `output_limit` picker banner shipped in v1.34: the banner tells you the budget is clamped, the dropdown lets you react to it.

**Verified API facts (2026-08-30, `vscode.proposed.chatProvider.d.ts` @ main + VS Code core source):**
- `configurationSchema` is a JSON Schema (`LanguageModelConfigurationSchema`); **"Each property in `properties` defines a configurable option"** — multiple dropdowns per model are explicitly supported, each with `group: 'navigation'` renders as its own primary model-picker action.
- Precedent in VS Code's own Copilot CLI provider: it builds `properties` with `contextSize` **and** `reasoningEffort` side by side, with **numeric enums** (`contextSize: { enum: [200_000, 1_000_000] }`) — raw numbers are valid enum values.
- VS Code resolves the effective config itself: *"resolved values … with user overrides applied on top of schema defaults"* (`_resolveModelConfigurationWithDefaults` in `languageModels.ts`) and delivers it as `ProvideLanguageModelChatResponseOptions.modelConfiguration`. **Persistence is VS Code's job, not ours.**
- Our plumbing already exists end-to-end: `buildConfigurationSchema()` emits the `reasoningEffort` property, and `provider.ts` + `provider/requestBuilder.ts` already read `modelConfiguration`. This idea adds a second property to the same, working pipe.
- Runtime floor: `configurationSchema`/`modelConfiguration` are recognized since VS Code 1.128 (our engine floor). Multi-property schemas are newer upstream but degrade gracefully — worst case an old host renders fewer dropdowns.

**Implementation plan:**
1. **Schema** (`modelInfo.ts::buildConfigurationSchema`): extend signature with the model's `TokenBudget` and reported ceiling. Add property `maxOutputTokens`:
   - `enum`: ladder `[1024, 2048, 4096, 8192, 16384, 32768, …]` filtered to values ≤ `min(budget.maxModelLen − 1, reportedMaxOutputTokens ?? ∞)`, **plus** the currently-resolved `budget.maxOutputTokens` (so the schema default is always an enum member).
   - `default`: `budget.maxOutputTokens` (preserves today's behavior when the user never touches the dropdown).
   - `enumItemLabels`: `1K / 2K / 4K / …`; `title: 'Output limit'`; `group: 'navigation'`.
   - Emit only when the filtered ladder has ≥ 2 distinct options — never show a one-choice dropdown.
2. **Request side** (`provider/requestBuilder.ts`): read `modelConfiguration?.maxOutputTokens`, accept a finite number, clamp to `budget.maxOutputTokens`, and use it as the request's `max_tokens`. Precedence: **picker selection > model-mode param > settings** (an explicit user pick in the UI beats a background preset; the context-window clamp always wins last). Mirror the read in `provider.ts` where mode resolution already happens, so both paths agree.
3. **Do not persist** the selection into `vllm-copilot.models` — VS Code owns persistence. Our settings `maxOutputTokens` remains the default source.
4. **Tests:** schema filtering (small-window models), default-is-in-enum, single-option suppression, request-builder override + clamp, mode-vs-picker precedence.

**Open questions:**
- Should modes that set their own output tokens hide the dropdown, or just lose to it (proposed: lose to it)?
- Ladder granularity for tiny local models (add 512?) — decide from real `max_model_len` distributions.

**Effort:** Low. One schema extension, one request-side read, tests. Roughly 60–100 lines.

**What actually shipped (deviations from the plan above):**
- **No derived ladder.** The plan proposed auto-deriving a menu for every model; that was reverted as scope creep against the repo's "no generic fallback" contract and the user's "pre-define those" intent. A dropdown appears **only** when a model/preset declares a vector-form `maxOutputTokens`.
- **Merged field shape:** `maxOutputTokens` accepts `number | number[]`. A separate `outputLengths` field existed briefly during development and was merged back into `maxOutputTokens` before release (the pick-as-advertised change below made the scalar ceiling redundant with the vector head) — unreleased, so zero migration. Array ordered, **first element = default AND desired budget**, filtered against the clamped ceiling (dropped entries never shown; a dropped head promotes the next survivor), de-duped, capped at 8. Fewer than 2 survivors → no dropdown.
- **The pick IS the advertised budget.** Discovery clamps the tracked pick to a static pre-pick ceiling (window + server-reported clamps applied) and advertises that as `maxOutputTokens` — since Copilot derives the prompt budget as window − output, a shorter pick genuinely grows prompt headroom. A pick change re-publishes model metadata (provider-tracked, deduped; the default pick == ceiling triggers no re-registration). The menu and the clamp banner scale against the **static ceiling**, so picking 16K never removes 32K from the menu and a deliberate pick never reads as a clamp warning.
- **Precedence:** picker pick > `modelModes[selected].max_tokens` > `defaultParams.max_tokens` > budget head — always clamped to the ceiling. Modes are now behavior-only; 6 bundled presets had their per-mode `max_tokens` migrated into the array form of `maxOutputTokens`.
- **Not persisted** into `vllm-copilot.models` (VS Code owns persistence, as planned).
- **Deferred (separate step):** a migration notification for existing installs whose saved models predate the array form (they get no dropdown until the model is re-added / re-merged). **Release-ordering caveat:** vector-form preset files must NOT be pushed to `main` before the 1.35.0 extension ships — v1.34 recognizes the `maxOutputTokens` key but its scalar-only math silently degrades an array to the 4096 default.

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

## ✨ Named-Server Registry ("B") — deduplicate server identity & auth

**Category:** Architecture / Vitamin (developer-experience, not user-facing moat)
**Status:** Accepted → plan: [server-registry.md](./server-registry.md) (revision 4, 2026-08-31, code-reviewed against `836efb5`; not implemented). **Revision 4 changed the shape of the deal: pure registry, inline `serverUrl` deleted from `ModelConfig`, user settings migrated on activation without an opt-in.** The "non-breaking rules" below are superseded — read them as history.
**Cross-note:** This *reconsiders* the per-model identity decision in [code-review.md](./code-review.md) ("Accepted product decisions: per-model server identity"). It is **not** a return to the deprecated single-global-server; it's an explicit registry of *N* named servers that models reference.

**What:** Today every model entry duplicates its own `serverUrl` and `requestHeaders`. Two models on one server carry the same auth copy-pasted (e.g. the same CF-Access client-id/secret + bearer token). This introduces a real drift bug class: rotate a shared credential and every entry must be updated or it silently keeps a dead key. The display-name work (v1.33.0, `serverDisplayName`) landed as a per-model field for the same structural reason.

Proposed shape — models reference a server by id instead of copying it:

```jsonc
"vllm-copilot.servers": [{
  "id": "gw-shared",
  "serverUrl": "https://gw.example-corp.com/team-a/inference/gw-shared",
  "requestHeaders": { "X-API-Key": "..." },
  "displayName": "IT Server for GLM5.2",   // moves here from serverDisplayName
  "serverType": "vllm"
}],
"vllm-copilot.models": [{
  "server": "gw-shared",   // reference, not a copy
  "id": "glm52-prod", "vllmModelId": "zai/glm-5.2", ...
}]
```

**Why it's worth it:**
- **Auth becomes a single source of truth** — one stored copy per server instead of one per model. (Honest caveat verified in the review: *rotation* already works today, because `Update Auth` and `Rename Server` fan out URL-wide across every model on that URL. The registry fixes ownership and settings.json hygiene, not reach — see server-registry.md §1.)
- ~~**Server identity becomes `id`, not a header-value fingerprint**~~ — **rejected in the plan (server-registry.md §5).** The `serverFingerprint`/`serverGroupKey` machinery (dashboard grouping, settings view, deep-dive keys, metrics-engine pooling, credential isolation, usage-store keys, `buildModelId`) stays keyed on the resolved `(url, headers)` pair; the registry id is a *write target*, not an identity. So the "deletes most of the identity machinery" saving in the cost estimate below **does not materialise** — only the *computation* of the pair moves into the resolver.
- **Future server-level knobs get a home** — TLS options, per-server poll interval, proxy settings stop needing a per-model storage debate.
- **`serverDisplayName` migrates cleanly** onto the server record; the shipped dashboard/rename logic keeps working against the registry (~70% portable).

**Migration rules — superseded on 2026-08-31, kept as history.** These three "agreed" rules were
what made the design a hybrid. Revision 4 dropped them, and that *shrank* the plan:

1. ~~**Additive only**~~ → `server` is **required**; inline `serverUrl` is deleted from
   `ModelConfig`. Two ways to name one server was the mess.
2. ~~**Read tolerance forever**~~ → no fallback exists. The upside nobody expected: with the
   field gone, all 135 `.serverUrl` reads become compile errors, so the silent "model vanishes
   from a feature" failure class is caught by `tsc` instead of by a hand-written audit plus
   tests. See [server-registry.md](./server-registry.md) §2.
3. ~~**Opt-in migrate command, never auto-rewrite**~~ → one-shot **forced** migration at
   activation, marker-guarded, forensic pre-write snapshot (no Undo command — restoring the legacy
   shape would produce settings the current version cannot use), notification
   and output-channel log (§6). Still never from `onDidChangeConfiguration`.

**Costs / open decisions:**
- Config-layer surgery across provider request path, `vllmClient` cache, discovery, dashboard/deep-dive keys, Add flow, Update Auth, Remove Server, Test & Refresh, autoConfig, presets, BYOK, OpenRouter branch, the schema artifacts, docs, and the test suite. **Revision (2026-08-31):** reviewed against the code — this is *not* "mostly deletes"; 135 raw `model.serverUrl` property accesses across 16 of the 50 files in `src/` have to become resolver reads. In the pure design the compiler lists them for you, which replaces the audit and most of the regression-test invention. There is deliberately no file-by-file list in the plan any more (the previous one went stale within a week) — see §7 for the decisions `tsc` cannot make.
- ~~**Lifecycle rule that must be decided:** what happens when a user deletes a server entry that models still reference?~~ **Decided:** refuse while any model references the id and name the models. No cascade, and no "detach to inline" — there is nothing to detach to.
- The rename feature shipped (v1.33.0) already solves the display-name problem, so the *remaining* justification is auth dedup + identity simplification — not renaming.

**Priority:** P3 / deferred. High value, high churn. Worth doing if duplicated shared auth keeps recurring or server-level settings keep being requested; not worth it for renaming alone. *(Superseded 2026-08-31: decided to build the pure version — see server-registry.md.)*

**Effort:** Medium-large, and it is a **single breaking release** — the pure design has no shippable intermediate state (deleting `serverUrl` and shipping the migration are one commit). Config layer + provider/discovery read path + migration + write paths + webview + both schema artifacts + docs. No server-side changes needed; all data comes from the existing vLLM responses. (This line previously claimed "Requires SSE response parsing", which was boilerplate from another idea and never applied here.)

## 🌐 Remote Model Presets — fetch `model-configs/` from the GitHub repo

**Problem:** A new model releases (e.g. Qwen3.8-Flash-Next, 2026-08-26) and the preset for it only reaches users after a full VSIX build + marketplace publish. Presets are the fastest-moving content in the repo, but they're locked to the release cadence.

**Idea (hybrid, NOT remote-only):**
- Keep `model-configs/` bundled in the VSIX as the tested baseline (unchanged — `test/modelConfigPresets.test.ts` keeps guarding exactly what ships, and offline/air-gapped installs keep working).
- Add an explicit user command **"Fetch Latest Presets from GitHub"**: downloads `model-configs/*.json` from the repo's `main` branch into `context.globalStorage`, cached with a date stamp. Hardcoded repo URL, nothing else.
- `loadModelPresets` reads bundled first, then overlays the remote-cached files; remote wins on same `vllmModelId` (they are newer). Preset *matching* is already substring-based, so nothing downstream changes.

**Why hybrid and not remote-only:**
- **Trust:** presets silently become request parameters (`defaultParams`, `chat_template_kwargs`). Bundled + release = two review gates; remote-only = whoever pushed to `main` changes every user's requests immediately, with no version pin.
- **Offline first-run:** local-vLLM users are frequently air-gapped; Auto-Configure must work with zero network.
- **Schema drift:** an extension update can change `ModelConfig` semantics; a bundled version boundary prevents old remote presets from misbehaving silently.

**Costs / open decisions:**
- Small fetch + cache + "update available" affordance in Model Settings; overlay ordering in `presets.ts`; per-file parse isolation already exists (`parsePresetFile` skips malformed files).
- Decide: silent periodic check vs. command-only (command-only is the safer default; a badge "new presets available" can come later).

**Priority:** P3 / deferred. The bundled flow costs little while the release cadence stays weekly-ish. Build this when community preset PRs start arriving or releases slow down.

**Effort:** Low-medium. One command, one fetch/cache module, an overlay step in preset loading, and tests for overlay precedence + cache invalidation.
