# Feature Ideas: vLLM Capabilities → Better VS Code Experience

**Generated:** 2026-06-06
**Updated:** 2026-07-12 (consolidated; shipped ideas removed, roadmap references dropped)
**Source:** [vLLM SamplingParams API Reference](https://docs.vllm.ai/en/latest/api/vllm/sampling_params.html)

**Context:** vLLM supports many per-request sampling parameters that the extension doesn't expose yet. These represent opportunities to build features that VS Code's built-in Copilot doesn't have — making vLLM-Copilot the superior local model integration.

> **Tracking:** Only two docs are maintained: this file (new ideas) and [known-bugs.md](../known-bugs.md) (real bugs and nice-to-have refactors). There is no consolidated roadmap.

---

## The Moat: What Makes This Extension Irreplaceable

VS Code's built-in BYOK (Custom Endpoint provider) now covers plain chat, tool calling, vision, streaming, and a thinking-effort picker. Verified against the VS Code source (`extensions/copilot/src/extension/byok/`), the **only** thing BYOK structurally *cannot* do is send arbitrary request-body parameters:

- `modelOptions` is hard-limited to `temperature` and `top_p` — any other keys are silently dropped.
- `reasoningEffortFormat` only emits a fixed `reasoning_effort` enum; it cannot produce `chat_template_kwargs.enable_thinking`.
- `requestHeaders` touches HTTP headers only, never the body.
- There is no body-passthrough field anywhere in its schema.

**Every feature that sends a vLLM-specific request-body param is therefore something BYOK can never replicate. That is the moat.**

Two buckets:

- 🛡️ **Painkillers (the moat)** — sampling / structured-output params BYOK literally cannot send. These make the extension *irreplaceable*.
- ✨ **Vitamins (on-brand, but replaceable)** — informational / UX features like the Server Status UI and the Model Configuration UI. Genuinely differentiating and worth building, but Microsoft could add equivalents.

> **The biggest UX gap today:** every vLLM-specific param (`bad_words`, `structured_outputs`, `repetition_detection`, `chat_template_kwargs`, …) requires hand-editing `settings.json`. The moat features are functionally complete but *undiscoverable* without form UI. The **Model Configuration UI** ([UI-Feature.md F9](./UI-Feature.md#f9-model-configuration-ui-priority-high)) is the single highest-leverage UX improvement — it makes every existing moat feature accessible to colleagues who don't want to read the JSON schema.

---

## Featured Idea: 💡 Custom System Prompt Override

> **Category:** UX / prompt control — *not* a vLLM parameter. This is a "vitamin" that addresses a genuine pain point: users may not want Copilot's default system prompt injected into every request.

**What happens today:** Copilot sends a system message (role 3, ~21KB) containing its own instructions + `.github/copilot-instructions.md`. The extension merges any AGENTS.md/CLAUDE.md into this single system message, then forwards the full payload to vLLM.

**What it does:** Let users replace Copilot's system prompt entirely with their own custom text, either per-model or globally.

**Feature idea:** Add a `customSystemPrompt` setting that, when set, replaces the Copilot system message content instead of merging into it.

**VS Code use cases:**
- **Token savings:** Copilot's system prompt is ~21KB (~5K tokens). A custom prompt can be much shorter, leaving more context for conversation.
- **Model-specific tuning:** Different models respond better to different system prompts. Users can optimize per-model.
- **Custom behavior:** Users may want to enforce their own workflow rules, code style, or output format at the system level.
- **Privacy/Minimalism:** Some users may not want Copilot's internal instructions in the model context.

**Why it matters:** Gives users full control over what enters the model's context window. This is a quality-of-life improvement, but also a genuine differentiator from BYOK (which doesn't let you replace the system prompt either).

**Implementation:**
- Add `customSystemPrompt?: string` to `VllmConfig` and per-model config
- In `buildRequest`, if `customSystemPrompt` is set and a system message exists, replace its content instead of merging
- Settings UI: multi-line text field, optional per-model override
- Consider: file-based variant (e.g., `customSystemPromptFile: ".github/my-system-prompt.md"`) for version control

---

## ✨ Server Status UI (Flagship Differentiator — Visible Surface)

> **Category:** UI / observability — *not* a sampling parameter. The one "vitamin" worth highlighting because it's the most *visible* proof the extension talks to a real vLLM server (something BYOK is completely blind to). Integrate the active mode/params so the UI advertises the moat rather than just mirroring `nvidia-smi`.

**vLLM endpoints:** `/health`, `/version`, `/v1/models`, `/metrics` (Prometheus, enabled by default)

**What it does:** A live panel showing the state of the connected vLLM server — health, loaded model, context window, and real-time serving metrics (throughput, queue depth, KV-cache utilization).

**Feature idea:** A status-bar item plus a detail view (webview or tree) in the sidebar.

**What to surface:**
- **Connection & health** — reachable? vLLM version, uptime
- **Model** — loaded model id, `max_model_len`, dtype / quantization (from `/v1/models`)
- **Live metrics (`/metrics`)** — tokens/sec throughput, running vs. waiting requests, GPU KV-cache utilization %, TTFT, prefix-cache hit rate
- **Active configuration** — current model mode + the sampling params actually in effect (ties the UI back to the moat)

**VS Code use cases:**
- **Local GPU awareness** — "is my server saturated / KV cache full / queue backed up?"
- **Trust & debugging** — confirm the request actually hit vLLM and which model answered
- **Mode visibility** — see at a glance which model mode and params are active
- **Health at a glance** — status-bar dot goes red when the server is unreachable

**Why it matters:** BYOK shows *nothing* about server state. For someone running local models, throughput and KV-cache pressure are the numbers they actually care about. Surfacing the active mode/params here also makes the extension's unique capability visible on every request — turning an informational feature into an advertisement for the moat.

**Implementation:**
- Poll `/metrics` on a configurable interval; the poller is a `Disposable`, invalidated on `onDidChangeConfiguration` (same cache/dispose pattern as the rest of the extension)
- Parse the Prometheus text format (the only non-trivial bit; everything else is JSON)
- Status-bar item (health + tokens/sec) → click opens the detail view
- Reuse `VllmClient` for the connection/config (single source of truth — no second cache)
- Respect cancellation and dispose all timers/listeners in `dispose()`

**Server-side requirement:** `/metrics` is on by default; no special flag needed. (Only disabled if the server was started with `--disable-log-stats`.)

---

## ✨ Last Request Details Dashboard Entry

> **Category:** Dashboard / observability — a "vitamin" that gives users immediate feedback on the last chat completion without digging into logs. Built on the `usage` object vLLM returns at end of every stream.

**What happens today:** After every chat-completion request, vLLM returns a `usage` block with `prompt_tokens`, `completion_tokens`, `total_tokens`, `reasoning_tokens`, `cached_tokens`, `prompt_time`, `decode_time`, and `num_prompt_tokens`. The extension currently tracks this for token-budget bookkeeping but never surfaces it to the user in the sidebar.

**What it does:** A collapsible tree node in the Dashboard showing the last request's token breakdown per model, sorted by input and output tokens, with a timestamp and "time to first token" (TTFT).

**Feature idea:** Add a **"Last Request Details"** node under each server in the Dashboard tree. Each row shows one completed request with:

- **Model ID** — `vllmModelId` (the server-side alias, not the preset name)
- **Timestamp** — when the request finished (relative, e.g. "2 min ago")
- **Input tokens** — `prompt_tokens` (expanded: cached tokens, reasoning tokens if applicable)
- **Output tokens** — `completion_tokens` (expanded: reasoning tokens, decode tokens)
- **TTFT** — `prompt_time` or derived from response metadata
- **Latency / throughput** — total time and tokens/sec (derived from `decode_time` + `completion_tokens`)

**VS Code use cases:**
- **Token budget sanity-check:** "Why is my context window so small?" → see the input token count
- **Cached prefix awareness:** "Is the prefix cache actually helping?" → compare `cached_tokens` across requests
- **Model comparison:** "Does model A use more tokens than model B for the same prompt?"
- **Debugging slow responses:** High TTFT vs. low throughput tells you whether the bottleneck is prefill or decode

**Why it matters:** The dashboard already shows server-level throughput and queue depth. Adding per-request token details gives users the missing "micro" view — why did *my* last request take that long and cost that many tokens? This is something BYOK never shows.

**Implementation:**
- Store the last N request-usage objects per model (in-memory or `ExtensionContext.storagePath`; N = 1 or 10, TBD)
- Parse `usage` from the end-of-stream `WireUsage` in `streamReader.ts` → `sseParser.ts`
- Add a `LastRequestTreeItem` class (following `ServerTreeItem` / `MetricTreeItem` pattern)
- Auto-purge entries older than a configurable threshold (default: 10 minutes; `vllm-copilot.dashboard.lastRequestRetentionMs`)
- Collapse by default; expand to show sorted rows (by `total_tokens` or timestamp)
- One row per model, or one row per recent request (design decision pending)

**Open questions:**
- **How many entries to keep?** Last one only (lightweight) vs. last N (e.g. 10) for comparison. More entries = more tree items = more UI clutter.
- **Per-model or per-server?** Group under the server node that served the request (model is shown in the row).
- **Persistence?** In-memory only (resets on reload) vs. persisted to `storagePath` (survives reload but adds I/O).
- **Should this integrate with the Deep-Dive view?** Deep-Dive already shows raw Prometheus metrics; a "recent requests" table could live there too.

---

## Already Exposed ✅ (reference, not ideas)

These are shipped and live in `defaultParams`/`modelModes`. Listed here only to avoid re-proposing:

| vLLM Parameter | Where |
|---|---|
| `max_tokens`, `temperature`, `top_p`, `top_k`, `min_p`, `repetition_penalty`, `presence_penalty`, `frequency_penalty`, `seed`, `stop`, `min_tokens`, `thinking_token_budget`, `chat_template_kwargs` | `defaultParams` + `modelModes` |
| `bad_words`, `ignore_eos`, `repetition_detection`, `structured_outputs` | `defaultParams` + `modelModes` |
| `tools` / `tool_choice` | Copilot integration (Chat Provider) |

> **Note:** There are no dedicated top-level fields for sampling params like `stop`, `min_tokens`, `bad_words`, etc. They are sent as raw `snake_case` keys in `defaultParams` (model-scope) or any `modelModes` entry (mode-scope). The extension passes through any vLLM chat-completion body field this way.

---

## Not Exposed — Complete List of Unused Parameters

**14 parameters** remain defined in vLLM's `SamplingParams` but not exposed by the extension (excluding computed/internal properties).

| # | vLLM Parameter | Type | Default | Category |
|---|---|---|---|---|
| 1 | `allowed_token_ids` | `list[int] \| None` | `None` | Logits Processing |
| 2 | `detokenize` | `bool` | `True` | Output Formatting |
| 3 | `extra_args` | `dict[str, Any] \| None` | `None` | Plugin/Custom |
| 4 | `flat_logprobs` | `bool` | `False` | Performance/Logprobs |
| 5 | `include_stop_str_in_output` | `bool` | `False` | Output Formatting |
| 6 | `logit_bias` | `dict[int, float] \| None` | `None` | Logits Processing |
| 7 | `logprob_token_ids` | `list[int] \| None` | `None` | Logprobs/Scoring |
| 8 | `logprobs` | `int \| None` | `None` | Logprobs/Scoring |
| 9 | `n` | `int` | `1` | Generation Control |
| 10 | `prompt_logprobs` | `int \| None` | `None` | Logprobs/Prompt |
| 11 | `routed_experts_prompt_start` | `int` | `0` | Experts/Routing |
| 12 | `skip_special_tokens` | `bool` | `True` | Output Formatting |
| 13 | `spaces_between_special_tokens` | `bool` | `True` | Output Formatting |
| 14 | `stop_token_ids` | `list[int] \| None` | `None` | Generation Control |

---

## Detailed Feature Proposals

### 1. Multiple Outputs Per Request 💡 Future

> **Demoted 2026-07-13:** Structurally incompatible with the current Chat Provider API. The `Progress<LanguageModelResponsePart>` channel is a single linear stream with no concept of alternatives, indices, or tabs. vLLM emits interleaved `choices[index]` chunks; Copilot has nowhere to render the parallel outputs. Concatenating them as plain text is worse than `n: 1` (wall of text, no per-option accept/reject). The natural home for `n > 1` is `InlineCompletionItemProvider` (which returns `InlineCompletionItem[]` the user cycles with `Alt+]`) backed by vLLM's `/v1/completions` endpoint — but that's a separate product, not a Chat Provider param.

**vLLM Parameter:** `n` — number of outputs to return
**vLLM Docs:** `SamplingParams.n` (max controlled by `VLLM_MAX_N_SEQUENCES`)

**What it does:** Generate N completions from a single prompt in one request.

**Feature idea:** Requires either a richer Copilot chat API that supports alternative completions, or a separate inline-completion provider built on `/v1/completions`.

**Blocker:** The Chat Provider API has no way to surface multiple parallel outputs. Needs a better Copilot API, not a param.

---

### 2. Logprobs / Token Confidence ⭐

**vLLM Parameter:** `logprobs`, `prompt_logprobs`
**vLLM Docs:** `SamplingParams.logprobs`

**What it does:** Returns log probabilities for each generated token, showing how confident the model was.

**Feature idea:** Show token-level confidence in the editor or Chat UI.

**VS Code use cases:**
- **Code quality indicator:** Dim uncertain tokens, highlight confident ones
- **Debug mode:** See where the model is guessing vs certain
- **Parameter tuning:** A/B test temperature settings by comparing logprob distributions
- **Trust metric:** "This code was generated at 95% confidence" vs "52% confidence"

**Why it matters:** Users don't know when the model is guessing. Visual confidence feedback builds trust (or healthy skepticism) in generated code.

**Implementation:**
- Add `logprobs?: number` to `VllmChatOptions` (number of top-logprobs per token)
- Parse logprob data from vLLM response
- Add diagnostic or decoration in editor for confidence coloring
- Could be a toggle: "Show token confidence" in Chat view

---

### 3. Logit Bias — Token Steering ⭐

**vLLM Parameter:** `logit_bias` — dict[int, float] mapping token IDs to bias values
**vLLM Docs:** `SamplingParams.logit_bias`

**What it does:** Influences which tokens are more/less likely at generation time. Positive = more likely, negative = less likely.

**Feature idea:** Advanced mode for power users who want fine-grained control over generation.

**VS Code use cases:**
- **Language steering:** Bias toward tokens common in target language (Python, Rust, etc.)
- **Token blocking:** Set specific token IDs to large negative values (alternative to bad_words)
- **Style control:** Bias toward formal/informal tokens

**Why it matters:** This is the most granular control available. For advanced users, it's a superpower.

**Implementation:**
- Add `logitBias?: Record<string, number>` to modelModes only (too complex for global settings)
- User provides `{ "token_string": bias_value }`, extension converts to token IDs via tokenizer
- Requires tokenizer access — may need to call vLLM's tokenization endpoint

---

### 4. Stop Token IDs ⭐

**vLLM Parameter:** `stop_token_ids` — list of token IDs that stop generation
**vLLM Docs:** `SamplingParams.stop_token_ids`

**What it does:** Stops generation when specific token IDs appear (more precise than string matching).

**Feature idea:** For advanced users who know their tokenizer, this is more reliable than string-based `stop`.

**VS Code use cases:**
- **Exact special tokens:** Stop at `<|eot_id|>` or model-specific markers
- **Multi-turn boundaries:** Prevent model from generating assistant+user turns
- **Template control:** Stop at exact chat template delimiters

**Why it matters:** String-based stop sequences can miss tokens due to whitespace or encoding differences. Token IDs are exact.

**Implementation:**
- Add `stopTokenIds?: number[]` to modelModes
- Advanced-only setting

---

### 5. Allowed Token IDs — Output Vocabulary Restriction

**vLLM Parameter:** `allowed_token_ids` — `list[int] | None`
**vLLM Docs:** `SamplingParams.allowed_token_ids`

**What it does:** Constructs a logits processor that only retains scores for the specified token IDs. All other tokens are effectively masked out (probability set to zero).

**Feature idea:** Restrict model output to a specific vocabulary — useful for constrained generation scenarios.

**VS Code use cases:**
- **Multiple choice completion:** Only allow tokens corresponding to predefined options
- **Command generation:** Restrict output to known command vocabulary
- **Control flow tokens:** Force model to output only specific structural tokens
- **Debugging:** Isolate model behavior to a small token set

**Why it matters:** Unlike `logit_bias` which influences probability, `allowed_token_ids` hard-constrains the vocabulary. This is the most aggressive form of output control.

**Implementation:**
- Add `allowedTokenIds?: number[]` to modelModes only (too specialized for global settings)
- Requires tokenizer access to convert strings to IDs

---

### 6. Detokenize Control

**vLLM Parameter:** `detokenize` — `bool` (default: `True`)
**vLLM Docs:** `SamplingParams.detokenize`

**What it does:** Controls whether vLLM detokenizes the output. When `False`, raw token IDs are returned instead of text.

**Feature idea:** Advanced debugging / analysis mode — see what tokens the model actually generated before detokenization.

**VS Code use cases:**
- **Tokenizer debugging:** Understand how tokens map to text
- **Token-level analysis:** Inspect raw token boundaries
- **Performance profiling:** Skip detokenization overhead in benchmarks

**Why it matters:** Almost never needed in normal usage, but invaluable for debugging tokenization issues or understanding model internals.

**Implementation:**
- Add `detokenize?: boolean` to modelModes only
- Default `true` — only useful as `false` for debugging

---

### 7. Extra Args (Custom/Plugin Extension Point)

**vLLM Parameter:** `extra_args` — `dict[str, Any] | None`
**vLLM Docs:** `SamplingParams.extra_args`

**What it does:** Arbitrary additional arguments for custom sampling implementations, plugins, or extensions. Not used by any in-tree vLLM sampling.

**Feature idea:** Forward compatibility / extensibility — allow users to pass custom parameters to vLLM plugins.

**VS Code use cases:**
- **Custom vLLM plugins:** Users who extend vLLM with custom logits processors
- **Future vLLM features:** New parameters can be tested before the extension officially supports them
- **Research/Experimentation:** Pass custom flags for testing

**Why it matters:** Provides a forward-compat hook. When vLLM adds new sampling params, users can test them without waiting for the extension to update.

**Implementation:**
- Add `extraArgs?: Record<string, unknown>` to modelModes only
- Pass through directly to vLLM request body under `extra_args`
- No validation — user responsibility

---

### 8. Flat Logprobs (Performance Optimization)

**vLLM Parameter:** `flat_logprobs` — `bool` (default: `False`)
**vLLM Docs:** `SamplingParams.flat_logprobs`

**What it does:** Returns logprobs in a flattened format (`FlatLogprob`) for significantly better performance. Reduces GC costs compared to `list[dict[int, Logprob]]`. Affects both `PromptLogprobs` and `SampleLogprobs`.

**Feature idea:** Performance toggle for logprobs — enable when requesting logprobs in high-throughput scenarios.

**VS Code use cases:**
- **Batch analysis:** When analyzing many code snippets with logprobs enabled
- **Reduced latency:** Faster response when logprobs are requested
- **Memory efficiency:** Lower GC pressure during extended sessions

**Why it matters:** If/when logprobs are exposed (Feature #2), this is a performance optimization. No standalone use case yet.

**Implementation:**
- Add `flatLogprobs?: boolean` to modelModes
- Only effective when `logprobs` or `prompt_logprobs` is also set
- Likely irrelevant for single-request Chat usage

---

### 9. Include Stop String in Output

**vLLM Parameter:** `include_stop_str_in_output` — `bool` (default: `False`)
**vLLM Docs:** `SamplingParams.include_stop_str_in_output`

**What it does:** When `True`, the stop strings are included in the generated output text. By default, vLLM strips them.

**Feature idea:** Include the delimiter/stop sequence in the output for post-processing.

**VS Code use cases:**
- **Template parsing:** When stop strings are structural markers needed for parsing
- **Multi-section output:** Stop strings serve as section boundaries
- **Custom chat templates:** Delimiters needed for downstream processing

**Why it matters:** Usually users want stop strings excluded, but some workflows need them. Simple toggle.

**Implementation:**
- Add `includeStopStringInOutput?: boolean` to modelModes
- Boolean flag in request body

---

### 10. Logprob Token IDs — Targeted Token Scoring

**vLLM Parameter:** `logprob_token_ids` — `list[int] | None`
**vLLM Docs:** `SamplingParams.logprob_token_ids`

**What it does:** Returns logprobs for specific token IDs only. More efficient than `logprobs=-1` when you only need probabilities for a small set of tokens. Useful for scoring/comparing specific label tokens.

**Feature idea:** Targeted confidence scoring — check model confidence for specific tokens without full logprob overhead.

**VS Code use cases:**
- **Binary classification:** "Is the model confident this is Python vs JavaScript?"
- **Token presence check:** "What's the probability the model generates `}` next?"
- **Label scoring:** Compare probabilities of a few specific candidate tokens
- **Lightweight confidence:** Cheaper than full `logprobs` when you only care about a handful of tokens

**Why it matters:** Efficient alternative to full logprobs when you have a small set of tokens to score. Great for classification-style tasks.

**Implementation:**
- Add `logprobTokenIds?: number[]` to modelModes
- Parse targeted logprob data from vLLM response
- More efficient than `logprobs: N` when scoring <N tokens

---

### 11. Prompt Logprobs — Input Token Analysis

**vLLM Parameter:** `prompt_logprobs` — `int | None`
**vLLM Docs:** `SamplingParams.prompt_logprobs`

**What it does:** Returns log probabilities for each prompt (input) token. When set to `-1`, returns all `vocab_size` log probabilities per prompt token.

**Feature idea:** Analyze how the model interprets the prompt — see which input tokens have high/low probability.

**VS Code use cases:**
- **Prompt engineering:** See which parts of the prompt the model finds surprising
- **Token understanding:** Debug how the model processes specific input tokens
- **Input validation:** Detect if the prompt contains low-probability token sequences
- **Prompt optimization:** Identify tokens that confuse the model

**Why it matters:** Most users only care about output logprobs. But prompt logprobs are valuable for understanding how the model interprets the context window.

**Implementation:**
- Add `promptLogprobs?: number` to modelModes
- Parse prompt logprob data from vLLM response
- Display as prompt token "surprise" heat map (advanced feature)

---

### 12. Routed Experts Prompt Start (MoE Routing)

**vLLM Parameter:** `routed_experts_prompt_start` — `int` (default: `0`)
**vLLM Docs:** `SamplingParams.routed_experts_prompt_start`

**What it does:** When `enable_return_routed_experts` is active, skips the first N prompt tokens from the returned routing data. Used in multi-turn agent scenarios to avoid duplicating routing for already-covered prompt tokens.

**Feature idea:** Niche — only relevant for MoE (Mixture of Experts) models with expert routing enabled.

**VS Code use cases:**
- **MoE model analysis:** Understand which experts handle which parts of the prompt
- **Multi-turn conversations:** Skip already-processed prefix tokens in routing data
- **Model internals debugging:** Expert routing visualization

**Why it matters:** Very niche. Only relevant for MoE models (Mixtral, DeepSeek, etc.) with expert routing enabled. Probably not worth exposing unless users specifically request it.

**Implementation:**
- Add `routedExpertsPromptStart?: number` to modelModes only
- Requires `enable_return_routed_experts` server-side flag
- Very low priority

---

### 13. Skip Special Tokens

**vLLM Parameter:** `skip_special_tokens` — `bool` (default: `True`)
**vLLM Docs:** `SamplingParams.skip_special_tokens`

**What it does:** When `True` (default), special tokens (like `<|im_start|>`, `<|end|>`, etc.) are filtered from the output text. When `False`, they appear in the output.

**Feature idea:** Show or hide special tokens in the output — useful for template debugging or raw output inspection.

**VS Code use cases:**
- **Chat template debugging:** See exactly what special tokens the model generates
- **Raw output inspection:** Understand model behavior at the token level
- **Custom template development:** Verify template token placement
- **Model training analysis:** Check if the model respects special tokens

**Why it matters:** The default (`True`) is almost always correct. But when debugging chat templates or understanding model behavior, seeing the raw special tokens is invaluable.

**Implementation:**
- Add `skipSpecialTokens?: boolean` to modelModes
- Default `true` — only useful as `false` for debugging

---

### 14. Spaces Between Special Tokens

**vLLM Parameter:** `spaces_between_special_tokens` — `bool` (default: `True`)
**vLLM Docs:** `SamplingParams.spaces_between_special_tokens`

**What it does:** Controls whether spaces are added between special tokens during detokenization.

**Feature idea:** Fine-grained control over special token formatting in output.

**VS Code use cases:**
- **Template formatting:** Adjust spacing around special tokens
- **Raw output matching:** Match exact model output format for parsing
- **Debugging:** Understand detokenization behavior

**Why it matters:** Very minor formatting detail. Only relevant when `skip_special_tokens=false` and precise formatting matters.

**Implementation:**
- Add `spacesBetweenSpecialTokens?: boolean` to modelModes
- Default `true` — only changes when special tokens are shown

---

## Priority Summary

| Priority | Feature | vLLM Parameter | Effort | User Impact | VS Code Differentiator |
|----------|---------|---|--------|-------------|----------------------|
| 💡 Future | Multiple Outputs | `n` | Large (needs new API surface) | Blocked | Blocked — needs richer Copilot API |
| 💡 P2 | Logprobs / Confidence | `logprobs` | High | Medium | Yes — visual trust metric |
| 💡 P2 | Logit Bias — Token Steering | `logit_bias` | Medium | Low (power users) | Advanced control |
| 💡 P2 | Stop Token IDs | `stop_token_ids` | Low | Low (power users) | Precision |
| 💡 P2 | Logprob Token IDs | `logprob_token_ids` | Medium | Low (scoring tasks) | Lightweight confidence |
| 🔧 P3 | Include Stop String | `include_stop_str_in_output` | Low | Low (parsing) | Convenience |
| 🔧 P4 | Allowed Token IDs | `allowed_token_ids` | Medium | Low (specialized) | Hard vocabulary constraint |
| 🔧 P4 | Prompt Logprobs | `prompt_logprobs` | High | Low (prompt engineering) | Input analysis |
| 🔧 P4 | Skip Special Tokens | `skip_special_tokens` | Low | Low (debugging) | Template debugging |
| 🔧 P5 | Detokenize Control | `detokenize` | Low | Very Low | Debugging only |
| 🔧 P5 | Extra Args | `extra_args` | Low | Very Low | Forward compatibility |
| 🔧 P5 | Flat Logprobs | `flat_logprobs` | Low | Very Low | Perf optimization (needs logprobs) |
| 🔧 P5 | Routed Experts Prompt Start | `routed_experts_prompt_start` | Low | Very Low | MoE niche |
| 🔧 P5 | Spaces Between Special Tokens | `spaces_between_special_tokens` | Low | Very Low | Formatting tweak |

**Priority Legend:**
- 💡 **Future** — Blocked on a richer Copilot API. Not implementable today.
- ⭐ **P1** — Big differentiators. Medium effort, high payoff.
- 💡 **P2** — Nice to have. Specialized but valuable.
- 🔧 **P3** — Low priority. Simple to add when convenient.
- 🔧 **P4/P5** — Niche / debugging / future-proofing.

---

## Server-Side Requirements

Some features require specific vLLM server flags:

| Feature | Server Flag |
|---------|-------------|
| Multiple Outputs | `VLLM_MAX_N_SEQUENCES` env var (default 16384, usually fine) |
| All others | No special flags needed |

---

## Notes

- All features should be **opt-in** — don't break existing workflows
- Parameters should flow through the same **modelModes → request merge** pipeline
- Consider an `"advanced"` section in settings for power-user-only options
