# Third-Party Backend Compatibility Plan

Status: **Implemented — compile clean, 673 tests passing (3 skipped). Live-verified against `llm.unifiedmixers.org` (llama.cpp) and `vllm.unifiedmixers.org` (vLLM). Dashboard flags non-vLLM servers as degraded, shows client-measured throughput when the server reports no per-request metrics, and renders pooled output/prefill speed (`Output x tok/s · Prefill y tok/s`) for vLLM. Pending live LM Studio/Ollama verification and the F5 vLLM byte-identical gate.**

## 1. Objective

Support the normal, documented OpenAI-compatible configurations of:

- vLLM
- LM Studio
- llama.cpp `llama-server`
- Ollama (optional until live-tested)

The extension remains vLLM-first. vLLM is the default backend and the only one
assumed when configuration does not say otherwise. LM Studio, llama.cpp, and
Ollama are opt-in secondary backends. They need reliable Copilot chat, reasoning,
tools, usage, cancellation, and model modes where their request parameters are
supported. They do not need vLLM-only metrics or feature parity.

Unsupported, ambiguous, or incorrectly configured servers fail with a clear
error. We do not guess metadata, invent context windows, or add compatibility
workarounds for unusual deployments.

## 2. Design Decisions

### 2.1 Persist the backend type

Add one field to each model configuration:

```ts
type ServerType = 'vllm' | 'lmstudio' | 'llamacpp' | 'ollama';

interface ModelConfig {
  serverType?: ServerType;
}
```

The Add Server flow detects the backend once and stores it on the model. Runtime
requests use this stored value directly.

Existing and future configurations without `serverType` are always treated as
vLLM. This is intentional product policy, not migration behavior. Users who
manually create a third-party model entry must set `serverType` explicitly or add
it through the command. If an entry defaults to vLLM but its server does not
provide a valid vLLM `max_model_len`, reject it with an error that says the entry
is being treated as vLLM and names `serverType` as the correction for an
intentional third-party configuration.

There is no runtime detection cache. A cache adds invalidation and routing-key
complexity without value when the backend is stable configuration data.

### 2.2 Detect only standard servers during Add Server

The Add Server flow classifies the server once from shape-validated standard
endpoints:

| Detection | Backend |
|---|---|
| Matching model has numeric `max_model_len` | vLLM |
| Matching model has `owned_by: "llamacpp"` | llama.cpp |
| `GET /api/v1/models` returns LM Studio's `models[].key` shape | LM Studio |
| `GET /api/ps` returns Ollama's `{ models: [...] }` shape | Ollama |

Anything else is unsupported and the Add Server command stops with an error that
lists the expected signatures. `owned_by: "library"` may be used as a hint to
order probes, but it is not proof of Ollama; `/api/ps` is the positive signature
and supports instances whose owner is a username. Do not classify arbitrary
owner names as Ollama or ambiguous OpenAI-compatible servers as vLLM.

**Classifier evaluation:** detection runs **after** the model is selected, and is
**first-match-wins in table order** — evaluate vLLM, then llama.cpp, then the
`/api/v1/models` probe, then the `/api/ps` probe; stop at the first
shape-valid hit. Do not fan out and score — a server that half-matches two
signatures must not become ambiguous.

**Probe interpretation:** a `404` (or missing route) means "not this
signature" — continue. A `200` with a *structurally invalid* shape means
"invalid signature" — reject that signature. A `200` with a *valid shape that
does not list the selected model* is "continue probing," not "reject the server."
Authentication, network, timeout, and `5xx` errors throw immediately.

These probes exist only in Add Server. They must not be called by provider
discovery, Auto-Configure, Test & Refresh, or chat requests. Those paths use the
persisted `serverType` and call only that backend's documented endpoints. Keep the
classifier bounded to the four signatures above; do not grow it into a generic
OpenAI-compatible server detector.

### 2.3 Require a backend-reported served context

Copilot needs an accurate total context window. Each backend has one required,
backend-specific source:

| Backend | Required endpoint and field | Meaning |
|---|---|---|
| vLLM | `GET /v1/models` -> matching `data[].max_model_len` | Served runtime limit |
| LM Studio | `GET /api/v1/models` -> matching loaded instance `config.context_length`; otherwise matching `max_context_length` | Loaded runtime limit or configured model limit |
| llama.cpp | `GET /props` -> `default_generation_settings.n_ctx` | Served runtime limit |
| Ollama | `GET /api/ps` -> matching `models[].context_length` | Loaded runtime limit |

For llama.cpp router mode, use:

```text
GET /props?model=<URL-encoded model id>
```

All metadata requests use the model's configured `requestHeaders`.

Training limits such as llama.cpp `meta.n_ctx_train` and Ollama
`model_info.*.context_length` are diagnostic only. They are not the served
context and must never be used for Copilot token budgets.

If the required model, endpoint, or field is missing, zero, malformed,
unauthorized, or unavailable, throw and do not advertise the model. The error
must name:

1. Backend and model.
2. Endpoint and expected field.
3. Actual failure.
4. Concrete correction, such as loading the Ollama model or configuring
   llama.cpp authentication.

There is no numeric fallback and `maxInputTokens` is not a substitute for a
missing total context window. It remains an optional downward clamp after the
server context is known.

## 3. Minimal Architecture

### 3.1 Backend resolver

Keep one backend-aware method on `VllmClient`:

```ts
getModelContextWindow(
  serverType: ServerType,
  serverUrl: string,
  requestHeaders: Record<string, string>,
  modelId: string,
): Promise<RuntimeModelLimits>
```

It switches on `serverType`, calls exactly the endpoint in section 2.3, validates
the response, and returns a positive integer context window. `RuntimeModelLimits
{ contextWindow: number; maxOutputTokens?: number }` leaves `maxOutputTokens`
undefined for backends that report no completion ceiling. It does not probe
unrelated endpoints or cascade across backend formats.

`serverType` is a **required** parameter on the resolver, not optional. The compile
time contract is what enforces "no runtime detection": a caller must already know
the backend, so the resolver physically cannot probe to discover it.

`VllmClient` remains the owner of HTTP retry/logging behavior and the existing
configuration cache. No second cache or metadata abstraction is needed.

**Scope guard — `vllmMetrics.ts` is exempt.** It reads `/v1/models.max_model_len`
for dashboard *display*. That is not token budgeting, so it is NOT part of
"unify all context consumers" and stays untouched.

### 3.2 Shared use

Provider discovery, Add Server, Auto-Configure, and Test & Refresh must call the
same resolver. Remove independent context parsing from `hfDiscovery.ts` and
`testAndRefresh.ts`.

`/v1/models` may still be read separately for model IDs and vLLM's `root` field,
but no other component derives token budgets from it independently.

### 3.3 Errors

Preserve the resolver's detailed error in discovery output:

```text
[WARN] Model "qwen" skipped: llama.cpp GET /props did not report
default_generation_settings.n_ctx. Configure the server API key and verify
/props is accessible.
```

Do not rewrite metadata errors as `failed to connect` unless the error is actually
a connection failure.

## 4. Request Compatibility

All backends use `POST /v1/chat/completions`. Keep the current SSE architecture:

- `streamReader.ts` parses SSE framing.
- `sseParser.ts` parses OpenAI-compatible chunks and accumulates tool calls.
- Both `delta.reasoning` and `delta.reasoning_content` are accepted.

**`ServerConfig` is declared in three places today** — `requestBuilder.ts`, the
inline parameter on `chatCompletionStream`, and the structural type in
`contracts.ts`. Add `serverType` **once** in one shared shape and import it; do
not add a fourth declaration.

Request adaptation must be small and explicit. Do not use a broad allowlist;
model modes intentionally support raw backend parameters.

| Backend | Adaptation |
|---|---|
| vLLM | No changes |
| LM Studio | No changes initially; live tests show standard and current vLLM extension fields are tolerated |
| llama.cpp | No changes initially; preserve llama.cpp-specific sampling and mode parameters |
| Ollama | Remove `tool_choice` with one `[WARN]`; preserve `tools` |

Only remove another field after a documented or live-tested rejection. Unknown
model-mode keys pass through so backend-specific modes remain possible.

Do not automatically translate arbitrary `chat_template_kwargs` into
`reasoning_effort`. Users can define backend-appropriate mode parameters. A
future narrow mapping may be added only for semantics verified to be equivalent.

### 4.1 Auto-continue

The current continuation retry adds an assistant prefill message and vLLM-only
request controls. Make the backend behavior explicit:

| Backend | Continuation retry |
|---|---|
| vLLM | Preserve `continue_final_message` and `add_generation_prompt` |
| LM Studio | Keep the assistant prefill; omit both vLLM-only fields |
| llama.cpp | Keep the assistant prefill; omit both vLLM-only fields |
| Ollama | Keep the assistant prefill; omit both vLLM-only fields; provisional until live-tested |

Do not silently send vLLM-only continuation controls to secondary backends.
Auto-continue is considered supported only when an integration test confirms the
backend continues the final assistant message rather than starting an unrelated
answer or rejecting the request.

## 5. Supported Feature Set

Required on every declared-supported backend:

- Streaming text through Copilot.
- Reasoning/thinking chunks when emitted by the server.
- Tool definitions and fragmented tool-call arguments.
- Usage reporting when emitted.
- Cancellation through the existing abort path.
- Standard sampling parameters.
- Raw per-model and per-mode request parameters, subject only to known backend
  rejections.

Not required outside vLLM:

- vLLM metrics and dashboard performance data.
- vLLM-specific structured outputs or repetition detection.
- Automatic translation of thinking-mode semantics.
- Compatibility with undocumented response shapes or proxies that hide required
  metadata.

## 6. Implementation Steps

1. Add `ServerType` and `ModelConfig.serverType`; update package schema,
   validation, persistence, and the server settings UI.
2. Detect and persist `serverType` in Add Server. Reject unknown signatures.
3. Replace the current field cascade with the strict backend switch in section
   3.1.
4. Implement authenticated llama.cpp `/props`, including router mode.
5. Implement Ollama `/api/ps`; require the selected model to be loaded.
6. Make discovery preserve detailed resolver errors and skip invalid models.
7. Reuse the resolver from Auto-Configure and Test & Refresh.
8. Thread `serverType` through `ServerConfig` to request construction.
9. Remove `tool_choice` only for Ollama and emit a warning.
10. Remove vLLM-only continuation controls from secondary-backend retries and
  verify assistant-prefill continuation.
11. Add user documentation and backend launch/setup examples.
12. Simplify preset matching to a case-insensitive substring check — a preset's
  `vllmModelId` must appear somewhere in the served id (or its `root`). Preset ids
  are authored org-free (`Qwen3.8-27B`), so llama.cpp full-path ids like
  `/srv/data/models/Qwen3.8-27B-Q6_K.gguf` match by basename. All prior
  matching tiers (quantization stripping, cross-org keys) were removed.
13. Server Settings webview auto-detects `serverType` for **unconfigured** models
  from the `/v1/models` data it already fetches (any positive `max_model_len` →
  `vllm`; any `owned_by: "llamacpp"` → `llamacpp`; no signal → unset, vLLM
  default). The Server Settings add path previously defaulted everything to vLLM and
  silently produced skipped entries for llama.cpp hosts.

## 7. Tests

### Context resolution

- vLLM returns matching positive `max_model_len`.
- vLLM rejects missing, zero, malformed, or unmatched context metadata.
- LM Studio prefers a matching loaded instance context.
- LM Studio accepts matching configured `max_context_length` when not loaded.
- LM Studio rejects missing or malformed metadata.
- llama.cpp reads authenticated `/props.n_ctx` and ignores `n_ctx_train` for
  budgeting.
- llama.cpp router mode URL-encodes the model query parameter.
- Ollama reads the matching loaded model from `/api/ps`.
- Ollama rejects an unloaded or unmatched model with instructions to load it.
- No discovery or token-budget path contains a numeric fallback.

### Detection and requests

- Each standard signature is detected during Add Server and persisted.
- Ollama detection succeeds for a shape-valid `/api/ps` response regardless of
  `owned_by` value.
- Ambiguous signatures are rejected.
- Configs without `serverType` always resolve as vLLM.
- A manually written third-party entry without `serverType` receives a targeted
  vLLM metadata error that explains how to opt in to a secondary backend.
- Runtime paths perform no backend-detection probes.
- Preset matching is a case-insensitive substring check on served id / root; a
  llama.cpp full-path gguf id matches the org-free preset id by basename.
- Server Settings auto-detection returns `vllm` for any positive `max_model_len`,
  `llamacpp` for `owned_by: "llamacpp"`, and `undefined` when no documented
  `/v1/models` signal exists (no guessing).
- vLLM, LM Studio, and llama.cpp preserve request parameters.
- Ollama drops `tool_choice`, keeps `tools`, and warns once per session.
- Secondary backends omit `continue_final_message` and
  `add_generation_prompt` during auto-continue while retaining assistant prefill.
- Existing vLLM request-body tests remain unchanged and green.

### Streaming

- `reasoning` and `reasoning_content` both work.
- Usage-only final chunks work.
- Streams with and without `[DONE]` finalize pending tool calls once.
- Fragmented and one-shot tool arguments work.
- Cancellation aborts the fetch and stream reader.

## 8. Live Verification

Verified on 2026-08-15:

- LM Studio `127.0.0.1:1234`: `/api/v1/models`, streaming chat, reasoning,
  usage, required tool choice, and fragmented tool calls.
- LM Studio-managed llama.cpp `127.0.0.1:59112`: authenticated `/props` reports
  `n_ctx: 262144`; streaming chat, reasoning, usage, and required tool choice
  work.

Ollama is not currently running and remains provisional until the same checks
pass against a live standard installation.

## 9. Acceptance Criteria

1. Every advertised model has a positive context window read from its required
   backend endpoint; none is guessed or derived from training metadata.
2. A malformed, unsupported, unauthorized, or strangely shaped server is rejected
   with an actionable error.
3. Existing vLLM configurations and request bodies retain their current behavior.
4. LM Studio and llama.cpp complete normal Copilot chat and tool workflows.
5. Ollama is called supported only after live chat, tool, stream, context, and
  cancellation and auto-continue verification succeeds.
6. `npm run compile`, `npm test`, `npm run test:coverage`, and `git diff --check`
   pass before merge.
