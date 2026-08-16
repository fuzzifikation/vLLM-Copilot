# OpenRouter — First-Class Backend Plan

**Status:** Research complete / implementation ready to start
**Date:** 2026-08-16
**Decisions:**
- **Approach:** add OpenRouter as a first-class backend now.
- **Backend-adapter extraction: DEFERRED (do it at backend #6+, NOT as part of this work).** The current two-switch + scattered-guard design is acceptable at 4 backends. Adding one more `case` in the same style is line-neutral vs. extracting now, and avoids churning `hfDiscovery`/`streamOrchestrator` while their guards are still few. Revisit the adapter refactor only if/when a 6th backend appears.

**Goal:** Make OpenRouter (https://openrouter.ai) a first-class backend in vLLM-Copilot, on par with vLLM / llama.cpp / LM Studio / Ollama, so users can point any preset at `https://openrouter.ai/api` and pay per token instead of running their own GPUs.

---

## 1. What OpenRouter actually is (researched facts)

OpenRouter is a **model router / aggregator**: one OpenAI-compatible endpoint, hundreds of models, automatic provider fallback, cost per request. From the official docs (`openrouter.ai/docs/api-reference/overview`, `/docs/quickstart`, `/docs/api-reference/streaming`) and the **live `GET https://openrouter.ai/api/v1/models`** response:

### 1.1 Endpoints
| Endpoint | Purpose |
|---|---|
| `POST /api/v1/chat/completions` | Chat completions (OpenAI Chat API shape) |
| `GET /api/v1/models` | Model catalog (id, `context_length`, `top_provider.max_completion_tokens`, `pricing`, `supported_parameters`, `reasoning`, …) |
| `GET /api/v1/generation?id=…` | Post-hoc usage/cost for a generation id |

> Because the base URL already ends in `/api`, the extension's existing `buildEndpoint(url, 'v1/chat/completions')` and `buildEndpoint(url, 'v1/models')` compose **exactly** the right URLs when `serverUrl = https://openrouter.ai/api`.

### 1.2 Request body
OpenAI Chat API superset:
- `model` — slug like `deepseek/deepseek-v4-flash-0731`, `anthropic/claude-opus-5`, `openrouter/auto`, or `~openai/gpt-latest` / `:free` variants.
- `messages`, `tools`, `tool_choice`, `stream`, `max_tokens`, `temperature`, `top_p`, `top_k`, `seed`, penalties, `logit_bias`, `response_format`, `stop`.
- **Unsupported params are silently ignored** per model (no 400) — e.g. `temperature` on Claude, `top_k` on OpenAI. Our merged options won't blow up.
- Extra: `models[]`/`route` (fallback routing), `provider`, `plugins`, `reasoning`/`reasoning_effort`, `include_reasoning`.

### 1.3 Auth headers
```
Authorization: Bearer sk-or-…
HTTP-Referer: <site url>        # optional, leaderboard attribution
X-OpenRouter-Title: <app name>  # optional, leaderboard attribution
```
Our per-model `requestHeaders` mechanism already supports arbitrary headers. **No new secret storage needed.**

### 1.4 Streaming (SSE) — matches vLLM almost exactly
- `data:` JSON chunks, `delta.content`, `delta.tool_calls` (with `index`), `delta.reasoning`, `finish_reason`.
- Final chunk carries `usage` with **empty `choices`** — identical to vLLM's usage-only final chunk.
- Terminates with `data: [DONE]`.
- **Keep-alive comments** `: OPENROUTER PROCESSING` between chunks — spec-compliant, our `eventsource-parser`-based `streamReader.ts` already skips them.
- **Mid-stream errors** arrive as a normal `data:` event with a top-level `error` object and `finish_reason: "error"` — the exact shape `sseParser.ts` already detects.
- **Pre-stream errors** are plain JSON `{"error": {"code", "message"}}` with HTTP 400/401/402/429/5xx.
- Stream cancellation via abort (works for most providers).

### 1.5 Model catalog shape (`/v1/models` → `data[]`)
```jsonc
{
  "id": "deepseek/deepseek-v4-flash-0731",
  "name": "DeepSeek: DeepSeek V4 Flash 0731",
  "context_length": 1048576,
  "top_provider": {
    "context_length": 1048576,
    "max_completion_tokens": 393216,
    "is_moderated": false
  },
  "pricing": { "prompt": "0.00000014", "completion": "0.00000028", "input_cache_read": "…" },
  "supported_parameters": ["tools", "reasoning", "reasoning_effort", "…"],
  "reasoning": { "default_effort": "high", "supported_efforts": ["max","high","low"] },
  "architecture": { "input_modalities": ["text","image"], "output_modalities": ["text"] }
}
```
**Key difference from vLLM: the context window is `context_length` (top-level and/or `top_provider.context_length`), NOT `max_model_len`.** Some entries have `null` context (e.g. `openrouter/auto`, `:batch`), and `top_provider.max_completion_tokens` caps output per model.

### 1.6 Usage / cost
- `usage` always includes `prompt_tokens`, `completion_tokens`, `total_tokens`, plus `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`, and OpenRouter extras `cost`, `is_byok`, `cost_details`.
- Per-model pricing is in the catalog (`pricing.prompt` / `pricing.completion` per token) — usable to drive the dashboard cost display.

---

## 2. Compatibility analysis (current code, file by file)

| Area | Verdict | Notes |
|---|---|---|
| URL composition (`buildEndpoint`) | ✅ works | `serverUrl = https://openrouter.ai/api` → correct paths |
| SSE line parsing (`streamReader.ts`) | ✅ works | `eventsource-parser` handles comments + `[DONE]` |
| SSE JSON + tool accumulation (`sseParser.ts`) | ✅ works | `error` objects, usage-only final chunk, `delta.reasoning`, `finish_reason` all already handled |
| Request building (`provider/requestBuilder.ts`) | ✅ works | OpenAI messages, tools, merged params — all compatible |
| Message conversion (`messageConverter.ts`) | ✅ works | OpenAI wire format |
| Auth (`requestHeaders`) | ✅ works | per-model headers |
| Cancellation / retry / logging | ✅ works | abort + `fetchWithRetry` |
| Reasoning/thinking parts (`consumeStream.ts`) | ✅ works | `delta.reasoning` → `LanguageModelThinkingPart` |
| Tool calling | ✅ works | standard `tool_calls` deltas |
| **Server type detection** (`detectServerType`) | ❌ **blocker** | no `openrouter` branch; OpenRouter's `/v1/models` lacks `max_model_len` → misdetected or rejected |
| **Context-window resolution** (`resolveContextWindow` vllm case) | ❌ **blocker** | reads `max_model_len` only → OpenRouter models skipped at discovery with "no runtime context window" |
| **Output-token cap** (`modelInfo.ts` / `tokenBudget.ts`) | ⚠️ gap | needs `top_provider.max_completion_tokens` to avoid advertising impossible output budgets |
| **Cost display** (`cost` in `ModelConfig`) | ⚠️ gap (nice-to-have) | could auto-fill from `pricing` |
| Config validation (`config.ts` ~L483) | ❌ | `serverType` enum must accept `'openrouter'` |
| Wire types (`types.ts`) | ⚠️ gap | `VllmModel` needs optional `context_length` / `top_provider` |
| Add-Server flow (`addServerFlow.ts`, `serverSettingsView.ts`) | ⚠️ gap | needs OpenRouter signature in detection + a first-class "Add OpenRouter model" path |

---

## 2.5 Architecture assessment (decided: no extraction now)

### Why the current design is sound
The load-bearing invariant: **every backend speaks the OpenAI chat-completions protocol.** vLLM, llama.cpp, LM Studio, Ollama, and OpenRouter all share the same request shape and SSE wire format. That is why the hot path — `requestBuilder.ts`, `sseParser.ts`, `consumeStream.ts`, `streamReader.ts` — has **zero** backend branching. That invariant is the architecture; it must not erode.

### Where branching actually lives (mapped)
| Location | Kind | Today |
|---|---|---|
| `vllmClient.ts` `resolveContextWindow` | **switch** | 4 cases: URL + response shape + error message. The main zoo. |
| `vllmClient.ts` `detectServerType` / `detectServerTypeFromV1Models` | ordered probes | first-match, additive |
| `hfDiscovery.ts` (L179,192,228,232) | `serverType === 'vllm'` | scattered guards in auto-config |
| `streamOrchestrator.ts` (L101,132) | `serverType === 'vllm'` | auto-continue prefill + empty-retry toggles |
| `dashboard.ts` (L41) | `serverType !== 'vllm'` | "degraded metrics" flag |

This is **not spaghetti yet** — two clean switches plus a handful of guards. The risk is the *pattern*, not the present state: each new backend adds a `case` **and** re-asks whether each scattered `=== 'vllm'` guard should cover it. Fine at 4; archaeology at 6+.

### The deferred refactor (when the 6th backend appears)
Extract what actually varies into a static backend registry + capability flags — **bounded, not a rewrite**:

```ts
// src/backends/types.ts
export interface BackendCapabilities {
  autoContinue: boolean;   // assistant-prefill retry (vllm yes, ollama no)
  richMetrics: boolean;    // vLLM-style TTFT/KV/throughput (drives dashboard "degraded")
}

export interface BackendAdapter {
  serverType: ServerType;
  capabilities: BackendCapabilities;
  matchesV1Models(entries: unknown[]): boolean;   // detection signal
  resolveMetadata(serverUrl, headers, modelId): Promise<{
    contextLength: number;
    maxCompletionTokens?: number;
  }>;
}
```

- `resolveContextWindow` → `registry[serverType].resolveMetadata(...)` — one lookup, no growing switch.
- `detectServerTypeFromV1Models` → `backends.find(b => b.matchesV1Models(entries))` in priority order.
- `streamOrchestrator`'s `=== 'vllm'` → `registry[serverType].capabilities.autoContinue`.
- `dashboard`'s `!== 'vllm'` → `capabilities.richMetrics`. (Note: today's `!== 'vllm'` is a latent bug — a future non-vLLM backend *with* rich metrics would silently degrade.)
- `hfDiscovery`'s guards → capability checks.

**Anti-over-engineering line:** static registry, compile-time-enumerated, tiny surface (detection + metadata + 2 flags). No plugin system, no dynamic registration, no 20-method interface with no-op stubs. The hot path stays shared; a backend that breaks the OpenAI protocol is out of scope until one actually exists (then add `adaptRequest?`/`adaptChunk?` hooks — not before).

**Why defer:** adding a 5th `case` in today's style is line-neutral vs. building the registry. Extracting now churns `hfDiscovery` and `streamOrchestrator` while they have only a handful of guards. Do the OpenRouter work in the established pattern; revisit extraction at backend #6.

---

## 3. Implementation plan

> **Scope note:** OpenRouter is added as a 5th `case` in the existing `serverType` switch — **no backend-adapter extraction in this PR** (see §2.5). If it turns into backend #6 work, execute the §2.5 extraction first.

### Phase 0 — Types (`src/types.ts`)
- Extend `VllmModel`:
  ```ts
  context_length?: number;
  top_provider?: {
    context_length?: number | null;
    max_completion_tokens?: number | null;
  };
  pricing?: { prompt?: string; completion?: string; input_cache_read?: string };
  ```
  (`pricing` values are numeric strings — keep as strings, parse at use site.)

### Phase 1 — Server type (`src/config.ts`)
- `ServerType = 'vllm' | 'lmstudio' | 'llamacpp' | 'ollama' | 'openrouter'`.
- Update validation array (line ~483) to include `'openrouter'`.
- Update the doc comment on `serverType` in `ModelConfig`.
- Consider a helper `isOpenRouterUrl(url)` / keep detection in `vllmClient.ts` — prefer detection in one place (vllmClient), config stays a dumb union.

### Phase 2 — Detection (`src/vllmClient.ts`)
- `detectServerTypeFromV1Models(...)`: add OpenRouter signals **before** the vllm `max_model_len` check is *falsely* triggered. OpenRouter entries have `context_length` (a number) and/or a `top_provider` object and org-prefixed ids (`org/model`). Order: vllm (`max_model_len`) → llamacpp (`owned_by`) → **openrouter (`context_length` present / `top_provider` present)** → undefined.
- `detectServerType(...)` probe: add `/v1/models` OpenRouter check alongside the existing vLLM probe.
- Update the "unsupported server" error message to name the OpenRouter signature.

### Phase 3 — Context window resolution (`src/vllmClient.ts`, `resolveContextWindow`)
- Add `case 'openrouter':`
  - `GET /v1/models` (already via `buildEndpoint(serverUrl, 'v1/models')`).
  - Match `data.find(m => m.id === modelId)`.
  - Read `context_length ?? top_provider?.context_length`.
  - **Fail loudly** (match the vllm case's style) when missing/null — never fabricate. But give an OpenRouter-specific actionable message (e.g. `:batch` / `openrouter/auto` have no fixed window → point at a concrete model slug).
- Add a sibling export, e.g. `resolveMaxCompletionTokens(modelId)` or fold output cap into the context resolver result, so `modelInfo.ts` can cap `maxOutputTokens` with `top_provider.max_completion_tokens`.

### Phase 4 — Model info / budget (`src/modelInfo.ts`, `src/tokenBudget.ts`)
- `buildModelInfo` currently takes `{ id, max_model_len? }`. Generalize the server-model param (or add an optional second arg) to carry `context_length` / `top_provider.max_completion_tokens`.
- In `discovery.ts`, when building `serverModel`, map OpenRouter's window into the field `deriveTokenBudget` reads, and clamp `maxOutputTokens = min(maxOutputTokens, top_provider.max_completion_tokens)` for OpenRouter models.

### Phase 5 — Add-Server flow (`src/commands/addServerFlow.ts`, `src/commands/hfDiscovery.ts`, `src/serverSettingsView.ts`)
- Let the Add Server flow accept `https://openrouter.ai/api` and run `detectServerType` → `openrouter`.
- `serverSettingsView.ts` lists server-reported models — verify the `/v1/models` render path tolerates the OpenRouter shape (it reads `id`; add `context_length` display).
- **Do NOT add a "global OpenRouter server"** — architecture rule: every model keeps its own `serverUrl` + `requestHeaders`. A user adds N OpenRouter models, each pointing at `https://openrouter.ai/api` with their own key, or one key shared by pasting the same `requestHeaders`.

### Phase 6 — Presets (`model-configs/`)
- Add OpenRouter variants of existing presets, or a dedicated `OpenRouter-<model>.json` per popular model. The existing slugs (`deepseek/deepseek-v4-flash-0731`, `z-ai/glm-5.2`, `poolside/laguna-s-2.1`, `qwen/qwen3.6-27b`, `tencent/hy3`) all exist in the live catalog.
- Example preset:
  ```jsonc
  {
    "id": "openrouter-deepseek-v4-flash",
    "vllmModelId": "deepseek/deepseek-v4-flash-0731",
    "displayName": "OpenRouter: DeepSeek V4 Flash",
    "serverUrl": "https://openrouter.ai/api",
    "serverType": "openrouter",
    "requestHeaders": { "Authorization": "Bearer sk-or-<YOUR_KEY>" },
    "maxOutputTokens": 131072,
    "family": "deepseek_v4",
    "capabilities": { "toolCalling": true, "imageInput": false }
  }
  ```

### Phase 7 — Docs + README
- `docs/` new page `openrouter.md`: config steps, key location, leaderboard headers, model catalog, `:free` / `~latest` notes, cost caveats.
- Update `docs/configuration-reference.md` `serverType` table + README features list.

---

## 4. Testing

- `config.test.ts` — `serverType` accepts `'openrouter'`.
- `vllmClient`/context resolver tests — OpenRouter `/v1/models` fixture (context_length present, null window, `top_provider` shape), error path when window missing.
- `discovery`/`modelInfo` tests — output-cap clamp from `top_provider.max_completion_tokens`.
- `sseParser.test.ts` — already covered; add an OpenRouter fixture (comment lines + reasoning + mid-stream `error` + usage-only final chunk) to lock behavior.
- `hfDiscovery`/`addServerFlow` tests — detection returns `openrouter`.

## 5. Nice-to-haves (defer, not required to run)

- **Cost in dashboard:** auto-map `usage.cost` / catalog `pricing` into `ModelConfig.cost` so the usage tracker shows real spend. OpenRouter pricing is per-token strings; convert to per-M tokens.
- **BYOK:** `is_byok` already a concept in the codebase; OpenRouter BYOK just works via `requestHeaders`.
- **`:free` / `~latest` handling:** filter or annotate free/alias variants in the picker.
- **`plugins` / web-search models:** no code change needed — user sets them via `defaultParams`.

## 6. Effort estimate

**One focused PR, low-to-moderate.** ~200–400 lines of production code across Phases 0–4 (the core), plus detection wiring and presets. The architecture's existing multi-backend seams (`serverType` switch in `resolveContextWindow`, first-match detection) mean this is one more switch arm — not a rewrite.

## 7. Open questions

1. Should OpenRouter models get their **own prefix/section** in the Add-Server UI, or reuse the generic server flow? (Prefer reuse — one flow, `serverType` decides.)
2. Do we want `requestHeaders` presets with a placeholder key, or leave key entry to the Add Server prompt? (Prefer placeholder + clear docs; never hardcode a real key.)
3. Should `:free` / `~latest` aliases be surfaced by default in the picker? (Recommend yes for `~latest`, filterable.)
