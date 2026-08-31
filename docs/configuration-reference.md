# Configuration Reference

> **Quick start:** Run **Add vLLM Server & Model** from the Command Palette to auto-generate model entries. Use this reference when you need to customize advanced settings.

> **Copilot can write this for you:** the extension registers an on-demand **Language Model Tool** (`vllm-copilot_model_schema`) that hands Copilot Chat the model-entry JSON schema plus the parameter resolution rules. Just ask in chat — e.g. *"configure my Qwen3.6 model with Think / No Think modes"* — and Copilot will generate a valid `vllm-copilot.models` entry. The tool serves the bundled `schemas/vllm-copilot-models.schema.json`; no workspace files are created. If your AI doesn't pick it up automatically, force-attach it by typing `#vllmModelSchema` in the chat input.

All settings are under `vllm-copilot` in VS Code Settings (`Ctrl+,`, search `vllm`). There are five top-level settings: `vllm-copilot.models` (array of per-model entries), `vllm-copilot.systemMessageCapture` (capture system messages to `.vllm/system-messages.json`), `vllm-copilot.enableFileLogging` (request/response logs), `vllm-copilot.logBodyLimit` (log truncation), and `vllm-copilot.dashboard.pollIntervalMs` (metrics polling). Everything else lives on each model entry.

**Each model entry is self-contained** — it carries its own `serverUrl`, `requestHeaders`, token budgets, capabilities, and params.

---

## Model Entry Fields

| Field | Default | Description |
|-------|:-------:|-------------|
| `serverUrl` | — | **Required.** Server URL (OpenAI-compatible). Each model targets its own server. |
| `serverType` | `vllm` | Backend protocol. `vllm` \| `lmstudio` \| `llamacpp` \| `ollama` \| `openrouter`. **Set automatically by Add Server**, and auto-detected in Model Settings for unconfigured models (from `/v1/models`, or a configured sibling's type). Missing always means `vllm`. Manual third-party entries must set this — the extension never probes at runtime. |
| `serverDisplayName` | — | Optional **server label** shown in the Dashboard tree and the Model Settings server dropdown instead of the raw URL (e.g. `"IT Server for GLM5.2"`). Server-scoped, stored per model: the first non-empty value among the models sharing a server identity (URL + headers) wins; **Rename Server** (right-click a server node in the Dashboard) writes it to every model sharing that URL, so hand-edited partial configs may differ. Empty/omitted shows the URL. Not applicable to OpenRouter. |
| `provider` | — | ⚡ **OpenRouter only.** The exact provider slug (from `GET /api/v1/models/{id}/endpoints`) to force routing to that provider via `provider: { only: [slug] }`. Use the **Provider** dropdown in Model Settings — never hand-derive. Omitted/empty = Auto. |
| `routingMode` | `standard` | ⚡ **OpenRouter only.** How OpenRouter sorts/chooses among eligible providers when routing is **Auto** (no `provider` pinned): `standard` (price-weighted load balancing, no suffix), `nitro` (throughput-first + priority tier → wire id `:nitro`), `exacto` (quality/tool-calling-first → wire id `:exacto`). Ignored when a provider is pinned. Set via the **Routing** dropdown in Model Settings. |
| `requestHeaders` | `{}` | HTTP headers for this server (auth, routing). **Isolated** — never shared across servers. |
| `id` | — | **Required.** Unique entry key. Add flow sets this to `"<model> on <host>"`. |
| `vllmModelId` | same as `id` | Actual model ID on the vLLM server (for aliases). |
| `displayName` | same as `id` | Human-readable name in the model picker. |
| `family` | auto-detected | Model family (e.g. `qwen3_5`, `llama`). From HuggingFace or extracted from model ID. |
| `maxOutputTokens` | `4096` | Max tokens per response — a **number**, or an ordered **array** of token counts. An array renders a **second, independent model-picker dropdown** ("Output Length"), decoupled from `modelModes` (behavior): the **first element is the default AND the desired output budget**; entries above the model's clamped ceiling are dropped (if the head drops, the next survivor becomes default). When the dropdown is shown, the user's pick **owns** the request's `max_tokens` — outranking any per-mode/`defaultParams` `max_tokens` — **and is the advertised output budget**: a pick change re-publishes model metadata (same mechanism as mode switches), so a shorter pick grows the advertised prompt budget (context − output). Omit the array (or provide <2 usable values) for no dropdown — there is no auto-derived menu. **Do not combine an array with `max_tokens` in `modelModes`/`defaultParams`:** VS Code delivers the dropdown's default even when untouched, so those values become completely dead config — the picker replaces that layer, it does not merely outrank it. |
| `maxInputTokens` | computed | Auto-computed as the server context window minus the **effective output budget** (resolved `max_tokens`: Output Length pick when `maxOutputTokens` is an array > `modelModes` entry > `defaultParams.max_tokens` > budget). Set only to reduce further — an explicit pin owns the split, so a shorter output-length pick then no longer grows the input budget. |
| `estimateCharsPerToken` | `3.5` | Chars-per-token for local token estimation. |
| `defaultParams` | — | Model-scope generation params. Unset params are omitted — the server's default applies. Layered under `modelModes`. |
| `modelModes` | — | Switchable named presets (Think/No Think, etc.). Bundled presets auto-applied by **Add vLLM Server & Model**; for existing entries, hand-edit and copy from [`model-configs/`](../model-configs/). |
| `defaultMode` | first mode | Which mode is active before the user picks one. |
| `capabilities.toolCalling` | `true` | Model supports tool/function calling. |
| `capabilities.imageInput` | `false` | Model supports vision/image input. |
| `streamInactivityTimeout` | `0` (off) | SSE stream timeout in ms. `0` = wait indefinitely. |
| `initialResponseTimeoutMs` | `600000` | Budget in ms for the server to send the **first response headers**. `0` = wait indefinitely. Raise it if the server is slow to start responding (model loading / queue backlog). |
| `autoContinueRetries` | `1` | Non-negative integer retry count for empty/truncated responses (assistant prefill). Invalid values are clamped safely; `0` = off. |
| `systemMessageReplacementsFile` | — | Path to a JSON file of `{ ruleName, find, replace }` pairs applied to every system message. See [System Message Replacements](#system-message-replacements) below. |
| `cost` | — | Optional per-model cost rates for the dashboard **Token Usage** tracker (per 1,000,000 tokens). See [Token Usage & Cost](#token-usage--cost) below. |

**Resolution chain (highest wins):** server defaults (unset params are omitted from the request) → model `defaultParams` → the selected `modelModes` entry.

### Backend-specific context resolution

The context window comes from the **backend's own documented endpoint** (never guessed, never fabricated — a model without one is refused):

| `serverType` | Endpoint | Field |
|---|---|---|
| `vllm` | `GET /v1/models` | matching `data[].max_model_len` |
| `lmstudio` | `GET /api/v1/models` | matching loaded instance `config.context_length`, else `max_context_length` |
| `llamacpp` | `GET /props?model=<encoded id>` | `default_generation_settings.n_ctx` |
| `ollama` | `GET /api/ps` | matching `models[].context_length` (model must be loaded) |
| `openrouter` | `GET https://openrouter.ai/api/v1/models` (the **catalog**) | match the requested id **verbatim** (variants are separate entries); `context_length` → `top_provider.context_length` (smallest positive wins); output ceiling from `top_provider.max_completion_tokens` / `per_request_limits.completion_tokens`, falling back to 10% of the window (capped). The exact-model endpoint is deliberately NOT used — it resolves variants inconsistently. |

`maxInputTokens` is computed from that window (window minus the effective output budget, the resolved `max_tokens`) and can only clamp it further. A server that is unreachable (or reports no valid window) never silently removes the model from the picker: the model stays visible, marked **offline** with the connection error in its hover. Budgets are still never fabricated: the offline row advertises the window from the last successful connection this session (labeled stale, your `maxInputTokens` clamp included) or, if the server has not answered yet, only limits you actually configured; unknown values appear as explicitly labeled 1-token placeholders, never built-in defaults. Server health is kept in memory only, so nothing stale survives a restart. While any model is offline, lookups serve the last-known list instantly and re-check the servers quietly in the background; when a server recovers, the picker updates itself. Deliberate refreshes (settings changes, **Test & Refresh Models**, mode or output-length picks) always probe live.

---

## Parameters for `defaultParams` and `modelModes`

Any vLLM chat body field except `model`, `messages`, `stream`, `stream_options`. *(vLLM-only)* marks params OpenAI does not accept.

> **Note:** `max_tokens` sets the **output budget** for its scope. In a `modelModes` entry it gives that mode its own response ceiling; in `defaultParams` it sets the model-scope budget. It overrides `maxOutputTokens` for the request and is clamped to the model's context window and the server-reported output ceiling. Prefer per-mode via `modelModes`. **If `maxOutputTokens` is an array, the user's dropdown selection overrides every `max_tokens` layer above** — modes then describe behavior only, not length.

| Param | Description |
|-------|-------------|
| `temperature` | Sampling temperature (0–2). Omitted when unset — the server's default applies. `0` = greedy |
| `top_p` | Nucleus sampling threshold (0–1). Omitted when unset — the server's default applies |
| `max_tokens` | Output budget for this scope. Overrides `maxOutputTokens` (clamped to the context window and the server-reported output ceiling). Set per-mode via `modelModes` to give a mode its own response ceiling. Superseded by the Output Length pick when `maxOutputTokens` is an array |
| `top_k` | Top-k sampling (int). −1 = disabled *(vLLM-only)* |
| `min_p` | Minimum probability threshold (0–1) *(vLLM-only)* |
| `presence_penalty` | Topic-repetition discouragement (−2 to 2) |
| `frequency_penalty` | Token-repetition discouragement (−2 to 2) |
| `repetition_penalty` | Repetition penalty (1.0 = none) *(vLLM-only)* |
| `length_penalty` | Beam-search length penalty (1.0 = none) *(vLLM-only)* |
| `seed` | Random seed for reproducibility |
| `stop` | Stop sequences (string or array of strings) |
| `stop_token_ids` | Stop on token IDs *(vLLM-only)* |
| `include_stop_str_in_output` | Include the stop string in output (default false) *(vLLM-only)* |
| `ignore_eos` | Ignore EOS and keep generating (use with `min_tokens`) *(vLLM-only)* |
| `min_tokens` | Minimum output tokens before stop sequences are honored |
| `skip_special_tokens` | Strip special tokens from output (default true) *(vLLM-only)* |
| `spaces_between_special_tokens` | Insert spaces between special tokens (default true) *(vLLM-only)* |
| `truncate_prompt_tokens` | Cap prompt length server-side (−1 = none) *(vLLM-only)* |
| `thinking_token_budget` | Max reasoning tokens (requires `--reasoning-parser`; −1 = unlimited) *(vLLM-only)* |
| `bad_words` | Words the model must not generate *(vLLM-only)* |
| `repetition_detection` | N-gram repetition early-stop: `{ max_pattern_size, min_count, min_pattern_size }` *(vLLM-only)* |
| `structured_outputs` | Token-level constraints: `json`, `regex`, `choice`, or `grammar` (mutually exclusive) *(vLLM-only, ≥ v0.12.0)* |
| `chat_template_kwargs` | vLLM chat template params (e.g. `{ "enable_thinking": true }`) *(vLLM-only)* |
| `reasoning_effort` | Reasoning effort (e.g. `high`, `max`, `none`, `xhigh`). On vLLM this auto-maps to `chat_template_kwargs.enable_thinking` (`high`/`max` → true, `none` → false) |
| `allowed_token_ids` | Restrict generation to these token IDs *(vLLM-only; niche)* |

> **Not enabled by default:** `repetition_detection` is **off** unless you add it to a model's `defaultParams` or a mode. The n-gram detector (`max_pattern_size: 5, min_pattern_size: 2, min_count: 3`) triggers on structured output like XML tables, JSON arrays, and code loops — not just actual repetition — so it is opt-in. If you want it, add it per-model: `"repetition_detection": { "max_pattern_size": 5, "min_pattern_size": 2, "min_count": 3 }`.

---

## Dashboard

The **vLLM Dashboard** sidebar shows live metrics for each configured vLLM server. Open it with the **V** icon in the activity bar (left sidebar). Command alternative: **View → vLLM-Copilot → Dashboard**.

### Server Metrics (per server, collapsible)

| Metric | Source | Description |
|---|---|---|
| **Models** | `/v1/models` + Prometheus + config | All served model names/aliases (collapsible subtree) |
| **Context Window** | `/v1/models` | `max_model_len` from server, formatted as "32k" |
| **KV Cache** | Prometheus `kv_cache_usage_perc` | GPU KV cache utilization (0–100%) |
| **KV Cache Hit** | Prometheus `prompt_tokens_total` vs `prompt_tokens_cached_total` | Percentage of tokens served from KV cache |
| **Avg TTFT** | Prometheus `time_to_first_token_seconds` | Time to first token (ms) |
| **Speed** | Prometheus `request_generation_tokens` ÷ `request_decode_time_seconds`, and `request_prompt_tokens` ÷ `request_prefill_time_seconds` | `Output` = Σ generation tokens / Σ decode time (tok/s, output-only — excludes prefill). `Prefill` = Σ prompt tokens / Σ prefill time (tok/s, includes cache-served tokens). Falls back to TPOT inversion when the pooled metric is absent |
| **Running** | Prometheus `num_requests_running` | Active requests being processed |
| **Waiting** | Prometheus `num_requests_waiting` | Requests queued, waiting for GPU |
| **MTP** | Prometheus `spec_decode_*` | Speculative decoding: acceptance %, draft depth, total proposals (only when active) |
| **Preemptions** | Prometheus `num_preemptions_total` | Only shown when > 0 |
| **Evictions** | Prometheus `request_eviction_total` | Only shown when > 0 |

### Settings

| Setting | Default | Description |
|---|---|---|
| `vllm-copilot.dashboard.pollIntervalMs` | `15000` | How often to refresh metrics (ms). Click **Refresh Interval** in the sidebar to change — enter `15s`, `30s`, `1m`, etc. Also editable in Settings |

### Last Request Details

Under each server in the Dashboard tree, a collapsible **Last Request** node shows detailed stats from the most recent completed request:

| Field | Source | Description |
|---|---|---|
| **Model** | Config | Model ID used for the request |
| **Time** | Local | Relative timestamp (e.g. "12s ago") |
| **Input tokens** | vLLM usage | Prompt tokens consumed |
| **Output tokens** | vLLM usage | Completion tokens generated |
| **Total tokens** | vLLM usage | Sum of input + output + reasoning |
| **Cached tokens** | vLLM usage | Tokens served from KV cache (requires `--enable-prompt-tokens-details`) |
| **Cache creation** | vLLM usage | Cache tokens created during this request (requires `--enable-prompt-tokens-details`) |
| **Reasoning tokens** | vLLM usage | Tokens spent in thinking/reasoning (if applicable) |
| **Queue time** | Per-request metrics | Time spent in queue before generation (requires `--enable-per-request-metrics`) |
| **TTFT** | Per-request metrics | Time to first token (requires `--enable-per-request-metrics`) |
| **Generation time** | Per-request metrics | Total generation duration (requires `--enable-per-request-metrics`) |
| **Throughput** | Derived | Output tokens / generation time |

When server flags aren't set, the node shows a hint: "Start vLLM with `--enable-prompt-tokens-details` and `--enable-per-request-metrics` for full details."

> **Cost row:** when the model has a `cost` config, the Last Request node also shows a **Cost** row — the estimated cost of that single request, derived from the model's per-1M rates. This is the per-prompt money-verification view.

### Token Usage & Cost

Under each server, a collapsible **Token Usage and Cost** node shows **cumulative** token consumption across all requests (not just the last one). It updates **immediately** after every completed prompt — it does not wait for the metrics poll interval. The node is **model-first**: one collapsible entry per model (labeled by `displayName`), each with **Today** and **Overall** rows. For the design and data model behind this feature, see [usage.md](usage.md). **OpenRouter servers do not show this node** — every relay model already carries its own token/cost rows in its expanded details, so a server-level aggregate would be pure duplication. (Usage is still recorded, and **Reset Usage** stays available via the palette command.)

| Row | Description |
|---|---|
| **Model node** | One collapsible entry per model; its description carries the price: `$11.51 today and $31.13 total` (today's cost + all-time cost). |
| **Today** | Today's tokens: `800k in · 200k cached · 500k out` (price is on the model line above). |
| **Overall** | All-time tokens plus `· started 5d ago` (when recording began). |
| **Reset Usage** | Right-click the **Token Usage and Cost** node → clear all usage for this server (all-time, daily, started-at). The Last Request node is kept. |

The price sits on the **model line** (its collapsed summary: `$11.51 today and $31.13 total`); the **Today / Overall** rows are token-only — `800k in · 200k cached · 500k out`, where `in` **excludes** cache and `in + cached = total input` (cached = cache-*read* input tokens). Costs use **fine precision** — sub-cent amounts keep up to 6 decimals (`$0.0007`) rather than collapsing to `$0.00`; AI Credits keep 2 decimals. **OpenRouter models prefer their actual reported cost (`usage.cost`) when present**, falling back to the configured per-1M rates; the two are never summed. Token counts round to whole thousands. **There is no server-level cost sum** — models on one server may use different currencies, so each model's price uses its own currency. Sum costs across models manually. Currency decoration uses a small static map — `$` (USD), `€` (EUR), `£` (GBP), `¥` (JPY/CNY), `credits` (AI Credits) — and any other currency falls back to its raw code (`EUR 12.35`); no currency library is bundled.

**Entry points (right-click the Token Usage and Cost node):** **Set Cost…** configures the per-1M rates through guided prompts (model → input/output/cached-input → currency) and writes the `cost` block for you; **Reset Usage** clears the server's counters. The dashboard re-renders immediately after either.

**Cost configuration** — optional per-model rates, in **currency units per 1,000,000 tokens**:

```jsonc
"vllm-copilot.models": [
  {
    "id": "deepseek-v4 on localhost:8000",
    "vllmModelId": "DeepSeek/V4-Flash",
    "serverUrl": "http://localhost:8000",
    "cost": {
      "input": 0.14,        // $ per 1M fresh (uncached) input tokens
      "output": 0.28,       // $ per 1M output tokens (includes reasoning)
      "cachedInput": 0.014, // $ per 1M cache-read input tokens
      "currency": "USD"     // display unit; default "USD"
    }
  }
]
```

- **All rates are per 1,000,000 tokens.** Most providers publish per-1M prices (OpenAI, Anthropic, DeepSeek); if yours bills per 1K, multiply by 1000.
- **`currency`** is a display label only — enter the rates *in that unit*. Use `"AI Credits"` to compare with the Copilot model picker: 1 AI credit = $0.01, so enter credit values directly (no conversion is applied).
- **Rates are derived at render time, never stored.** Edit a rate and every historical total re-prices instantly — no migration.
- **Omit `cost` or set all rates to `0`** → no cost lines for that model (e.g. a free local server).
- **Cost formula** (per request/bucket): `(prompt − cached)/1M × input + cached/1M × cachedInput + completion/1M × output`. Fresh input is priced at `input`; cache-read input at `cachedInput`.

**Reset via command palette** — `vLLM-Copilot: Reset Usage` lets you pick *All servers* or a single server.

---

## Typical Example

A working chat model — minimum viable config. No modes, no custom params, just authorizes a model on a server. Everything else uses defaults (`maxOutputTokens: 4096`; sampling params are omitted so the server's defaults apply):

```json
"vllm-copilot.models": [
  {
    "id": "Qwen/Qwen3.6-27B on localhost:8000",
    "vllmModelId": "Qwen/Qwen3.6-27B",
    "serverUrl": "http://localhost:8000"
  }
]
```

> **Tip:** Run **Add vLLM Server & Model** to generate this — it auto-detects `family`, `max_model_len`, and capabilities, and applies a bundled preset if one fits.

---

## Full Syntax Reference

> ⚠️ **This is a syntax reference, not a recommended starting point.** Do not copy these values — they cover every supported field/param so you can see the JSON shape. For real starting points, use **Add vLLM Server & Model** or see the [Typical Example](#typical-example) above.

```jsonc
"vllm-copilot.models": [
  {
    // ── Identity ───────────────────────────────────────────
    "id": "Qwen/Qwen3.6-27B on localhost:8000",   // required; unique preset key (Add flow: "<model> on <host>")
    "vllmModelId": "Qwen/Qwen3.6-27B",            // server-side model ID (use for aliases)
    "displayName": "Qwen 3.6 27B (debug)",            // picker label
    "family": "qwen3_5",                               // picker grouping; auto-detected from HF

    // ── Server & auth (per-model, isolated) ──────────────
    "serverUrl": "http://localhost:8000",             // required
    "serverDisplayName": "IT Server for GLM5.2",      // optional Dashboard label (Rename Server sets this on all sibling models)
    "requestHeaders": {                               // auth/routing; never shared across servers
      "Authorization": "Bearer <your-token>",
      "X-Custom-Header": "<your-value>"
    },

    // ── Token budgets ─────────────────────────────────────
    // `max_model_len` (context window) is auto-discovered from /v1/models — do NOT set it here.
    "maxOutputTokens": 8192,                           // max tokens per response (default 4096)
    "maxInputTokens": 28672,                           // optional; clamp below (window − effective output budget)
    "estimateCharsPerToken": 3.5,                      // for local token estimation (default 3.5)

    // ── Capabilities ──────────────────────────────────────
    "capabilities": {
      "toolCalling": true,                             // default true
      "imageInput": false                             // default false
    },

    // ── Stream & retry ────────────────────────────────────
    "streamInactivityTimeout": 30000,                  // ms with no SSE data before abort; 0 = wait forever
    "initialResponseTimeoutMs": 600000,                // ms for the server to send the first response headers; 0 = wait forever
    "autoContinueRetries": 1,                          // retries on empty response via assistant prefill; 0 = off

    // ── System message replacements (optional) ────────────
    "systemMessageReplacementsFile": ".vllm/prompt-replacements.json",

    // ── defaultParams: always-on, model-scope ────────────
    // Layered under selected mode. Unset sampling params are omitted — the server default applies.
    "defaultParams": {
      // — Standard sampling (OpenAI-compatible) —
      "temperature": 0.7,                // 0–2. 0 = greedy
      "top_p": 0.95,                     // 0–1, nucleus threshold
      "top_k": 40,                       // int; −1 = disabled (vLLM-only)
      "min_p": 0.05,                     // 0–1, minimum probability threshold (vLLM-only)
      "presence_penalty": 0.0,           // −2 to 2
      "frequency_penalty": 0.0,          // −2 to 2
      "repetition_penalty": 1.0,         // 1.0 = none (vLLM-only)
      "length_penalty": 1.0,             // beam-search only; 1.0 = none
      "seed": 42,                        // int for reproducibility; omit for random

      // — Stop conditions —
      "stop": ["\n\nUser:", "\n\n\n"],   // str | list[str]
      "stop_token_ids": [151645, 151643],// list[int] (vLLM-only)
      "include_stop_str_in_output": false,// bool, default false (vLLM-only)
      "ignore_eos": false,               // ⚠️ true = never stops on EOS; use with min_tokens (vLLM-only)
      "min_tokens": 1,                   // ignore stop until N tokens emitted

      // — Output detokenization —
      "skip_special_tokens": true,        // default true (vLLM-only)
      "spaces_between_special_tokens": true, // default true (vLLM-only)
      "truncate_prompt_tokens": -1,      // −1 = none; cap prompt length server-side (vLLM-only)

      // — vLLM-specific features —
      "bad_words": ["I cannot", "I apologize", "As an AI"], // blocked tokens (vLLM-only)
      "repetition_detection": {          // N-gram early-stop; distinct from repetition_penalty (vLLM-only)
        "max_pattern_size": 4,           // longest N-gram tracked
        "min_count": 3,                  // repetitions before stop fires
        "min_pattern_size": 1            // ignore patterns shorter than this
      },
      "thinking_token_budget": 4096,     // reasoning models; −1 = unlimited (needs --reasoning-parser)
      "allowed_token_ids": [13, 330, 1463], // only allow these token IDs (vLLM-only; niche)

      // — Chat template (per-model) —
      "chat_template_kwargs": {           // passed to the tokenizer's chat template
        "enable_thinking": true,
        "preserve_thinking": true
      },

      // — Structured output (pick ONE: json | regex | choice | grammar) —
      // vLLM ≥ v0.12.0. All four are mutually exclusive within one params block.
      "structured_outputs": {
        "json": {
          "type": "object",
          "properties": { "answer": { "type": "string" } },
          "required": ["answer"]
        }
        // "regex": "^\\d{4}-\\d{2}-\\d{2}$"
        // "choice": ["yes", "no"]
        // "grammar": "root ::= [a-z]+"
      }
    },

    // ── modelModes: switchable presets; mode params override defaultParams ──
    "modelModes": {
      "Think": {
        "chat_template_kwargs": { "enable_thinking": true, "preserve_thinking": true },
        "temperature": 1.0,
        "top_p": 0.95,
        "top_k": 20,
        "thinking_token_budget": 8192
      },
      "No Think": {
        "chat_template_kwargs": { "enable_thinking": false },
        "temperature": 0.7,
        "top_p": 0.8,
        "presence_penalty": 1.5
      },
      "Strict JSON": {
        "temperature": 0.1,
        "top_p": 0.1,
        "structured_outputs": { "json": { "type": "object" } }
      },
      "Yes/No": {
        "structured_outputs": { "choice": ["yes", "no"] }
      }
    },
    "defaultMode": "Think"                            // must match a modelModes key
  }
]
```

**Verified against vLLM's OpenAI-compatible API reference** (June 2026): every parameter name above is sent verbatim in the request body. Names marked *(vLLM-only)* are accepted by vLLM's Chat API but not by OpenAI. Field semantics, ranges, and defaults match the upstream `SamplingParams` definition.

---

## Multiple Servers with Isolated Auth

Each model targets its own server; a server's `requestHeaders` are used only for that server and never shared:

```json
{
  "id": "remote-model",
  "vllmModelId": "Some/Model",
  "serverUrl": "https://remote-vllm.example.com",
  "requestHeaders": { "Authorization": "Bearer <token>" }
}
```

---

## System Message Replacements

After capturing system messages (see [Custom System Prompt](./custom-system-prompt.md)), create a JSON file of find/replace rules. Each rule is an exact substring match applied sequentially — empty `replace` removes the matched text:

```json
[
  {
    "ruleName": "Remove SafetyRules block",
    "find": "Follow Microsoft content policies.\nAvoid content that violates copyrights.\nIf you are asked to generate content that is harmful, hateful, racist, sexist, lewd, or violent, only respond with \"Sorry, I can't assist with that.\"\nKeep your answers short and impersonal.",
    "replace": ""
  },
  {
    "ruleName": "Shorten identity rule",
    "find": "When asked for your name, you must respond with \"GitHub Copilot\". When asked about the model you are using, you must state that you are using",
    "replace": "Your name is Copilot. You use"
  }
]
```

Then set `systemMessageReplacementsFile` on the model entry to point to this file. Relative paths are resolved against the **workspace root** at request time, so `.vllm/prompt-replacements.json` refers to the workspace's `.vllm/` folder. Absolute paths work too (and are what the personality picker stores).

**How it works:**
- Exact substring match (no regex)
- Applied to **every** system message (not just the first) — chat, progress, title generation, etc.
- Applied in array order, sequentially
- Matched `ruleName`s are logged in the capture file so you can verify

**Getting the exact text to match:** enable `systemMessageCapture`, chat once, then open `.vllm/system-messages.json`. Copy the text from `receivedContent`, escape newlines as `\n` in JSON.

---

## Personality Presets

The extension ships with four pre-built replacement files that transform Copilot's personality. Each preset removes safety boilerplate, identity rules, and generic fluff — then injects distinct behavioral instructions. Pick one, point your model at it:

| Preset | File | Personality |
|--------|------|-------------|
| **Supportive Mentor** | `prompt-replacements/prompt-replacements-supportive-mentor.json` | Patient mentor who builds better engineers. High standards, honest feedback, explains the why, celebrates progress. Invested in you, not just your code. |
| **Critical Senior Dev** | `prompt-replacements/prompt-replacements-critical-senior.json` | Sharp collaborator who challenges assumptions and surfaces trade-offs. Helps push the project forward. |
| **Sarcastic Robot** | `prompt-replacements/prompt-replacements-sarcastic-robot.json` | Brilliant, condescending, politically incorrect. Finds human code amusingly primitive — but fixes it anyway. |
| **Spartan** | `prompt-replacements/prompt-replacements-spartan.json` | Absolute minimalism. Zero fluff. Short answers. Code first, words only when necessary. |

**Usage:** In the **vLLM Model Settings** sidebar, pick a model and choose a personality from the dropdown in the model's **General** section. Or use `Ctrl+Shift+P` → **Set Model Personality**. Picking a personality copies it into the extension's **global storage** (`personalities/`) so it follows you across workspaces and survives extension upgrades. **Default (no personality)** clears the replacement and restores Copilot's original system prompt.

Or set the path manually on the model entry:

```json
{
  "vllm-copilot.models": [
    {
      "id": "my-model",
      "serverUrl": "http://localhost:8000",
      "systemMessageReplacementsFile": "C:/.../globalStorage/vllm-copilot/personalities/prompt-replacements-supportive-mentor.json"
    }
  ]
}
```

Relative paths resolve against the **workspace root**; absolute paths (like the global storage path the picker writes) work from any workspace.

**Want to customize a preset?** Bundled presets are **extension-owned and re-synced on every apply** — editing the global copy of a bundled preset gets clobbered the next time you re-apply it. Put custom behavior in your own replacement file via `systemMessageReplacementsFile` (relative `.vllm/` paths still work) or a user-created personality in global storage. See [System Message Replacements](#system-message-replacements).

---

## Diagnostics

| Setting | Default | Description |
|---------|---------|-------------|
| `systemMessageCapture` | `false` | Capture unique Copilot system messages to `.vllm/system-messages.json` |
| `enableFileLogging` | `false` | Write detailed request/response logs (headers and bodies **as-is, unredacted**) to a daily file. Use **Open Log File** to view |
| `logBodyLimit` | `4000` | Maximum characters of request/response bodies to log per entry. `0` = no truncation |

---

## Troubleshooting

**First, run the right command:**

| If… | Run this |
|---|---|
| You want to know whether your configured servers are reachable and which models loaded | **Test & Refresh Models** — pings `GET /v1/models` per configured server, lists models, surfaces full error causes for failed servers, and warns if VS Code's network gating settings (`http.proxySupport`, `http.fetchAdditionalSupport`, `http.systemCertificates`) are non-default. TLS failures get a conditional certificate-trust suggestion appended. On failure it offers to escalate to **Diagnose Connection**. |
| A model or server won't connect and you need to find out **why** (TLS, proxy, DNS, cert chain) | **Diagnose Connection** — runs a deep multi-test report against one URL. See below for what it gathers. |

**What Diagnose Connection gathers (goes to its own Output channel — copy-paste to share):**

- **Environment:** extension version, Node version, VS Code version, platform
- **Target URL** + parsed host/port
- **DNS resolution** for the hostname
- **TCP connect** test against host:port
- **Node fetch** (OpenSSL, the same path VS Code's patched `globalThis.fetch` uses) — status code or unwrapped error
- **System-native fetch** for comparison: PowerShell `Invoke-WebRequest` (SChannel) on Windows, `curl` (Secure Transport / OpenSSL) elsewhere
- **Certificate chain inspection** (only on TLS errors, Windows: SChannel chain via PowerShell, others: `openssl s_client`)
- **Proxy detection:** WinHTTP config (Windows) + Windows IE/registry proxy settings (Group Policy can set these silently)
- **VS Code settings dump:** `http.proxy`, `http.proxySupport`, `http.fetchAdditionalSupport`, `http.systemCertificates`, `http.systemCertificatesNode`, `http.noProxy`, `http.proxyStrictSSL`, etc.
- **Env vars:** `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED` (proxy URLs are credential-redacted in the report)
- **Conclusion:** a one-line classification — *reachable* (TLS valid), *auth failure* (401/403), *proxy auth* (407), *server error* (5xx), *TLS trust gap* (system native worked, Node didn't), *DNS/TCP failure*, *proxy/config issue*

> **Why both a Node fetch and a system-native fetch?** If Node fetch fails with a TLS error but PowerShell/curl succeeds, that points to a cert trust gap — e.g. a missing corporate intermediate — but it is not proof of one: the two paths can also use different proxy routing or trust stores. The full error cause is in the report (e.g. `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`).

### Common issues

| Problem | Solution |
|---------|----------|
| Can't connect | Run **Test & Refresh Models**. If it fails, run **Diagnose Connection** on the failing URL. Confirm `vllm serve` is running and the firewall allows the port. |
| Requests fail on a corporate network | Set VS Code's `http.proxy` setting (e.g. `http://proxy.corp:8080`). The extension uses VS Code's patched `globalThis.fetch` (installed by the extension host at startup), which respects `http.proxy`, `http.noProxy`, and the `HTTP(S)_PROXY` environment variables per-request. Loopback hosts are always bypassed. The patched fetch loads the OS certificate store (`http.systemCertificates`, on by default), so TLS-inspecting proxies and internally-issued server certs work without extra setup. The patch is gated by `http.proxySupport` (default `override`) and `http.fetchAdditionalSupport` (default `true`) — both must stay enabled. |
| `fetch failed` / certificate errors behind a reverse proxy | The certificate may be expired, self-signed, or trusted differently by your OS than by VS Code. If it is valid and trusted by your OS, try `"http.systemCertificatesNode": true` in your user settings and reload the window (`Developer: Reload Window`), or run **Diagnose Connection** to confirm. Note: `http.proxyStrictSSL: false` does **not** disable TLS verification for fetch (undici always verifies). |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `SELF_SIGNED_CERT_IN_CHAIN` on a corporate reverse proxy | The proxy may not be sending the intermediate CA, or the OS and Node trust stores differ. If your certificate is valid and trusted by the OS, try VS Code's own `"http.systemCertificatesNode": true` setting, or run **Diagnose Connection**. See [Known limitations](#known-limitations) below. |
| 401 Unauthorized | The model's `requestHeaders` are wrong — edit the model entry or re-run **Add vLLM Server & Model** |
| No models in picker | Run **Test & Refresh Models**. Verify each model has a `serverUrl` and that `GET /v1/models` returns entries |
| Copilot spins forever | Check Output channel (`View → Output → vLLM-Copilot`) for errors |
| Tool calls fail | Start vLLM with `--enable-auto-tool-choice --tool-call-parser <parser>` |
| Thinking mode doesn't think | Start vLLM with `--reasoning-parser <parser>` |

### Known limitations

#### Certificate errors behind a reverse proxy

A reverse proxy in front of vLLM may send only its leaf certificate without the intermediate CA, which can make VS Code's patched `globalThis.fetch` reject the TLS handshake (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN`, …). The same errors can also come from an expired or self-signed certificate, or from the OS trust store and Node's loaded certificates differing — the two transports can use different proxy routing too.

**A conditional setting:**

```jsonc
"http.systemCertificatesNode": true
```

Set it in your **user settings** (`Preferences: Open User Settings (JSON)`), then reload the window (`Developer: Reload Window`). It's experimental and defaults to `false`. It changes which trust store Node loads, so it only helps when the certificate is actually valid and already trusted by your OS — it cannot repair an expired certificate. Run **Diagnose Connection** to confirm what's actually wrong.

This extension surfaces this automatically: when an error looks like a certificate problem, chat requests, **Test & Refresh Models**, and the **Add Server** dialog suggest running **Diagnose Connection**, and mention the setting above as a conditional step.

---

## Commands

| Command | Description |
|---------|-------------|
| **Add vLLM Server & Model** | Guided flow: enter a server URL + optional API key/headers, discover its models, then apply a bundled preset (if one fits) or auto-configure from HuggingFace, and save |
| **Test & Refresh Models** | Verify every configured server is reachable, list models. If any connection fails, shows the full error cause and offers to run a deep diagnostic. TLS failures get a conditional certificate-trust suggestion (which may include `http.systemCertificatesNode`). Also checks VS Code's network gating settings (`http.proxySupport`, `http.fetchAdditionalSupport`, `http.systemCertificates`) and warns if any are non-default |
| **Diagnose Connection** | Deep network diagnostic: compares PowerShell (SChannel) vs Node `fetch` (OpenSSL), checks DNS/TCP, dumps VS Code settings + env vars, builds SChannel cert chain (Windows). Report goes to a dedicated Output channel for copy-pasting |
| **Open Log File** | Open today's debug log |
| **Configure Utility Model** | Switch the utility model used for MCP servers and Copilot agent mode (`mainAgent`, `copilot`, or `none`) |
| **Clear Log Files** | Delete all debug log files (except the currently active one) |

The following appear under the **vLLM-Copilot: Utilities** category — maintenance tools, not daily workflow:

| Command | Description |
|---------|-------------|
| **Diagnose Connection** | Deep network diagnostic: compares PowerShell (SChannel) vs Node `fetch` (OpenSSL), checks DNS/TCP, dumps VS Code settings + env vars, builds SChannel cert chain (Windows). Report goes to a dedicated Output channel for copy-pasting |
| **Clean Copilot Sessions** | Multi-select dialog: pick which workspaces to wipe Copilot sessions from |