# Feature Ideas: vLLM Capabilities → Better VS Code Experience

**Generated:** 2026-06-06
**Updated:** 2026-09-25 (shipped entries deleted against the code, not against memory: registry, remote presets, usage tracker, OpenRouter providers, output-length picker, centralized auth update. The stale "12 remaining parameters" table was replaced with the passthrough truth. Completed items live in git history, not here.)
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

## ✨ Populate native model-picker metadata

**Category:** Vitamin (picker clarity)
**Status:** Accepted direction, explicitly deferred. Do not implement now.

VS Code's stable `LanguageModelChatInformation.tooltip` is the hover text shown for a model in the model picker. `detail` is the short secondary line rendered alongside the model name. The extension currently leaves both empty even though discovery already knows the server label, backend, wire model ID, context window, output ceiling, capabilities, and OpenRouter routing state.

Populate the stable fields first, then add the still-proposed `editTools` hint so VS Code can prefer `find-replace`, `multi-find-replace`, `apply-patch`, or `code-rewrite` for models trained or tuned for those edit shapes. `maxContextWindowTokens` is also still proposed and can separate the physical server window from the currently selected input and output budgets. Keep every proposed field behind the existing runtime metadata boundary, but make the stable tooltip and detail useful on their own.

**Why it matters:** the picker becomes self-explanatory on hosts that ignore proposal-era icons, banners, and schemas. It also gives users one place to understand which configured preset, server, and wire model a picker entry actually represents.

**Suggested content:**
- `detail`: server display name, backend type, or a compact `server / wire-model` identity.
- `tooltip`: context and output limits, tool and vision support, and current OpenRouter provider or routing mode.
- `editTools`: model-preset-owned preference, with no inference when absent.

**Effort:** Low for stable `detail` and `tooltip`, medium once preset-owned edit-tool metadata and routing-state formatting are included.

---

## ✨ Task-specific model roles

**Category:** Vitamin (workflow routing)
**Status:** Idea, not implemented.

VS Code already permits different models for different task classes. `chat.utilityModel` selects the general utility model for titles, summaries, settings search, and Git review. `chat.utilitySmallModel` selects a fast model for commit messages, pull-request text, rename suggestions, branch names, prompt categorization, and intent detection. `inlineChat.defaultModel` is separate again, and the current main-agent model is independent of all three.

A **Configure Model Roles** command could let the user assign configured vLLM models to Main Chat, General Utility, Fast Utility, and Inline Chat. A fast local model can then handle short mechanical tasks while a stronger tool-calling model handles the agent loop. Later roles can cover planning or implementation only when VS Code exposes stable settings for them.

The UI should show the current assignment, capability warnings, and the effective fallback. It must never silently change explicit user values. The smallest useful slice is Main Chat, General Utility, and Fast Utility, using the two existing utility settings plus the current main-model selection.

**Why it matters:** this is a natural extension of the existing server and model registry. It reduces latency and GPU load for utility prompts and makes mixed local-model fleets usable without hand-editing several VS Code settings.

**Open questions:**
- Should role assignments be global defaults, workspace overrides, or both through the config-file backend?
- Should the extension offer a fast-model recommendation based on configured context, family, and serving metrics?
- How should a role behave when its selected model is temporarily unavailable?

**Effort:** Low to medium, depending on whether role assignment lives in the existing Model Settings webview or gets a separate command.

---

## ✨ Availability health without false alarms

**Category:** Vitamin (operational clarity)
**Status:** Idea, not implemented.

Configured models and live models are different inventories. A user may intentionally keep an old model entry while its server is offline, a model is unloaded, a deployment is being rebuilt, or a remote machine is disconnected. Missing from the picker must not automatically become an error.

A health surface should show configured and available counts separately, then let the user mark entries as parked or ignored. Parked entries remain configured but stop producing repeated warnings until the user reactivates them. Useful state includes last seen, last successful request, server reachability, and whether the model is absent from `/v1/models` versus the whole server being unavailable.

The first UI can be a Dashboard section or view badge. A status-bar warning is justified only for models the user marks as expected to be active, with a grace period and a direct **Run Test & Refresh** action. Never delete or rewrite a configured model based on discovery state.

**Why it matters:** the extension can explain why a model disappeared without turning intentional staleness into dashboard noise.

**Open questions:**
- Should parking be per model, per server, or both?
- Should a recovered parked model reactivate automatically or remain quiet until acknowledged?
- Which state belongs in the config file once the file backend exists?

**Effort:** Medium, mostly state and UX design rather than new inference plumbing.

---

## 🛡️ Native Responses and Anthropic Messages API support

**Category:** Strategic protocol expansion
**Status:** Idea, not implemented. Keep Chat Completions as the default.

VS Code's built-in Custom Endpoint provider now supports OpenAI Responses and Anthropic Messages alongside Chat Completions. vLLM serves `/v1/responses` and `/v1/messages` today, including streamed content, reasoning, and tool events. Supporting those protocols natively would keep the extension aligned with Copilot's current Custom Endpoint feature set and preserve vLLM-specific request passthrough.

OpenAI Responses offers structured input and output items, reasoning events, tool lifecycle events, and conversation continuation through either `previous_input_messages` or `previous_response_id`. vLLM does not allow both continuation forms together. Its response store is disabled by default because stored messages live only in memory and are never removed before server shutdown, so an extension should not assume `previous_response_id` persistence. Stateless `previous_input_messages` or the existing full-history shape is the safer default unless a deployment explicitly enables and understands server-side state.

Anthropic Messages supports text, images, tool use and results, thinking, and redacted-thinking content blocks. vLLM converts these requests into its chat pipeline and streams reasoning back. The research must establish whether vLLM preserves enough signed or encrypted state for VS Code's `includeEncryptedThinking`; the extension should expose that capability only after a live round-trip proves it.

**Possible product shape:**
- Add a per-model `apiType`: `chat-completions`, `responses`, or `messages`.
- Keep one Language Model Chat Provider surface and translate each wire protocol back into the existing VS Code response parts.
- Preserve arbitrary vLLM parameters per protocol, with an explicit parameter policy where one surface cannot carry a key used by another.
- Preserve current cancellation, retries, usage, cost, and tool-repair behavior per transport.
- Add wire tripwires for streaming order, tool calls, reasoning, usage, and continuation.

**Why it matters:** protocol parity is becoming table stakes for model integrations. It may unlock native reasoning state, better tool semantics, and compatibility with model families that do not implement Chat Completions well.

**Risks:** three request bodies, three response grammars, different state semantics, and backend-specific gaps. This is a substantial feature and should follow the config-file and session-storage foundations.

**Effort:** High. Responses first may be the cleaner initial target because OpenAI-style tool and reasoning events map cleanly to the current provider boundary; Messages follows if Anthropic-family preservation proves valuable.

---

## ✨ Inline code completions research

**Category:** Moonshot (new VS Code surface)
**Status:** Research only. No implementation planned yet.

### Where we are

The extension registers a `LanguageModelChatProvider`, so its models power Chat, tools, agents, and BYOK utility flows. They do not automatically power VS Code's ghost-text inline suggestions. The official docs state that BYOK models currently cannot connect to inline suggestions. That requires a separate stable `InlineCompletionItemProvider` registered with `vscode.languages.registerInlineCompletionItemProvider`.

The current request pipeline cannot be reused as-is. It is built for chat messages, tools, images, reasoning, and long generations. Inline completion needs the live `TextDocument`, cursor position, current line, prefix, suffix, selected IntelliSense item, trigger kind, document version, aggressive cancellation, and small latency budgets.

### What is true

- VS Code provides a stable inline-completion API. Providers are called after typing stops, on explicit invoke, and when cycling completions.
- `InlineCompletionContext.triggerKind` distinguishes automatic requests from explicit requests.
- `selectedCompletionInfo` must be respected. A suggestion extending an IntelliSense preview must replace the same range and begin with the selected text.
- vLLM exposes `/v1/completions` for text-generation models.
- FIM-capable code models exist, including the StarCoder2 family, which was trained with fill-in-the-middle.
- The extension can reuse the server registry, authentication headers, model discovery, and remote extension-host placement.

### What is not true

- A BYOK or `LanguageModelChatProvider` model does not automatically receive inline-completion requests.
- VS Code does not send a prepared FIM prompt. The extension receives the document and cursor and must build the request.
- vLLM's OpenAI Completions API does not support the OpenAI `suffix` parameter. When a model uses FIM sentinel tokens, the extension must compose those tokens into the prompt itself.
- A relevant chat model is not automatically a good completion model. Base, code, and instruction-tuned models differ sharply in FIM behavior.
- A local or remote vLLM server is not automatically fast enough. TTFT, queueing, speculative decoding, and network topology decide whether ghost text feels useful.
- The current chat request builder, tool conversion, system-message pipeline, and reasoning handling do not solve inline-completion formatting.

### Smallest credible spike

1. Add a separate opt-in inline-completion model setting rather than reusing the active chat model implicitly. It should point to a server entry and wire model ID, with a documented requirement for a FIM-capable model.
2. Register one provider for trusted file documents. It should debounce automatic requests, honor cancellation, and discard a result if `document.version` changed while the request was running.
3. Build a bounded prompt from current line, preceding file context, cursor suffix, and model-specific FIM markers. Send a short non-streaming `/v1/completions` request with a strict output cap and stop handling for the current syntactic boundary.
4. Return an `InlineCompletionItem` only when the document version and cursor still match. Honor `selectedCompletionInfo` with the required replacement range.
5. Measure TTFT, end-to-end latency, acceptance rate, request cancellation, empty-result rate, and GPU load against at least one FIM model. Test local, SSH, WSL, and Dev Container hosts.

### Product constraints

Inline completion sends code context automatically and repeatedly, so it needs an explicit opt-in and clear documentation about the configured server receiving the prompt. It should remain independent from Copilot inline suggestions and let VS Code manage coexistence between providers. A command can select the completion model and enable it per user or workspace once the request shape is proven.

**Why it matters:** BYOK models currently stop at chat and agents. A successful implementation would make vLLM useful for the most frequent editor interaction as well.

**Effort:** Medium-high research, high production implementation. Do not start before the config-file foundation is settled, because completion-model selection and workspace trust need the same durable configuration model.

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
