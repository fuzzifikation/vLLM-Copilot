# SGLang Backend Compatibility Plan

**Status:** Research complete - plan ready, no implementation started. Metric names re-verified against `main` and sequencing corrected for OpenRouter having shipped (2026-08-22).
**Date:** 2026-08-17 (updated 2026-08-22)
**Research basis:** Verified against `sgl-project/sglang` source (Python + Rust servers, `sgl-router`, `sgl-model-gateway`, docs, and test fixtures). Every wire-format claim below is grounded in source, not docs-vibes.

## 0. TL;DR - and the OpenRouter sequencing question

**SGLang is not a rewrite.** The chat data plane is byte-for-byte OpenAI-compatible and already works with this extension's shared transport (`/v1/chat/completions`, SSE, `delta.content` / `delta.reasoning_content` / `delta.tool_calls`, `[DONE]`, `include_usage`). The plain server already reports `max_model_len` on `/v1/models`, so it will classify, resolve a real context window, and chat today - mislabeled as `vllm`, and with an empty dashboard. The work is: one `ServerType` arm, one classifier arm, and a metrics mapper. **Not a rewrite.**

**Should we reconsider before doing OpenRouter AND SGLang? - No conflict, but make ONE decision now.**

OpenRouter and SGLang are architecturally orthogonal:

- **OpenRouter** = remote managed service. A new *class* of backend: no local server, no health probe, no Prometheus metrics, cost-aware, cloud credentials.
- **SGLang** = local serving engine. The same *class* as vLLM/LM Studio/llama.cpp/Ollama: a self-hosted OpenAI-compatible endpoint with a `/health` probe and Prometheus metrics.

They do not share a transport, a discovery path, or a request body. Neither blocks the other, and neither is a prerequisite for the other.

**The one decision to make before continuing:** the dashboard/metrics classification. Today it is binary - `serverType === 'vllm'` gets full metrics, everything else is flagged `(degraded)`. OpenRouter's plan already replaces this binary with per-backend classification (OpenRouter = "managed remote", not degraded). SGLang is the first backend that genuinely needs a **metrics mapper** (`sglang:*` names map onto ~80% of the dashboard fields - see §5). So:

> **Decision (revised 2026-08-22): two seams, not one.** The per-backend classification is NOT a single table that finesses the whole dashboard. Split it by layer:
> - **Data acquisition** (`fetchAllEndpoints`): a small lookup table of backend descriptors (health endpoint, version endpoint, metrics source, managed-remote flag) decides WHAT to fetch. A ~40-line table serves all six backends; a full registry is gold-plating. This is table-driven dispatch over a uniform operation (fetch + parse) - not finesse.
> - **Rendering** (`dashboard.ts`): a **per-backend renderer strategy** - one renderer per backend composing shared row primitives. OpenRouter already proves this pattern (distinct `OpenRouterAccountTreeItem` + `getRelayModelTreeItems`). SGLang gets its own render path: its own summary line, version label, section order, "Retractions" label, metrics-disabled hint, and deep-dive eligibility. It is NOT "vLLM with `if (serverType === 'sglang')` patches."
> **Why not one table driving rendering:** the current code has exactly two render paths - a shared server renderer (vLLM + LM Studio/llama.cpp/Ollama, where "degraded" is missing *data*, not a code path) and the OpenRouter relay path. Bolting SGLang onto the shared renderer with more conditionals recreates the `ServerTreeItem` constructor's inline `isOpenRouterRelay`/`isVllm` branches. A per-backend renderer (a small strategy map, possibly one module `dashboardRenderers.ts`) gives SGLang a real path while the ~200 shared metric-row lines stay single-sourced.

**Recommended sequencing (updated 2026-08-22 - OpenRouter shipped but did NOT deliver a reusable classification seam):**
1. **Land the acquisition descriptor table** (`fetchAllEndpoints` in `src/vllmMetrics.ts`). It still splits on a binary `isVllm`; the OpenRouter account/credits probe is an inline branch. A local refactor of shipped code, no new surface.
2. **Land the renderer strategy** (`dashboard.ts`): extract the inline `isOpenRouterRelay`/`isVllm` branches from `ServerTreeItem` and `getServerMetricsChildren` into per-backend renderers. OpenRouter gets its proper path; the shared metric-row builder takes a per-backend label/behavior map; SGLang slots in as a third renderer. This is the precondition that makes "SGLang has its own path, not patched vLLM" true (§6).
3. **Land SGLang after**, as a small additive delivery: `ServerType` arm + classifier arm + limits arm + the metrics mapper + `/server_info` version source + the SGLang renderer + deep-dive eligibility (precondition #2).

Why not both in one branch: both touch `ServerType`, config validation, the package schema, and the classifier. Doing them together means one giant PR and merge pain for zero user-visible gain. Sequential gives two reviewable changes. Note: OpenRouter's shipped dashboard work does **not** give SGLang a reusable seam - it shipped inline conditionals, so steps 1–2 are SGLang's own preconditions, not inheritance.

Why not a backend registry now: the OpenRouter plan's guardrail still holds - the `resolveRuntimeLimits` switch at 6 arms is still small and each arm expresses a real, small difference. SGLang is the closest thing to a "vLLM clone" (its limits arm is identical to vLLM's), but that shared-ness lives entirely in the metrics/version layer, which the descriptor table handles. A registry would touch four working backends for no user-visible benefit.

---

## 1. Goal

Let a user point this extension at an SGLang server (or SGLang model gateway) and get correct chat, reasoning, tools, usage, cancellation, model modes, and a **working dashboard** - without editing JSON. Same bar as the existing third-party backends: reliable Copilot chat first, real metrics where SGLang provides them.

The extension stays vLLM-first. SGLang is an opt-in secondary backend, labeled as itself (not mislabeled as vLLM), and it gets a real metrics mapper rather than a blanket `(degraded)` flag.

## 2. Architecture Decisions

- **OpenAI Chat Completions, unchanged.** SGLang's `POST /v1/chat/completions` is OpenAI-compatible; the extension's existing message/SSE/tool/usage pipeline already matches it. No fork.
- **Per-model config, unchanged.** SGLang gets a `serverType: 'sglang'` with its own `serverUrl`, `vllmModelId` (wire id), and headers. No global settings.
- **Add one `ServerType` arm, not a backend registry.** The existing switch expresses the real differences; SGLang fits inside it (see §6).
- **No request-body changes.** Verified: SGLang's `ChatCompletionRequest` accepts the extension's `max_tokens` (`max_completion_tokens or max_tokens`; `max_tokens` is deprecated-but-supported). `chat_template_kwargs`, tools, `tool_choice`, sampling params, `stream_options.include_usage` all pass through. vLLM-only continuation flags are already stripped for non-vLLM types and would apply to `sglang` too.
- **Metrics mapper in `vllmMetrics.ts`, not a new subsystem.** `sglang:*` → dashboard field mapping lives beside the existing `vllm:*` parsing. This is the bulk of the work.
- **Per-backend renderer, not patched vLLM.** SGLang gets its own dashboard render path (a renderer strategy composing shared row primitives), the way OpenRouter already has its own relay path. No `if (serverType === 'sglang')` branches in the shared `ServerTreeItem` / `getServerMetricsChildren` code.
- **Server-reported context only.** Same policy as every backend: no fabricated windows. The plain server and the model gateway report real context; the classic router does not (§4).

## 3. Verified API Contract

Source of truth: `sgl-project/sglang` (Python `python/sglang/srt/entrypoints/http_server.py` + `protocol.py`, Rust `rust/sglang-server/src/api_server/openai/*`, `experimental/sgl-router`, `sgl-model-gateway`, docs, test fixtures).

| Extension need | SGLang reality | Verified in |
|---|---|---|
| `POST /v1/chat/completions` (SSE) | ✅ served, OpenAI-compatible | `http_server.py` routes; protocol tests |
| `delta.content` / `delta.reasoning_content` / `delta.tool_calls` | ✅ `DeltaMessage` has all three | `protocol.py` |
| `stream_options.include_usage` + `[DONE]` | ✅ `StreamOptions` + `ChatCompletionStreamResponse` | `protocol.py`; reasoning-kit test uses both |
| `max_tokens` in request | ✅ accepted (`max_completion_tokens or max_tokens`) | `protocol.py` `to_sampling_params`; rust `chat.rs` |
| `tools` / `tool_choice` / `parallel_tool_calls` | ✅ supported | `protocol.py` |
| `chat_template_kwargs` (thinking toggles) | ✅ supported (qwen3/glm `enable_thinking`, deepseek `thinking`) | `protocol.py` |
| `GET /v1/models` → `max_model_len` | ✅ **Python server**: `ModelCard(max_model_len=context_len)`; **Rust server**: `model_card()` sets it. LoRA adapters report `null`. | `http_server.py` L1822; `openai/models.rs` |
| `owned_by` | ✅ `"sglang"` on every model card | `protocol.py` default; `openai/models.rs`; router |
| `GET /health` | ✅ 200 ready, 503 starting/shutdown | `http_server.py`; rust health routes |
| `GET /health_generate` | ✅ deep probe (runs a 1-token generate) | `http_server.py`; rust `native_api.rs` |
| Version | `GET /server_info` → `version` (Python `__version__`, Rust `server_args.version`). **No `/version` endpoint** - the current unconditional `/version` fetch 404s (see §6: gate `/version` + `/load` by backend instead of tolerating permanent 404s) | `http_server.py`; rust `common.rs` |
| Load | `GET /v1/loads` (not `/load`). Same gating note as `/version` | `v1_loads.py` |
| `GET /metrics` | ✅ Prometheus, **`sglang:*` prefix, requires `--enable-metrics`** | `metrics_collector.py`; `production_metrics.mdx` |
| Default port | **30000** (vLLM is 8000) | `server_args.py`; rust `default_port()` |

**Reasoning:** SGLang emits `delta.reasoning_content` when launched with `--reasoning-parser`. The extension already handles it. No change.

**Errors:** SGLang returns OpenAI-shaped `{ error: { message, type, code } }`; context-length violations are `BadRequestError` "is longer than the model's context length" - already matched by the extension's error heuristics (`messageConverter.ts`).

## 4. Deployment shapes and the context-window story

| Shape | `GET /v1/models` | Context source | Verdict |
|---|---|---|---|
| Plain server (`python -m sglang.launch_server` / `sglang serve`) | `max_model_len = context_len` ✅ | `max_model_len` | **Fully supported** |
| Rust server (`SGLANG_RUST_SERVER=1`) | `max_model_len = context_len` ✅ | `max_model_len` | **Fully supported** |
| SGLang model gateway (`sgl-model-gateway`) | proxies to workers → `max_model_len` ✅ | `max_model_len` (or `/server_info.max_context_length`) | **Supported** |
| Classic `sgl-router` (experimental) | `{ id, object, owned_by }` - **no `max_model_len`**, no `/server_info` route | **none** | **Hard blocker** - same class as the llama.cpp router gap, but with no `/props`-style rescue. Model must be rejected with an actionable message. |

The classic router is the one case that cannot be rescued. Same policy as every backend: no fabricated window, reject loudly with a message that names `sgl-router`'s missing `max_model_len`.

## 5. Dashboard metrics mapping (the real work)

`vllmMetrics.ts` hard-codes `vllm:*` names. SGLang serves the same *kinds* of metrics under `sglang:*`. Mapping (verified names; two marked **verify** where docs and source disagree):

| `ServerMetrics` field | SGLang metric | Notes |
|---|---|---|
| `kvCacheUsagePercent` | `sglang:token_usage` (0–1 gauge) | ×100; vLLM's `kv_cache_usage_perc` is already a percent |
| `runningRequests` | `sglang:num_running_reqs` (gauge) | |
| `waitingRequests` | `sglang:num_queue_reqs` (gauge) | |
| `cacheHitRate` | `sglang:cache_hit_rate` (gauge, **0–1 fraction** - example `0.0075`) | **×100.** The dashboard renders `cacheHitRate` as a percent (`fmtPct`, `dashboard.ts` L628). vLLM's path computes a percent in the extension; SGLang emits a fraction - the conversion must be in the mapper |
| `avgTTFTMs` | `sglang:time_to_first_token_seconds` (`_sum`/`_count`, ×1000) | histogram |
| `avgTPOTMs` | `sglang:inter_token_latency_seconds` (**primary** - the name `TokenizerMetricsCollector` emits); `sglang:time_per_output_token_seconds` (**alias** - `production_metrics.mdx` + gateway fixtures) | **resolved 2026-08-22**: accept BOTH, prefer the primary; ×1000 to ms. Bonus: same histogram semantics and `_sum`/`_count` shape as vLLM's TPOT source, so the parser arm is near-identical |
| `avgTputTokPerSec` | `sglang:gen_throughput` (gauge, tok/s) | simpler than vLLM's pooled sum/sum |
| `avgPrefillTputTokPerSec` | - | no verified prefill-time histogram; fall back to client-measured rendering (existing non-vLLM path) |
| `preemptions` | `sglang:num_retracted_requests_total` (counter; siblings `num_retracted_input_tokens_total` / `num_retracted_output_tokens_total`; the old gauge `num_retracted_reqs` carries an upstream "remove me" TODO) | **DECIDED: label it "Retractions"**, not "Preemptions". SGLang "retracts" (evicts to reclaim KV slots) ≠ vLLM preemption. Add a footnote that retraction ≈ preemption but is not identical. Use the counter, not the deprecated gauge. **Delivered via the SGLang renderer's label map - not an `if (sglang)` branch in the shared row builder.** |
| `evictions` | - | no direct analog verified; leave empty |
| `specAcceptanceRate` | `sglang:spec_accept_rate` (gauge, 0–1 fraction) | **resolved 2026-08-22**: vLLM's rate is pooled (accepted ÷ proposed drafts, cumulative); SGLang's is an instantaneous per-batch fraction. Map it, but it reads as *current*, not cumulative. ×100 |
| `specDraftsTotal` / `specDraftDepth` | - | **leave empty.** No honest source: `spec_num_draft_tokens` is a *currently-active* gauge, `spec_verify_calls_total` counts verify *batches*, not drafts. Filling these would fabricate semantics (§9) |
| `version` | `/server_info.version` | not `/version` |
| `maxModelLen` | `/v1/models.max_model_len` | same path as vLLM |

**Critical caveat:** SGLang serves `/metrics` only when launched with `--enable-metrics` (vLLM serves it by default). The docs must say so. **Precise "disabled" signal (resolved 2026-08-22):** with metrics off, `/metrics` still returns 200 - prometheus_client always serves the default process/go registry - but with **zero `sglang:`-prefixed names**. Detection is name-based, not status-based. And decide the UX: don't render it as a plain no-metrics backend (indistinguishable from LM Studio) - show a one-line "Metrics disabled - launch with `--enable-metrics`" hint.

**Labels (resolved 2026-08-22):** SGLang emits `model_name` **plus** `tp_rank`, `pp_rank`, `dp_rank`, `engine_type`, `moe_ep_rank` (and `priority` under priority scheduling) - every metric appears once per rank. The existing model-bucketed accumulators in `MetricsParser` already handle this (counts sum across ranks, ratios average), but the plan's "sum across model labels" instruction is underspecified: aggregation must span **all** label dimensions except the bucketed one, or multi-GPU servers double-count. Add a two-`tp_rank` test.

**SGLang-only telemetry the dashboard doesn't consume (future deep-dive material, out of scope):** `sglang:utilization`, `sglang:fwd_occupancy`, `sglang:realtime_tokens_total` (prefill_compute / prefill_cache / decode), `sglang:forward_execution_seconds_total`, and memory gauges (`weight_memory_usage_gb`, `kv_cache_memory_usage_gb`, `context_len`). Dashboard richness is bounded by its ~15 `ServerMetrics` fields, not by what SGLang exposes - these are the first genuinely usable memory/utilization signals any backend has offered. Record, don't build (§9).

## 6. Minimal Change Set

> **Implementation preconditions (updated 2026-08-22):**
> 1. **Gate `/version` + `/load` by backend in `fetchAllEndpoints`** (no permanent-404 crutch). Still required - the file uses the binary `isVllm` split and the OpenRouter account/credits probe is already an inline branch. Land this as the descriptor-table step (§0).
> 2. **Deep-dive gate.** `dashboard.ts` L86 sets `contextValue = isVllm ? state : ${state}NoDive`. SGLang has real metrics + version, so it must get deep-dive - the gate needs a backend-aware condition, not `isVllm`.
> 3. **Surface SGLang retractions under "Retractions"** (not "Preemptions") - locked decision, see §5.
> 4. **Verify the Rust server's `sglang:*` metric names.** Research verified the Python collector (`python/sglang/srt/observability/metrics_collector.py`). The Rust server (`SGLANG_RUST_SERVER=1`, increasingly the default) has its own metrics implementation - the plan cites rust files for HTTP endpoints but NOT for metric names. Before shipping, confirm the Rust server emits the same `sglang:*` names, or scope the mapper to the Python server and gate the Rust server's dashboard rows.

### Configuration (`src/config.ts` + package schema)
- Add `'sglang'` to `ServerType` (`'vllm' | 'lmstudio' | 'llamacpp' | 'ollama' | 'openrouter' | 'sglang'`).
- Add to the validation list in `config.ts` and to the `vllm-copilot.models` JSON schema in `package.json` if the schema enumerates `serverType`.
- `serverType` missing still means vLLM (unchanged policy). Error messages that enumerate the supported backends get `'sglang'` added.

### Classifier (`src/autoConfig.ts` + `src/serverSettingsView.ts`)
- Add `owned_by === 'sglang'` detection, **checked before** the `max_model_len → vLLM` rule - SGLang reports BOTH, and we want it labeled as SGLang, not vLLM. No collision: vLLM's `owned_by` is never `"sglang"`.
- `resolveDetectedServerType` in `serverSettingsView.ts` mirrors this.

### Runtime limits (`src/vllmClient.ts` `resolveRuntimeLimits`)
- Add `case 'sglang'`: `GET /v1/models` → matching `max_model_len` (identical to the vLLM arm). Optionally fall back to `GET /server_info` → `max_context_length` for gateway deployments where the model card omits the field. Never fabricate.

### Metrics + version (`src/vllmMetrics.ts`)
- `fetchAllEndpoints`: version from `/server_info` (parse `version`) when `serverType === 'sglang'`; online probe stays `/health` (SGLang serves it - unlike LM Studio/llama.cpp/Ollama).
- **Gate `/version` and `/load` by backend.** Today `fetchAllEndpoints` unconditionally fires both for every backend and tolerates a 404. On SGLang they 404 on every poll tick forever - 2 wasted round-trips per server per interval, and correctness depends on 404-silence. Fix: fetch `/version` only for vLLM (and `/server_info` for SGLang), and `/load` only for vLLM; drop the 404-tolerance crutch. This is a small `fetchAllEndpoints` change, not a rewrite.
- Add the `sglang:*` mapping from §5 alongside the `vllm:*` parser (single `MetricsParser` entry point, prefix-dispatch).
- **Metrics resolved 2026-08-22:** TPOT = `inter_token_latency_seconds` (primary) + `time_per_output_token_seconds` (alias); spec-decode = `spec_accept_rate` only (drafts/depth rows stay empty); `cache_hit_rate` needs ×100; multi-rank label aggregation. The one remaining research gate is the Rust server metric inventory (precondition #4).

### Dashboard / deep-dive (`src/dashboard.ts`, `deepDiveView.ts`)
- **SGLang renderer** (precondition #2's strategy map, §0): its own summary line, version label (`/server_info`), section order, "Retractions" label, and the "metrics disabled - launch with `--enable-metrics`" hint when the scrape is 200-with-zero-`sglang:`. Composes the shared metric-row primitives - it does NOT duplicate them and does NOT grow `if (serverType === 'sglang')` branches in shared code.
- **Deep-dive eligibility**: `dashboard.ts` L86 gates `contextValue` on `isVllm`. With the renderer strategy, deep-dive availability becomes a per-backend renderer decision. SGLang qualifies (real metrics + version); the deep-dive webview then needs SGLang's version source (`/server_info`) and its raw metrics - same `ServerRawData` shape, so no webview fork, but the version label must not assume `/version`.

### Error text (`src/messageConverter.ts`, `tokenBudget.ts`)
- No functional change required; context-length errors already match. Verify the budget messaging names "sglang" where a backend name leaks.

### Docs
- `docs/configuration-reference.md`, `README.md`, `docs/usage.md`, `CHANGELOG.md`. Default port note (30000), `--enable-metrics` note, classic-router limitation.

## 7. Focused Tests

- Classifier: `owned_by: "sglang"` → `sglang`, with and without `max_model_len`; order vs vLLM rule.
- Resolver: plain server `max_model_len` resolves; missing field throws with the backend-specific message; gateway `/server_info.max_context_length` fallback.
- Metrics mapper: synthetic `sglang:*` Prometheus text → expected `ServerMetrics` (percent conversions for `token_usage` **and** `cache_hit_rate`, histogram averages ×1000, model-label summing, multi-rank aggregation (two `tp_rank` values, one model), metrics-disabled detection (200 with zero `sglang:` lines → not-dead + disabled hint).
- Request body: `max_tokens` + `stream_options.include_usage` snapshot against SGLang's accepted fields (contract test, like the other backends).
- SSE: reasoning/content/tool deltas, `[DONE]`, usage-only final chunk (reuse existing fixtures; SGLang shape is identical).
- Router limitation: `{id, object, owned_by}` only → model skipped with actionable message.
- `npm run compile`, `npm run test:typecheck`, `npm test`, `npm run validate-webview-js`.

## 8. Acceptance Criteria

- A user can add an SGLang server via the Add flow; it is detected as `sglang`, not vLLM.
- Chat, reasoning, tools, usage, cancellation, and model modes work through the shared data plane with no request-body fork.
- The dashboard shows real SGLang metrics (when `--enable-metrics` is on) and labels the server as SGLang - not `(degraded)`.
- Classic `sgl-router` deployments fail with an actionable message (no fabricated context), matching existing backend policy.
- Existing vLLM, LM Studio, llama.cpp, Ollama, and OpenRouter behavior is unchanged.
- No backend registry was introduced; the change is a per-backend descriptor + arms.

## 9. Out of Scope

- SGLang native `/generate`, `/tokenize`, `/detokenize` APIs (OpenAI surface only).
- Anthropic-compatible `/v1/messages` (not needed for Copilot chat).
- Classic `sgl-router` context rescue (there is none; it is a documented limitation).
- Spec-decode dashboard parity (partial metric coverage; leave the rows empty/partial rather than invent values).
