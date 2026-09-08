# Feature Ideas: vLLM Capabilities → Better VS Code Experience

**Generated:** 2026-06-06
**Updated:** 2026-09-08 (shipped entries deleted against the code, not against memory: registry, remote presets, usage tracker, OpenRouter providers, output-length picker, centralized auth update. The stale "12 remaining parameters" table was replaced with the passthrough truth. Completed items live in git history, not here.)
**Source:** [vLLM SamplingParams API Reference](https://docs.vllm.ai/en/latest/api/vllm/sampling_params.html)

**Context:** vLLM supports many per-request sampling parameters. These represent opportunities to build features that VS Code's built-in Copilot doesn't have, making vLLM-Copilot the superior local model integration.

> **Tracking:** Only two docs are maintained: this file (new ideas) and [code-review.md](./code-review.md) (real bugs and nice-to-have refactors against the current code). There is no consolidated roadmap. Ideas marked as evidence-gated stay unbuilt until a real user asks; do not pre-build for a hypothetical enterprise.

---

## The Moat: What Makes This Extension Irreplaceable

VS Code's built-in BYOK (Custom Endpoint provider) now covers plain chat, tool calling, vision, streaming, and a thinking-effort picker. Verified against the VS Code source (`extensions/copilot/src/extension/byok/`), the **only** thing BYOK structurally _cannot_ do is send arbitrary request-body parameters:

- `modelOptions` is hard-limited to `temperature` and `top_p` - any other keys are silently dropped.
- `reasoningEffortFormat` only emits a fixed `reasoning_effort` enum; it cannot produce `chat_template_kwargs.enable_thinking`.
- `requestHeaders` touches HTTP headers only, never the body.
- There is no body-passthrough field anywhere in its schema.

**Every feature that sends a vLLM-specific request-body param is therefore something BYOK can never replicate. That is the moat.**

Two buckets:

- 🛡️ **Painkillers (the moat)** - sampling / structured-output params BYOK literally cannot send. These make the extension _irreplaceable_.
- ✨ **Vitamins (on-brand, but replaceable)** - informational / UX features. Genuinely differentiating and worth building, but Microsoft could add equivalents.

---

## Parameter Exposure: What Is Actually Missing

The old "12 remaining parameters" table was fiction. Since `defaultParams` and `modelModes` pass any request-body key through verbatim (only `model`, `messages`, `stream`, `stream_options` are rejected, see `src/shared/configSchemaTool.ts`), every send-only parameter is **already user-sendable today**: `logit_bias`, `stop_token_ids`, `allowed_token_ids`, `include_stop_str_in_output`, `spaces_between_special_tokens`, `extra_args`, `routed_experts_prompt_start`, and even `logprobs` / `prompt_logprobs` (the server returns them, the extension just ignores them). Exposing them as named settings fields would be ceremony.

The real gaps are all on the **response side**, where passthrough cannot help:

| Gap | Type | Interest |
| --- | --- | --- |
| `logprobs` capture + viewer | Response parsing + UI | 💡 P2 - the flagship entry below, pure moat |
| `routed_experts` capture | Response parsing + UI | 💡 P2 - MoE niche, rides the same plumbing |
| `n` (multiple completions) | Generation control | 💡 Future - blocked on the Copilot chat Provider API, not on us |

---

## 💡 Logprob Viewer (P2 - Researched)

> **Category:** Token confidence visualization - a power-user feature that makes the extension irreplaceable. BYOK cannot send `logprobs` in the request body, so this is pure moat.

**Status:** Not implemented. Request side is already free: `logprobs` flows verbatim through `defaultParams`/`modelModes` today and the server answers with logprob payloads the extension currently throws away. The work is entirely capture + storage + UI.

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
- ❌ Hidden reasoning delimiters have logprobs suppressed
- Content tokens get logprobs as usual

**Why a webview (not chat window):**
- VS Code chat markdown renderer strips inline HTML (`<span style="...">`)
- KaTeX works because it's an explicit markdown plugin
- Webview gives full CSS control for color-coded rendering
- Follows existing Deep-Dive webview pattern
- Keeps streaming intact in chat (no buffering needed)

**Implementation plan:**
1. ~~Add `logprobs` to `KNOWN_PARAMS`~~ obsolete: passthrough already sends it; nothing to add on the request side
2. Capture logprobs from the SSE stream alongside usage/metrics (`sseParser.ts` owns JSON parsing of response chunks)
3. Store in `usageStore` (the combined last-request + cumulative store) alongside token counts and timing
4. Dashboard shows "Token Confidence" node under Last Request
5. Clicking opens Logprob Viewer webview with color-coded output
6. Separate sections for reasoning tokens and content tokens

**Open questions:**
- **How much data to store?** Logprobs can be large (top N candidates × tokens). Last request only, or configurable?
- **Color scheme?** Green→yellow→red gradient? Or configurable?
- **Show top alternatives?** Just the chosen token + confidence, or the top 3 candidates?
- **Integrate with Deep-Dive?** Or standalone webview? Could complement the metrics view.

**Effort:** Medium-high. Requires new webview, stream capture changes, and storage in `usageStore`. But the moat value is significant - BYOK literally cannot do this.

---

## 🛡️ Surface Routed Experts Information (P2)

**Category:** Painkiller (MoE transparency)
**Status:** Not implemented

**What:** vLLM supports `--enable-return-routed-experts` (server flag) and `enable_return_routed_experts` (per-request sampling param). When enabled, vLLM returns which experts were used for each token in the response. This is a **per-request output field** - not a Prometheus metric. Currently the extension ignores it. The request param already flows via passthrough; only capture and display are missing.

**Why it matters:**
- **MoE load balancing insight:** See which experts are actually being used for your requests - reveals routing skew
- **Debug unexpected behavior:** If a model is not using certain experts, you can spot it
- **Purely per-request data:** No server-wide Prometheus metrics exist for expert routing - the only way to get this is from the response body

**What vLLM exposes:**
- `--enable-return-routed-experts` CLI flag enables per-request expert routing data
- `routed_experts_prompt_start` sampling param skips N prompt tokens from the returned routing data (multi-turn dedup)
- Response includes per-token expert assignments alongside generated tokens
- No Prometheus metrics for expert utilization - only the per-request response path

**Limits:**
- No server-wide aggregated expert stats in `/metrics`
- vLLM has `count_expert_num_tokens()` and `RoutedExpertsCapturer.get()` internally, but those are Python APIs, not HTTP endpoints
- Exposing aggregated stats would need a custom vLLM plugin or new `/metrics` endpoint
- Only works with MoE (Mixture of Experts) models like Qwen3.6, DeepSeek, Mixtral, etc.

**Implementation sketch:**
1. **Request level** - already covered by param passthrough (`enable_return_routed_experts`, `routed_experts_prompt_start` reach the server today)
2. **Capture** - parse `routed_experts` from the SSE response in `sseParser.ts` alongside tool calls and usage
3. **Store** - add routed experts data to `usageStore` alongside token counts and timing
4. **Display** - show per-token expert assignments in a collapsible section, or add a new "Routed Experts" node under Last Request in the dashboard

**Moat value:** BYOK cannot request routed experts - `modelOptions` is limited to `temperature` and `top_p`. This is pure moat.

**Ordering note:** Same capture → store → display pipeline as the Logprob Viewer. Build it second, on the plumbing the viewer already paid for, or not at all.

---

## 🛡️ Cache `/v1/models` Responses in Model Settings Webview

**Category:** Painkiller (performance)
**Status:** Not implemented

**What:** `serverSettingsView.ts::refreshWebview()` probes every registry entry's model list (`listServerModels`) on every webview refresh: initial load and every config change (`onDidChangeConfiguration` - which covers each model save, since a save writes `vllm-copilot.models`). The model list is static until the server restarts - re-fetching it on every interaction is wasteful.

**Suggestion:** Cache the model list per server entry with lazy invalidation. Re-fetch only when:
- The webview first loads
- The user explicitly triggers a refresh
- A fetch fails (server might have restarted)
- Settings change (new server added, URL changed)

Since the model list is small (typically < 20 entries) and the server is local/close, the actual cost is negligible for one user. This is a five-line cache for a problem that barely hurts - build it only if it ever shows up in a slow-refresh complaint.

---

## ✨ Shareable Model-Mode Profiles (team task presets)

**Category:** Vitamin (team workflow)
**Status:** Idea - not implemented. Evidence-gated: the whole value proposition is multi-engineer teams; there is zero evidence of one using this extension. Do not build until a second human asks.

**What:** Make model modes *shareable* across a team. Today a mode is a per-model, per-user setting. For the enterprise/team audience, the value is defining a task profile once (e.g. "Precise Code", "Deep Reasoning", "Structured JSON") and having every engineer on the team pick it from the Copilot model picker without each person hand-copying JSON.

**Why it matters (moat + team adoption):**
- Model modes are already a differentiator (BYOK can't send arbitrary body params). Making them **shareable** multiplies their value: one operator defines the presets, the whole team gets consistent behavior.
- Lowers the onboarding cost for the enterprise story ("run Copilot against your own vLLM servers for many users").
- Pure moat - BYOK has no equivalent concept at all.

**Design directions (pick one, don't build all):**
- **Import/export of a `modelModes` block** as a JSON snippet that can be pasted into the Model Settings UI or a settings file - simplest, works with existing per-model storage.
- **A team-level presets file** (e.g. an optional `teamModes` or referenced presets JSON) that Model Settings can load and apply to a model, distinct from the bundled per-model presets.
- **Named, shared task profiles** stored once and referenced by many models, rather than duplicated per model.

**Open questions:**
- Where should shared profiles live - global storage, a workspace file, or a referenced JSON like `systemMessageReplacementsFile` already does?
- Are profiles model-agnostic (a "Precise Code" preset applies to any model) or model-scoped (per family)?
- How do shared profiles merge with per-model overrides if both define the same param?

**Effort:** Low (import/export) to Medium (shared profile store + Model Settings UI).

---

## 🛡️ Cost Governance: Per-Model Budgets & Alerts

**Category:** Painkiller (enterprise cost control)
**Status:** Idea - not implemented. Evidence-gated like the team profiles: the usage tracker ships, nobody has asked for budgets.

**What:** Build on the existing Token Usage & Cost tracker to add **budgets and thresholds** - warn when a model or team exceeds a spend limit (per day / per month), and optionally block new requests once a hard cap is hit.

**Why it matters:**
- The tracker already records actual spend (`usage.cost` for OpenRouter, derived rates otherwise). Budgets turn that data from *reporting* into *governance* - the thing an enterprise operator actually needs.
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

# Architecture (maintainer-side)

Structural changes that make maintaining and expanding easier. None is user-facing, so all are trigger-driven: each says WHEN it pays rent, and building one before its trigger is abstraction for abstraction's sake. Considered and rejected in the same 2026-09-03 review, do not re-propose without new evidence: DI container (kills the compile-catches-everything property the registry bought), event bus (linear pipelines do not need mediation), webview TS/framework rewrite (two webviews, one maintainer; the contract is now pinned by `test/webviewContract.test.ts` instead), plugin API for backends (the descriptor below IS that interface, retrofitted cheaply if strangers ever contribute).

## 🏗️ Backend descriptor: one table per serving backend

**Category:** Architecture (maintainability, not user-facing moat)
**Status:** Open, trigger-driven. Do NOT build speculatively.

**Problem (measured 2026-09-03):** "backend" is not a thing in the code, it is 34 `serverType ===` branches across 13 files: classifier, `runtimeLimits` (context-window endpoint), `chatTransport` (vLLM-only param stripping, the `ollama` `tool_choice` special case), `streamOrchestrator` (auto-continue vLLM-only, 3 sites), `hfDiscovery` (template probing vLLM-only), `vllmMetrics` (metrics source), `dashboard` (render paths), `serverSettingsView`, `KNOWN_SERVER_TYPES`, webview dropdown. Adding one backend is a scavenger hunt across the whole request path, and every missed branch is silent wrong behavior, not a compile error.

**Idea:** `src/backends/descriptor.ts`, one entry per backend, holding: endpoints (health, model list, context window, metrics source), request policy (accepted params, prefill/auto-continue capability, `tool_choice` quirks), discovery policy (probe chat template or not), render hints (full metrics vs degraded, webview capabilities). The `if`s do not die, they move into the table once and become `descriptor.x` reads. Adding a backend becomes: one table entry + optional metrics mapper + optional renderer path.

**Design already exists:** [sglang-compat-plan.md](./sglang-compat-plan.md) is source-verified research and already specifies the two seams (a small fetch-descriptor table for data acquisition, a per-backend renderer strategy for the dashboard, explicitly NOT `if (serverType === ...)` patches on the shared renderer). Do not redesign, implement that.

**Build trigger:** the day backend number six (SGLang or anything else) is greenlit for implementation.

**Costs:** touches 13 files, behavior-preserving refactor. The wire tripwires (`chatTransport`, `vllmClient`, `vllmStream` tests) are the safety net.

**Priority:** P2 once a backend is scheduled, P4 while the set is frozen at five.
**Effort:** Medium. Mechanical once the descriptor shape is agreed.

## 🛤️ Migration rails for config migrations

**Category:** Architecture (correctness insurance for the next breaking change)
**Status:** Open, trigger-driven. Extract when the next migration is written, not before.

**Problem:** the migration machinery is hand-rolled per migration. THREE exist today (`registryMigration`, `serverRegistryMigration`, `outputLengthMigration`), each re-deriving: marker key naming, the "empty read must NOT set the done marker" rule (that was a real bug class, fixed in review as CR-10), the write-order constraint (registry migration must run before output-length because the latter addresses `{ id, server }` refs that only exist after the former; currently enforced by a comment in `extension.ts`), and the half-migration abort semantics (no marker on write failure).

**Idea:** ~30 lines: an ordered list of `{ id, run(ctx) }` executed at activation, one globalState key storing the last applied id, rules encoded once: marker advances only after ALL writes of a step succeed, an abort stops the chain, ordering is the list order (comments can rot, sequence cannot).

**Build trigger:** the next time a config migration is needed. Write it ON the rails, in the same commit that extracts them. (The trigger has already fired once since this entry was written: `outputLengthMigration` shipped without rails. The "twice is a pattern" bar is cleared; when migration #4 comes, treat rails as part of the migration's definition of done, not an optional extra.)

**Priority:** P3. **Effort:** Low.

## 🧯 Typed error taxonomy on the request path

**Category:** Architecture (silent-failure class prevention)
**Status:** Open, opportunistic. Still string archaeology as of 2026-09-08: `postStream.ts::isGracefulTermination` matches the `TypeError: terminated` message text.

**Problem:** error classification across the request path is string archaeology. `postStream.isGracefulTermination` matches the `TypeError: terminated` message text; review finding CR-3 (2026-09-03) existed precisely because a re-wrap broke that substring match and normal VS Code cancels silently stopped being classified as graceful. `fetchRetry` (never retry aborts/timeouts) and Connection Diagnostics classify the same errors through separate prose inspection. The contract between transport and classifiers is invisible and enforced by nothing.

**Idea:** a small union minted once at the transport boundary (`chatTransport` / `streamReader`): `cancelled | terminated | network | server-status | config`, carried as a property on the error, not inferred from its message. Consumers (graceful classifier, retry policy, diagnostics) switch on data. The string matching survives only as the private fallback that mints the tag.

**Build trigger:** the next real fix that touches the error path anyway. Not worth its own expedition.

**Priority:** P3. **Effort:** Low, but spread across the transport boundary and its three consumers.
