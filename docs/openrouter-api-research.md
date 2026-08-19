# OpenRouter API — Dashboard Data Research

**Date:** 2026-08-19
**Purpose:** Enumerate every data point OpenRouter exposes that could populate the server dashboard, now that the vLLM metrics rows are backend-agnostic and most vLLM-specific rows are gone for non-vLLM servers.
**Sources:** Official OpenRouter docs (`https://openrouter.ai/docs/llms.txt` index), the OpenRouter OpenAPI spec (`https://openrouter.ai/docs/openapi/openapi.yaml`, fetched 2026-08-19), and the official TS SDK type docs.

> **Headline finding:** OpenRouter is a *relay / model selector*, not a server. Almost every interesting value is **model-level** (context, pricing, capabilities, benchmarks) or **per-request** (which provider served it, actual cost, latency, tokens). It is **not** a server-level dashboard in the vLLM sense. Any dashboard work must treat OpenRouter's "server node" as a *model collection* or a *per-model* view, not a single-server stats view.

---

## 1. Model catalog + exact-model metadata (`GET /api/v1/models`, `GET /api/v1/model/{author}/{slug}`)

The `data[]` entries (and the single-model lookup `data` object — **same schema**) expose:

| Field | Type | Dashboard value |
|---|---|---|
| `id` | string | The model id (`author/slug[:variant]`) — already used |
| `canonical_slug` | string | Permanent slug (never changes) — we store this |
| `name` | string | Human display name — we store this |
| `created` | number | Unix ts of when added to OpenRouter (NEW — not consumed) |
| `description` | string | **Detailed model description** (NEW — great dashboard tooltip/row) |
| `context_length` | number | Max context window (we use this) |
| `architecture` | object | `input_modalities[]`, `output_modalities[]`, `tokenizer`, `instruct_type` — we read input_modalities for vision |
| `pricing` | object | **Full pricing breakdown (see §3)** — we only read prompt/completion today |
| `top_provider` | object | `context_length`, `max_completion_tokens`, `is_moderated` — we read context + output ceiling |
| `per_request_limits` | object \| null | Rate-limiting info per request (null in practice) |
| `supported_parameters` | string[] | Supported API params (tools, structured_outputs, reasoning…) — we read some |
| `default_parameters` | object \| null | Model's default sampling params — we use |
| `expiration_date` | string \| null | Deprecation date — we show |
| `benchmarks` | object \| undefined | **NEW — third-party benchmark rankings** (see §4) |

### `reasoning` object — the thinking-toggle surface (now consumed)
The model metadata carries a `reasoning` object that is **far richer** than a single
"supports reasoning" boolean. It's the source of truth for the reasoning modes we
generate (`Think (X)` / `No Think`):

| Field | Type | Meaning |
|---|---|---|
| `mandatory` | boolean \| undefined | Reasoning **cannot** be disabled (no "No Think" mode) |
| `default_enabled` | boolean \| undefined | Reasoning on by default (drives `defaultMode`) |
| `default_effort` | string \| null | Default effort level (`high`, `medium`, `low`, `minimal`, `xhigh`, `max`…) |
| `supported_efforts` | string[] \| null | **Exact effort ladder** the model accepts — we build one `Think (X)` mode per level |
| `supports_max_tokens` | boolean \| undefined | **Anthropic-style**: budget set via `reasoning.max_tokens`, not `effort`. No per-effort mapping → we emit a single `Think` mode |

Consumption (`normalizeOpenRouterModel`):
- `supported_efforts` (minus `none`) → one `Think (Effort)` mode each, with `{ reasoning: { enabled: true, effort } }`.
- `supports_max_tokens` → single `Think` mode with `{ reasoning: { enabled: true } }` (OpenRouter applies a default budget).
- `mandatory: true` → no `No Think` mode.
- `default_effort` / `default_enabled: false` / `default_effort: 'none'` → `defaultMode`.

### Not yet consumed (candidates for the dashboard)
- **`description`** — a human-readable paragraph per model. Ideal for the model tooltip / a "Model" detail row.
- **`created`** — model age; could show "added YYYY-MM-DD".
- **`benchmarks`** — ELO/rank data.
- **Full `architecture`** — tokenizer + output modalities; could power an "output: text/image/audio" badge.
- **`top_provider.is_moderated`** — whether content moderation is applied.

---

## 2. Pricing (`pricing` object) — the big untapped surface

All values are **USD per token / per request / per unit**. We currently only read `prompt` and `completion` (→ per-1M estimate). The full set:

| Field | Type | Meaning |
|---|---|---|
| `prompt` | string | Cost per **input token** |
| `completion` | string | Cost per **output token** |
| `request` | string | **Fixed cost per API request** (NEW — matters for cheap models!) |
| `image` | string | Cost per image input |
| `web_search` | string | Cost per web search op |
| `internal_reasoning` | string | Cost for internal reasoning tokens |
| `input_cache_read` | string | Cost per **cached** input token read |
| `input_cache_write` | string | Cost per cached input token write |
| `overrides` | array | Conditional pricing (see below) |

A value of `"0"` means free. **`-1` means unknown** (dynamic routers).

### `pricing.overrides[]` — conditional pricing (NEW)
Each entry has condition fields + overridden price keys:
- `min_prompt_tokens` — price kicks in above this prompt-token threshold (long-context surcharge).
- `utc_start` / `utc_end` — time-window (peak/off-peak) pricing, given as HHMM.
- Overridden keys: `prompt`, `completion`, `input_cache_read`, `input_cache_write`, etc.

**Dashboard implication:** a model can have *different* prices depending on prompt length or time of day. Today's cost estimate (per-1M from prompt/completion) is a **lower bound** — long-context / peak usage can be pricier. Any cost projection should flag `overrides` presence.

---

## 3. Per-request usage (`usage` object on chat responses / stream chunks)

The `usage` object (present in the final stream chunk) carries the **actual** cost — this is the data-plane gap we identified in the plan:

```typescript
{
  prompt_tokens: number,
  completion_tokens: number,
  total_tokens: number,
  completion_tokens_details: {
    reasoning_tokens?: number | null,
    accepted_prediction_tokens?: number | null,
    rejected_prediction_tokens?: number | null,
    audio_tokens?: number | null,
  },
  prompt_tokens_details: {
    cached_tokens?: number,
    cache_write_tokens?: number,
    audio_tokens?: number,
    video_tokens?: number,
  },
  cost: number | null,                       // ★ ACTUAL cost in USD (OpenRouter credits)
  cost_details: CostDetails,                  // ★ upstream cost breakdown (see below)
  is_byok: boolean,                           // ★ whether this was Bring-Your-Own-Key
  server_tool_use_details: {                  // server-side tools (web search etc.)
    tool_calls_requested?: number | null,
    tool_calls_executed?: number | null,
    web_search_requests?: number | null,
  } | null,
}
```

### `CostDetails`
```typescript
{
  upstream_inference_prompt_cost: number,
  upstream_inference_completions_cost: number,
  upstream_inference_cost: number | null,   // combined
}
```

**This is the single most valuable dashboard addition for OpenRouter:** after every request we already stream the final usage chunk. We can capture `cost` (real spend), `is_byok`, cached tokens, reasoning tokens, and server-tool usage — without any extra API call. This is the planned `WireUsage.cost` extension.

---

## 4. Benchmarks (`benchmarks` object, on model metadata)

```typescript
{
  design_arena: [
    {
      arena: 'models' | 'builders' | 'agents',
      category: string,     // 'website', 'gamedev', ...
      elo: number,
      win_rate: number,     // percentage
      rank: number,         // 1 = highest ELO
    }
  ]
}
```

Present only for models evaluated in [Design Arena](https://designarena.org). **Dashboard value:** a "Design Arena" row (best rank across categories) for models that have it.

---

## 5. `GET /api/v1/key` — account/key health (NEW, authenticated)

Returns the credit + usage status of the configured API key:

```typescript
{
  data: {
    label: string,
    limit: number | null,           // credit limit, null = unlimited
    limit_reset: string | null,     // reset type
    limit_remaining: number | null, // remaining credits
    include_byok_in_limit: boolean,
    usage: number,                  // credits used, all time
    usage_daily: number,            // ... current UTC day
    usage_weekly: number,           // ... current UTC week (Mon-start)
    usage_monthly: number,          // ... current UTC month
    byok_usage: number,             // external BYOK usage
    byok_usage_daily: number,
    byok_usage_weekly: number,
    byok_usage_monthly: number,
    is_free_tier: boolean,          // whether the user ever paid
  }
}
```

**Dashboard value — high:**
- **Credit balance** (`limit_remaining`) → a "Credits remaining" row on the OpenRouter server node.
- **Usage today / month** → mirrors the existing token-cost tracker but from the account side.
- **`is_free_tier`** → explains free-tier rate limits (see §8).

> Requires a valid key (it's the same per-model `Authorization: Bearer` header we already store). This is the *only* endpoint that works on the account level rather than per model.

---

## 6. `GET /api/v1/generation?id={genId}` — per-request diagnostics (NEW)

Needs the **`X-Generation-Id` response header** (returned on every chat completion, stream or not — we currently do **not** retain it; the plan explicitly deferred it). Returns a rich record:

```typescript
{
  data: {
    id: 'gen-...',                 // generation id
    request_id: 'req-...',         // groups all generations from one request
    upstream_id: 'chatcmpl-...',   // upstream provider's id
    model: string,                 // slug served
    provider_name: string,         // ★ WHICH provider actually served it
    provider_responses: ProviderResponse[] | null,  // ★ per-provider attempts (fallbacks!)
    router: 'openrouter/auto' | null,
    latency: number | null,        // ★ total latency ms
    generation_time: number | null,// generation ms
    moderation_latency: number | null,
    total_cost: number,            // ★ USD
    upstream_inference_cost: number | null,
    usage: number,                 // USD (same as total_cost)
    cache_discount: number | null, // ★ discount applied due to caching
    is_byok: boolean,
    tokens_prompt: number | null,
    tokens_completion: number | null,
    native_tokens_prompt: number | null,          // provider's own counts
    native_tokens_completion: number | null,
    native_tokens_cached: number | null,
    native_tokens_reasoning: number | null,
    native_tokens_completion_images: number | null,
    num_fetches: number | null,          // web fetches
    num_search_results: number | null,   // web search results
    num_media_prompt: number | null,
    num_media_completion: number | null,
    num_input_audio_prompt: number | null,
    streamed: boolean | null,
    cancelled: boolean | null,
    finish_reason: string | null,
    native_finish_reason: string | null,
    service_tier: string | null,   // 'priority' | 'flex' | ...
    data_region: 'global' | 'europe' | 'us' | null,
    response_cache_source_id: string | null,  // served from response cache?
    web_search_engine: string | null,
    created_at: ISO 8601,
    workspace_id: string | null,
    preset_id: string | null,
    session_id: string | null,
    app_id: number | null,
    external_user: string | null,
    http_referer: string | null,
    origin: string | null,
    user_agent: string | null,
  }
}
```

### `ProviderResponse[]` (per provider attempt)
```typescript
{
  id: string,            // upstream response id
  endpoint_id: string,
  provider_name: string, // enum of known providers
  model_permaslug: string,
  status: number,        // HTTP status of that attempt
  latency: number | null,// ms
  is_byok: boolean,
}
```

**Dashboard value — very high, but costs an extra API call per request + requires retaining `X-Generation-Id`:**
- **Which provider actually served the request** (the single most "dashboard-like" fact for a relay).
- **Actual latency** (TTFT-ish proxy).
- **Real cost incl. cache discount** — more precise than `usage.cost` (has cache discount + native tokens).
- **Fallback attempts** (`provider_responses`) — see if routing had to fail over.
- **Response-cache hits** (`response_cache_source_id`).

> **Trade-off to weigh:** the plan previously decided *not* to thread `X-Generation-Id` through the stream (4 layers of plumbing for a diagnostic nicety). Retaining just the final chunk's `usage.cost` (§3) gives real cost with **zero extra HTTP calls** and no header plumbing. The generation endpoint is a *richer* but *expensive* addition. Recommendation: ship §3 first (usage.cost), treat §6 as a follow-up "diagnostics deep-dive for OpenRouter" feature.

---

## 7. `GET /api/v1/activity` — account activity aggregates (NEW, auth)

Per-endpoint (per model+provider) **daily** aggregates:

```typescript
{
  data: [{
    date: 'YYYY-MM-DD',
    model: 'openai/gpt-4.1',          // slug
    model_permaslug: 'openai/gpt-4.1-2025-04-14',
    endpoint_id: string,              // model+provider pair
    provider_name: string,            // ★ provider
    requests: number,
    prompt_tokens: number,
    completion_tokens: number,
    reasoning_tokens: number,
    usage: number,                    // ★ total cost USD (OpenRouter credits)
    byok_usage_inference: number,     // ★ BYOK cost USD
  }]
}
```

**Dashboard value — high:** a true "per model, per provider, per day" cost/token ledger, queryable for the dashboard's Today/Overall cost view. Could replace/augment the local usage-store estimates with the account's authoritative numbers. Needs the key + a management-level scope; verify auth requirements.

---

## 8. Rate limits & errors (dashboard-relevant)

- **`GET /api/v1/key`** → credit/rate status (see §5). Successful inference responses do **not** include `X-RateLimit-*` headers; only error responses do.
- **Free variants** (`:free`): platform-level caps:
  - `< $10 credits ever purchased` → **20 req/min, 50 req/day**
  - `≥ $10` → **20 req/min, 1000 req/day**
  - Purchasing `$10` (const `FREE_MODEL_CREDITS_THRESHOLD`) raises the daily cap.
- **429s**: honor `Retry-After` header when present (from providers); OpenRouter platform limits come with `X-RateLimit-Limit/-Remaining/-Reset` on the error.
- **402 Payment Required** → account/key out of credits; `limit_remaining` on the key tells you how close.
- **Mid-stream errors** arrive as SSE events with `finish_reason: "error"` + top-level `error` (code, message, `metadata.error_type`, `metadata.provider_code`).

**Dashboard value:** the `is_free_tier` + `limit_remaining` from §5 let the dashboard surface "free tier (20 rpm / 50 rpd)" or "X credits left" — turning silent 402/429 walls into visible state.

---

## 9. Router metadata on stream chunks (`openrouter_metadata`) — free per-request breadcrumbs

Every stream chunk carries `openrouter_metadata` (when enabled):

```typescript
{
  requested: string,            // what you asked for
  strategy: string,             // routing strategy
  region: string | null,        // e.g. 'iad'
  summary: string,              // e.g. 'available=1, selected=OpenAI'
  attempt: number,
  attempts: RouterAttempt[],    // per-provider attempts
  is_byok: boolean,
  endpoints: { available: {model, provider, selected}[], total },
  params: RouterParams,
  pipeline: PipelineStage[],
}
```

Also on chunks: top-level `provider` (in examples), `service_tier` (e.g. 'default'/'priority'), `system_fingerprint`, and final `usage`.

**Dashboard value:** `openrouter_metadata.summary` / `endpoints` tells you **which provider served the request** without the extra generation API call. The plan noted router metadata is "out for the same reason" (cache hits omit it) — but the `usage.cost` (§3) is independent and always present.

---

## 10. What this means for the dashboard — recommended shape

OpenRouter is **not a server**; it's a relay with a model catalog. The dashboard should reflect that:

### Option A — "Model collection" node (recommended)
- **Server node** = OpenRouter (fixed base) → shows account-level data from `GET /api/v1/key`:
  - Credits remaining / used (month)
  - Free tier vs paid
  - (optional) today's activity from `GET /api/v1/activity`
- **Per-model children** = each configured model gets its own node with **model-level** rows:
  - Context window (already resolved)
  - Pricing (prompt/completion/request/cache-read — full set, with overrides flagged)
  - Capabilities (tools, vision, structured outputs) from `supported_parameters`
  - Description (tooltip)
  - Design Arena rank (if present)
  - Expiration date
- **Per-request** = captured from the stream's final `usage` chunk:
  - Actual cost (`usage.cost`), tokens (incl. cached/reasoning), BYOK flag
  - Optionally the serving provider from `openrouter_metadata` or the generation endpoint

### Option B — per-model dashboard nodes only
Drop the "server" framing entirely for OpenRouter: each configured model is a top-level node. Cleanest conceptually, but diverges from the tree's server-first structure.

### Refactor consideration
The current dashboard is **server-centric** (one engine per server, one set of metric rows). OpenRouter breaks that model:
- The metrics engine polls `/v1/models` per server — for OpenRouter that's the whole catalog, not "the server's models."
- Context window, cost, capabilities are per-**model**, not per-server.
- A serverType-aware **child-node strategy** (model-level rows vs server-level rows) is the natural extension of the "hide absent rows" cleanup, but the tree data model needs to support **per-model detail nodes** under a relay server.

### Data-plane priority (in order of value ÷ cost)
1. **`usage.cost` + `is_byok` capture** from the final stream chunk — zero extra HTTP, unblocks real-cost tracking everywhere (the plan's stated acceptance criterion). (plan delivery 1)
2. **`GET /api/v1/key`** — account health row (credits / free-tier). One cheap authenticated call, static-ish, cacheable.
3. **Model-level rows** — full pricing (with `overrides` flag), description, capabilities, benchmarks, created/expiration. All already in metadata we fetch; just display more of it.
4. **`GET /api/v1/activity`** — authoritative per-model daily cost/tokens for the cost tracker.
5. **Generation endpoint** (§6) — richest, but requires `X-Generation-Id` threading + an extra call per request; defer as a follow-up "OpenRouter request diagnostics" feature.

---

## Appendix — endpoints summary

| Endpoint | Auth | Data | Dashboard use |
|---|---|---|---|
| `GET /api/v1/models` | none | catalog (full schema §1) | picker + model rows |
| `GET /api/v1/model/{a}/{s}` | none | single model (same schema) | context, pricing, caps, benchmarks |
| `POST /api/v1/chat/completions` | key | response + final `usage` | **actual cost/tokens per request** |
| `GET /api/v1/key` | key | credits, usage, free-tier | account health row |
| `GET /api/v1/activity` | key (mgmt?) | per-model daily aggregates | cost tracker |
| `GET /api/v1/generation?id=` | key | full per-request diagnostics | follow-up diagnostics |
| `GET /api/v1/endpoints` | ? | available endpoints per request | routing insight |

**OpenAPI spec:** `https://openrouter.ai/docs/openapi/openapi.yaml` (fetched 2026-08-19, ~1.3MB). Docs index: `https://openrouter.ai/docs/llms.txt`.
