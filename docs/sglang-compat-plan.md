# SGLang Backend Compatibility Plan

**Status:** Research complete — plan ready, no implementation started
**Date:** 2026-08-17
**Research basis:** Verified against `sgl-project/sglang` source (Python + Rust servers, `sgl-router`, `sgl-model-gateway`, docs, and test fixtures). Every wire-format claim below is grounded in source, not docs-vibes.

## 0. TL;DR — and the OpenRouter sequencing question

**SGLang is not a rewrite.** The chat data plane is byte-for-byte OpenAI-compatible and already works with this extension's shared transport (`/v1/chat/completions`, SSE, `delta.content` / `delta.reasoning_content` / `delta.tool_calls`, `[DONE]`, `include_usage`). The plain server already reports `max_model_len` on `/v1/models`, so it will classify, resolve a real context window, and chat today — mislabeled as `vllm`, and with an empty dashboard. The work is: one `ServerType` arm, one classifier arm, and a metrics mapper. **Not a rewrite.**

**Should we reconsider before doing OpenRouter AND SGLang? — No conflict, but make ONE decision now.**

OpenRouter and SGLang are architecturally orthogonal:

- **OpenRouter** = remote managed service. A new *class* of backend: no local server, no health probe, no Prometheus metrics, cost-aware, cloud credentials.
- **SGLang** = local serving engine. The same *class* as vLLM/LM Studio/llama.cpp/Ollama: a self-hosted OpenAI-compatible endpoint with a `/health` probe and Prometheus metrics.

They do not share a transport, a discovery path, or a request body. Neither blocks the other, and neither is a prerequisite for the other.

**The one decision to make before continuing:** the dashboard/metrics classification. Today it is binary — `serverType === 'vllm'` gets full metrics, everything else is flagged `(degraded)`. OpenRouter's plan already replaces this binary with per-backend classification (OpenRouter = "managed remote", not degraded). SGLang is the first backend that genuinely needs a **metrics mapper** (`sglang:*` names map onto ~80% of the dashboard fields — see §5). So:

> **Decision:** when the OpenRouter dashboard work lands, implement the per-backend classification as a small lookup table of backend descriptors (health endpoint, version endpoint, metrics source, managed-remote flag) — **not** as a vllm-vs-everything binary and **not** as a full backend registry. This is the seam both OpenRouter and SGLang hit. A ~40-line table serves all six backends; a full registry is gold-plating the OpenRouter plan explicitly warned against.

**Recommended sequencing:**
1. **Land OpenRouter first.** It is implementation-ready; the control-plane module (`src/openRouter.ts`, 26 tests) and the `RuntimeModelLimits` widening are already in. Do not slow it down with a registry refactor.
2. **Build the per-backend descriptor table as part of OpenRouter's dashboard delivery** (its plan already promises per-backend classification).
3. **Land SGLang after**, as a small additive delivery on top. Then SGLang is: `ServerType` arm + classifier arm + limits arm + the metrics mapper + `/server_info` version source.

Why not both in one branch: both touch `ServerType`, config validation, the package schema, and the classifier. Doing them together means one giant PR and merge pain for zero user-visible gain. Sequential gives two reviewable changes, and SGLang directly reuses the classification OpenRouter's dashboard work establishes.

Why not a backend registry now: the OpenRouter plan's guardrail still holds — the `resolveRuntimeLimits` switch at 6 arms is still small and each arm expresses a real, small difference. SGLang is the closest thing to a "vLLM clone" (its limits arm is identical to vLLM's), but that shared-ness lives entirely in the metrics/version layer, which the descriptor table handles. A registry would touch four working backends for no user-visible benefit.

---

## 1. Goal

Let a user point this extension at an SGLang server (or SGLang model gateway) and get correct chat, reasoning, tools, usage, cancellation, model modes, and a **working dashboard** — without editing JSON. Same bar as the existing third-party backends: reliable Copilot chat first, real metrics where SGLang provides them.

The extension stays vLLM-first. SGLang is an opt-in secondary backend, labeled as itself (not mislabeled as vLLM), and it gets a real metrics mapper rather than a blanket `(degraded)` flag.

## 2. Architecture Decisions

- **OpenAI Chat Completions, unchanged.** SGLang's `POST /v1/chat/completions` is OpenAI-compatible; the extension's existing message/SSE/tool/usage pipeline already matches it. No fork.
- **Per-model config, unchanged.** SGLang gets a `serverType: 'sglang'` with its own `serverUrl`, `vllmModelId` (wire id), and headers. No global settings.
- **Add one `ServerType` arm, not a backend registry.** The existing switch expresses the real differences; SGLang fits inside it (see §6).
- **No request-body changes.** Verified: SGLang's `ChatCompletionRequest` accepts the extension's `max_tokens` (`max_completion_tokens or max_tokens`; `max_tokens` is deprecated-but-supported). `chat_template_kwargs`, tools, `tool_choice`, sampling params, `stream_options.include_usage` all pass through. vLLM-only continuation flags are already stripped for non-vLLM types and would apply to `sglang` too.
- **Metrics mapper in `vllmMetrics.ts`, not a new subsystem.** `sglang:*` → dashboard field mapping lives beside the existing `vllm:*` parsing. This is the bulk of the work.
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
| Version | `GET /server_info` → `version` (Python `__version__`, Rust `server_args.version`). **No `/version` endpoint** (current fetch 404s → `version` undefined, harmless) | `http_server.py`; rust `common.rs` |
| Load | `GET /v1/loads` (not `/load`). Current `/load` fetch 404s → `serverLoad` undefined, harmless | `v1_loads.py` |
| `GET /metrics` | ✅ Prometheus, **`sglang:*` prefix, requires `--enable-metrics`** | `metrics_collector.py`; `production_metrics.mdx` |
| Default port | **30000** (vLLM is 8000) | `server_args.py`; rust `default_port()` |

**Reasoning:** SGLang emits `delta.reasoning_content` when launched with `--reasoning-parser`. The extension already handles it. No change.

**Errors:** SGLang returns OpenAI-shaped `{ error: { message, type, code } }`; context-length violations are `BadRequestError` "is longer than the model's context length" — already matched by the extension's error heuristics (`messageConverter.ts`).

## 4. Deployment shapes and the context-window story

| Shape | `GET /v1/models` | Context source | Verdict |
|---|---|---|---|
| Plain server (`python -m sglang.launch_server` / `sglang serve`) | `max_model_len = context_len` ✅ | `max_model_len` | **Fully supported** |
| Rust server (`SGLANG_RUST_SERVER=1`) | `max_model_len = context_len` ✅ | `max_model_len` | **Fully supported** |
| SGLang model gateway (`sgl-model-gateway`) | proxies to workers → `max_model_len` ✅ | `max_model_len` (or `/server_info.max_context_length`) | **Supported** |
| Classic `sgl-router` (experimental) | `{ id, object, owned_by }` — **no `max_model_len`**, no `/server_info` route | **none** | **Hard blocker** — same class as the llama.cpp router gap, but with no `/props`-style rescue. Model must be rejected with an actionable message. |

The classic router is the one case that cannot be rescued. Same policy as every backend: no fabricated window, reject loudly with a message that names `sgl-router`'s missing `max_model_len`.

## 5. Dashboard metrics mapping (the real work)

`vllmMetrics.ts` hard-codes `vllm:*` names. SGLang serves the same *kinds* of metrics under `sglang:*`. Mapping (verified names; two marked **verify** where docs and source disagree):

| `ServerMetrics` field | SGLang metric | Notes |
|---|---|---|
| `kvCacheUsagePercent` | `sglang:token_usage` (0–1 gauge) | ×100; vLLM's `kv_cache_usage_perc` is already a percent |
| `runningRequests` | `sglang:num_running_reqs` (gauge) | |
| `waitingRequests` | `sglang:num_queue_reqs` (gauge) | |
| `cacheHitRate` | `sglang:cache_hit_rate` (gauge) | radix prefix-cache hit rate |
| `avgTTFTMs` | `sglang:time_to_first_token_seconds` (`_sum`/`_count`, ×1000) | histogram |
| `avgTPOTMs` | `sglang:time_per_output_token_seconds` OR `sglang:inter_token_latency_seconds` | **verify** which the target version serves; both appear in source/docs |
| `avgTputTokPerSec` | `sglang:gen_throughput` (gauge, tok/s) | simpler than vLLM's pooled sum/sum |
| `avgPrefillTputTokPerSec` | — | no verified prefill-time histogram; fall back to client-measured rendering (existing non-vLLM path) |
| `preemptions` | `sglang:num_retracted_requests_total` (counter) | SGLang "retracts" ≈ preemptions; decide whether to surface as-is |
| `evictions` | — | no direct analog verified; leave empty |
| spec decode | `sglang:spec_verify_calls_total`, `sglang:spec_num_draft_tokens` | partial; **verify** cumulative names |
| `version` | `/server_info.version` | not `/version` |
| `maxModelLen` | `/v1/models.max_model_len` | same path as vLLM |

**Critical caveat:** SGLang serves `/metrics` only when launched with `--enable-metrics`. vLLM serves it by default. The docs must say so, and the mapper must treat an empty scrape as "metrics disabled", not "server dead".

Labels: SGLang metrics carry `model_name` labels (and `is_streaming` on token histograms). The mapper must sum across model labels like the vLLM parser does.

## 6. Minimal Change Set

### Configuration (`src/config.ts` + package schema)
- Add `'sglang'` to `ServerType` (`'vllm' | 'lmstudio' | 'llamacpp' | 'ollama' | 'openrouter' | 'sglang'`).
- Add to the validation list in `config.ts` and to the `vllm-copilot.models` JSON schema in `package.json` if the schema enumerates `serverType`.
- `serverType` missing still means vLLM (unchanged policy). Error messages that enumerate the supported backends get `'sglang'` added.

### Classifier (`src/autoConfig.ts` + `src/serverSettingsView.ts`)
- Add `owned_by === 'sglang'` detection, **checked before** the `max_model_len → vLLM` rule — SGLang reports BOTH, and we want it labeled as SGLang, not vLLM. No collision: vLLM's `owned_by` is never `"sglang"`.
- `resolveDetectedServerType` in `serverSettingsView.ts` mirrors this.

### Runtime limits (`src/vllmClient.ts` `resolveRuntimeLimits`)
- Add `case 'sglang'`: `GET /v1/models` → matching `max_model_len` (identical to the vLLM arm). Optionally fall back to `GET /server_info` → `max_context_length` for gateway deployments where the model card omits the field. Never fabricate.

### Metrics + version (`src/vllmMetrics.ts`)
- `fetchAllEndpoints`: version from `/server_info` (parse `version`) when `serverType === 'sglang'`; online probe stays `/health` (SGLang serves it — unlike LM Studio/llama.cpp/Ollama).
- Add the `sglang:*` mapping from §5 alongside the `vllm:*` parser (single `MetricsParser` entry point, prefix-dispatch).

### Dashboard / deep-dive (`src/dashboard.ts`, `deepDiveView.ts`)
- Part of OpenRouter's per-backend classification work (§0). SGLang renders as a local server **with** metrics (not `(degraded)`).

### Error text (`src/messageConverter.ts`, `tokenBudget.ts`)
- No functional change required; context-length errors already match. Verify the budget messaging names "sglang" where a backend name leaks.

### Docs
- `docs/configuration-reference.md`, `README.md`, `docs/usage.md`, `CHANGELOG.md`. Default port note (30000), `--enable-metrics` note, classic-router limitation.

## 7. Focused Tests

- Classifier: `owned_by: "sglang"` → `sglang`, with and without `max_model_len`; order vs vLLM rule.
- Resolver: plain server `max_model_len` resolves; missing field throws with the backend-specific message; gateway `/server_info.max_context_length` fallback.
- Metrics mapper: synthetic `sglang:*` Prometheus text → expected `ServerMetrics` (percent conversion, histogram averages, model-label summing, empty scrape → not-dead).
- Request body: `max_tokens` + `stream_options.include_usage` snapshot against SGLang's accepted fields (contract test, like the other backends).
- SSE: reasoning/content/tool deltas, `[DONE]`, usage-only final chunk (reuse existing fixtures; SGLang shape is identical).
- Router limitation: `{id, object, owned_by}` only → model skipped with actionable message.
- `npm run compile`, `npm run test:typecheck`, `npm test`, `npm run validate-webview-js`.

## 8. Acceptance Criteria

- A user can add an SGLang server via the Add flow; it is detected as `sglang`, not vLLM.
- Chat, reasoning, tools, usage, cancellation, and model modes work through the shared data plane with no request-body fork.
- The dashboard shows real SGLang metrics (when `--enable-metrics` is on) and labels the server as SGLang — not `(degraded)`.
- Classic `sgl-router` deployments fail with an actionable message (no fabricated context), matching existing backend policy.
- Existing vLLM, LM Studio, llama.cpp, Ollama, and OpenRouter behavior is unchanged.
- No backend registry was introduced; the change is a per-backend descriptor + arms.

## 9. Out of Scope

- SGLang native `/generate`, `/tokenize`, `/detokenize` APIs (OpenAI surface only).
- Anthropic-compatible `/v1/messages` (not needed for Copilot chat).
- Classic `sgl-router` context rescue (there is none; it is a documented limitation).
- Spec-decode dashboard parity (partial metric coverage; leave the rows empty/partial rather than invent values).
