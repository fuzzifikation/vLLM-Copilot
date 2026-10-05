# dsh Bridge Plan: Local DeepSeek Harness on the vLLM-Copilot Registry

**Status:** Ruled plan (owner decisions below are standing law for this feature). Adapter contract spike-verified 2026-10-03 against dsh `0.2.0-rc.2` (dsh-llm `LlmAdapter`); pi-ai HTTP wire facts archived from the 2026-10-01 spike.
**Supersedes:** the free-form bridge entry that lived in [feature-ideas.md](./feature-ideas.md).
**Prerequisite:** the reusable core restructuring. **Met 2026-10-05** - the plan completed with owner Phase-9 acceptance (its history lives in git; the host-neutral core ships in v1.37.0). This document owns the dsh integration.

## Intent

Local-model users want a real agent harness (sandboxed tools, subagents, sessions) without a single vendor login. DeepSeek Harness (dsh) is the strongest open harness and it already serves local models natively, so the missing piece is not another harness: it is a zero-config bridge from our model registry into theirs, with our request pipeline sitting in the middle. Users keep their vLLM/OpenRouter servers, their model modes, their personalities, their usage ledger, and get the full dsh plugin ecosystem for free because we never fork dsh.

## Owner rulings (standing, do not re-propose around them)

1. **We sit in the middle** between the dsh agent loop and the real model servers. Nothing unaccounted-for may sit in that path: our adapter terminates the harness wire and speaks to the backends through the existing pipeline.
2. **dsh stays 100% upstream.** We contribute config overlays and supervision only, never a fork. Full compatibility with other dsh plugins is a consequence of not touching them.
3. **Separate extension** for the adapter stack, in its own repo. Marketing law: people search "dsh running locally for vLLM"; "vLLM-Copilot" must not be the only thing they find. Cross-promotion both directions, possibly a collection.
4. **No dependency on Jager's extension** (`NEXTINDIE/DeepSeek-Harness-for-VS-Code`, MIT, verified). Our client stands on its own feet; MIT code may be copied where they did good work, with attribution kept in `THIRD-PARTY-NOTICES.txt`.
5. **Runtime delivery via npx is acceptable.** DeepSeek's own documented entry is `npx @deepseek-ai/dsh web`; our users are pros and may wait for an install. We only make adapters.
6. **The harness owns the conversation, we own the request.** dsh gets no say in how a model is addressed or parameterised. Its client contributes the message array, its own tool definitions, and a model id; our model configs (modes, sampling params, `chat_template_kwargs`, output budget, backend quirks, routing suffixes, headers) are applied by us on the way out. Their model intelligence in `compat` (`chatTemplateKwargs`, `chatTemplateArgs`, `vllmPriority`, `thinkingFormat`, reasoning switches) stays unset in the route profile, so no model behaviour is decided inside their process.

## Architecture

```mermaid
flowchart LR
    subgraph DSH["dsh (upstream, npx @deepseek-ai/dsh web)"]
        LOOP[agent loop, 26 tools, sandbox,<br/>subagents, plugins]
        ADP[our LlmAdapter plugin:<br/>yields StreamChunk]
    end
    subgraph PKG["Shared Node.js core (this repo)"]
      CORE[catalog, request execution,<br/>stream policy, personalities, accounting]
    end
    subgraph MAIN["vLLM-Copilot editor host"]
      REG[registry + catalog]
      LEDGER[canonical usage owner + dashboard]
    end
    subgraph COMP["Companion ext (new repo): dsh adapter stack"]
        SUP[supervisor: detect, install, launch, health]
        GEN[overlay generator: privacy + persona rows]
        CFGW[config writer: registry to file]
    end
    LOOP -->|"GenerateOptions"| ADP
    ADP -->|"StreamChunk"| LOOP
    ADP --> CORE
    REG -.config snapshot.-> CFGW
    CFGW -.writes config file.-> ADP
    ADP -.completed request records.-> SUP
    SUP -.planned usage ingestion.-> LEDGER
    CORE --> SRV[vLLM, OpenRouter, LM Studio, ...]
    GEN -.writes cordis.patch.yml.-> DSH
    SUP -.spawns.-> DSH
```

  The adapter is a cordis plugin loaded inside dsh's process. It implements dsh-llm's `LlmAdapter` contract: one required method `stream(options: GenerateOptions): AsyncIterable<StreamChunk>`. It projects dsh input into the shared core's request path and yields `StreamChunk` objects back. There is no additional bridge HTTP listener, port, Bearer token, or SSE re-emission; backend HTTP/SSE parsing remains in the core. Failures still need translation into dsh's error taxonomy.

  The companion runs on the same workspace extension host as the main extension. It writes a versioned config snapshot to DSH_HOME containing the effective registry/model settings, required toggles, and explicit personality/workspace paths; the plugin reads that snapshot. Settings changes rewrite it and restart dsh with an explicit active-request drain/cancellation policy. The shared core runs in each consumer's process, not through an `extension.exports` request proxy.

  Two repos remain the product boundary: this repo owns the core and the existing editor integration; the companion owns the adapter plugin, supervisor, overlays, and client. Shared code does not imply shared storage. The proposed supervised path returns completed request records to the main extension's canonical usage owner. Its durable transfer, idempotency, resets, and UI notifications must be specified and verified before integration; writing a separate dashboard-invisible ledger under DSH_HOME is not sufficient.

### Adapter contract (dsh-llm, SPIKE-VERIFIED 2026-10-03)

`@deepseek-ai/dsh-llm` exports an abstract `LlmAdapter` class. The contract:

- **Required:** `abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>`. The only method that must be implemented.
- **Optional overrides:** `providerInfo`, `providerRetryPolicy`, `imageRequestPricing`, `listModels`, `resolveModel`, `prepareCall`. The adapter declares provider routes and model metadata through these.
- **Registration:** `ctx.llm.registerAdapter(providers, adapter)` inside a cordis plugin's `apply()` method. Returns a disposer handle. Fires the `llm/adapters-updated` event.
- **Waterfall:** the `llm/stream` cordis event wraps every streaming call. Middleware can observe, wrap, or short-circuit. Loop-built requests are deep-frozen; the adapter must construct detached wire messages rather than rewrite the harness's request.
- **Input:** `GenerateOptions` is provider-neutral: `provider`, `model`, `messages` (`RequestMessage[]`), `reasoningEffort?`, `tools` (`ToolSchema[]`), `toolHistory?`, `system?`, `signal?` (`AbortSignal`), `maxTokens?`, `temperature?`, `stop?`, `sessionId?`, `purpose?` (`'compaction' | 'session-title'`). Loop requests carry the prompt in a leading system message; one-shot callers can use `system`. Tool results are `ToolResultMessage` objects with `toolCallId`, not `ToolResultBlock`. Tool schemas expose `parameters`, which must map to the core's `inputSchema`. No `stream` flag or `stream_options`.
- **Output:** `StreamChunk` is a discriminated union: `block-start` (`index`, `blockType`), `text-delta` (`index`, `text`), `reasoning-delta` (`index`, `text`), `tool-call-delta` (`index`, `id`, `name?`, `argumentsDelta`), `block-end` (`index`, `block`), `usage` (`usage: TokenUsage`), `finish` (`reason: FinishReason`).
- **Accounting:** dsh's `inputTokens` excludes cache reads/writes; the core's prompt count includes cached input. Convert the semantics explicitly, preserve authoritative totals, and keep actual cost/BYOK in the core ledger rather than losing them in a reduced `TokenUsage` projection.
- **Modes and budgets:** map model modes through adapter-owned reasoning metadata/`reasoningEffort` where supported, with explicit defaults and validation. Define how `maxTokens` and auxiliary-call purpose interact with the core's configured budget; the different field name does not eliminate precedence decisions.
- **Errors:** `LlmError` with dsh's own code taxonomy (`AUTH`, `RATE_LIMIT`, `NO_ADAPTER`, `IMAGE_OFFLOAD_REQUIRED`, etc.). No OpenAI error envelope.

**Spike results (2026-10-03, `temp/dsh-spike/adapter-spike.patch.yml` + `dsh-spike-adapter` package in npx cache):**

- A custom `LlmAdapter` registers and streams from an external cordis plugin. The agent loop calls `stream()` and renders `StreamChunk` objects. Verified end-to-end: hardcoded text appeared on stdout.
- The plugin MUST declare `export const inject = ['llm']` to access `ctx.llm`. Without it, cordis throws `cannot get property "llm" without inject`.
- New plugin entries use `- insert:` syntax in the patch file (modification syntax only edits existing entries; new `id`s are silently ignored).
- The plugin loaded via `file:///` absolute URL (bare specifiers did not resolve from dsh's internal module loader in the npx cache; production will need proper npm package installation).
- `stream()` is called twice per user message: once for the response, once for title generation. Title-gen behavior survives in the adapter path.
- `registerAdapter(['vllmc'], adapter)` returns a disposer function (the `AdapterRegistrationHandle`).
- The `StreamChunk` sequence `block-start → text-delta → block-end → usage → finish` renders correctly.

## Archived: pi-ai HTTP wire facts (2026-10-01 spike, artifacts in `temp/dsh-spike/`)

These facts describe dsh's behavior through the pi-ai openai-completions adapter (HTTP path). The adapter-plugin architecture above replaces that bridge path. Privacy rows and persona preset splice remain relevant to the overlay generator. The completed plugin spike proves registration and basic text streaming only; message replay, tools, reasoning, usage semantics, and auxiliary-call policy still need verification through the actual plugin.

- **Overlay config:** `npx @deepseek-ai/dsh@latest web --patch <file>` composes without touching permanent profiles; `--dump-config` dry-runs the composed tree and names unknown rows. A patch entry replaces the WHOLE `config` of the targeted row, so generators must restate keys they keep.
- **Model route:** row `llm-pi-ai`, `config.providers.<route> = { api: openai-completions, baseURL, apiKeyEnv, compat: { supportsUsageInStreaming, maxTokensField, ... }, models: [{ id, name, contextWindow, maxTokens }] }`. Our catalog values land on the wire verbatim (`max_tokens: 8192` came from our entry). `apiKeyEnv` resolves a launch-environment variable into the Bearer header.
- **Agent loop:** standard OpenAI wire carries the whole loop, including the error-result path (bad tool args come back as a `role: tool` message and the loop continues). 26 core tools mounted in "Standard mode".
- **Zero login:** disable rows `deepseek-account`, `session-log-deepseek`, `session-telemetry-otel`, `plugin-package-inventory-deepseek`, `desktop-product-telemetry`. The leftover account-controller idles ("pending, waiting for service") harmlessly. UI onboarding gate is skippable ("Configure later").
- **Usage accounting:** dsh consumes streamed `usage` faithfully (badges, tok/s, context ring all rendered from fabricated numbers). An adapter that emits honest usage powers their UI and our cost ledger simultaneously.
- **Persona control:** `system-prompt` row `{ includeHarnessIdentity: false, personaPrefix, personaSuffix, includeRuntimeContext: false }` removes the DeepSeek identity line and runtime-context messages, BUT the prefix is shadowed by scoped `persona` rows nested inside the agent preset rows (`preset-standard` default; also ptc/minimal/cordis). Full replacement patches the preset row itself, restating its plugin list from `--dump-config` and rewriting only the nested persona config. `{{model}}` interpolates OUR catalog name, so personality templates get the active model for free. `complete: true` additionally suppresses all tool-prose sections (nuclear mode, available).
- **Hidden traffic:** every new session fires one extra small persona-free completion at our endpoint for title generation (`max_tokens: 64`); compaction is configurable to a cheap route. The adapter meters everything automatically, and the generator aims those auxiliary calls at the cheap model too.
- **Wire shape:** `stream_options.include_usage`, `store: false`, Bearer auth, UA `deepseek-harness/0.2.0-rc.2`. Client is `openai` JS SDK via Node, so no CORS surface.
- **Request body inventory (measured, `temp/dsh-spike/key-inventory.mjs`):** the harness sends `model`, `messages`, `tools`, `stream`, `stream_options`, `store`, `max_tokens`, and nothing else. Absent: `temperature`, `top_p`, `top_k`, `frequency_penalty`, `presence_penalty`, `repetition_penalty`, `seed`, `stop`, `n`, `response_format`, `reasoning`, `thinking`, `chat_template_kwargs`, `vllm_priority`. The outbound body is a blank canvas, which makes ruling 6 cost nothing.
- **Thinking preservation (measured, `temp/dsh-spike/reason-check.mjs`):** the pi-ai path round-trips reasoning across turns. A stream carrying `delta.reasoning_content` is stored as a thinking block, and the NEXT request's history carries it back as `reasoning_content`, verified byte-for-byte on the wiretap. pi-ai records the reasoning field it saw (`reasoning_content`, `reasoning`, or `reasoning_text`) and replays that field. This is the capability Copilot Chat denies us (see [historical thinking preservation](./copilot-integration.md): Copilot flattens assistant history to visible text before the provider sees it). The custom adapter instead receives `ReasoningBlock` plus any adapter-private replay metadata; it must prove its own backend-correct replay. The pi-ai result is not proof that raw `reasoning_content` arrives in `GenerateOptions.messages`.
- **Certified against:** dsh `0.2.0-rc.2`, Node 24. Preview-era warning applies: `--dump-config` diffing is the regression rail per version bump. Spike artifacts in `temp/dsh-spike/` are git-ignored and ephemeral by design; the verified facts above live in this doc, not in those scripts. The reusable overlay generator is Unit 3 work after core restructuring.

## Unit 2 (this repo): harness-independent core + adapter contract

The reusable core restructuring plan is complete (2026-10-05, shipped in v1.37.0; git history holds the plan). Its boundaries are enforced, not remembered: the dependency-cruiser gates pin the host-neutral core, `npm run core:proof` proves the packed consumer, and `copilot-instructions.md` carries the ownership rules (config cache, sole settings writer, catalog/budget contract). The companion builds on that surface; there is deliberately no second extraction recipe here.

The target is one reusable implementation with framework adapters: VS Code + Copilot, editor services without Copilot, and standalone Node.js consumers. The existing HTTP gateway proposal stays retired; no gateway listener, SSE re-emission, or model-mode id encoding is needed to establish the core boundary.

### Existing evidence and limits

- Plain-data `assembleRequest` was extracted in commit `926a928` (2026-10-03); its input/log shapes are useful starting contracts. The recorded implementation check was 995 passing tests and a green `npm run build`. Its module still imports VS Code, so this is not a completed standalone core.
- The adapter spike registered a plugin and rendered hardcoded text. It establishes external-plugin access to the agent loop, not real backend compatibility or production request/accounting behavior.
- No `extension.exports.harness` API is implemented. A later catalog-read API must specify discovery readiness, capabilities/modes/defaults, budget freshness, and change delivery using the neutral catalog, rather than treating a synchronous picker-cache projection as the core contract.

### Adapter responsibilities after restructuring

| Owned by | Contents |
| --- | --- |
| dsh | Conversation, tool execution/results, sessions, title/compaction prompts and agent-loop scheduling |
| Shared core | Registry/model resolution, configured sampling/modes, budgets, headers, routing/backend quirks, transport, request retry machinery, personalities and accounting semantics |
| dsh adapter | Immutable message/tool projection, mode/output/purpose selection, reasoning replay, visibility/retry policy, `StreamChunk` and usage projection, dsh error mapping |
| Companion/editor host | Snapshot generation, paths/settings changes, process supervision, completed-record transfer and main-ledger ingestion |

The adapter must consume the same core implementation as Copilot, not recreate its phases. It receives an optional `AbortSignal` directly; cancellation/timeouts remain core behavior. Use detached wire messages for personality changes and handle both leading system messages and one-shot `system` input. Preserve tools/results, images/file projections and reasoning with their actual dsh contracts. Choose one retry owner per failure/continuation class so harness retries do not multiply core attempts.

### Bridge verification gates

1. **Core prerequisite:** all restructuring gates pass, including the packed Node.js consumer and existing Copilot acceptance. No dsh process or login is needed to establish core reusability.
2. **Adapter contract:** fixtures exercise frozen input, one-shot/system prompt handling, reasoning plus a second-turn replay, tool call/result/error mapping, mode selection, title/compaction budgets, cache-disjoint usage, finish/error mapping and cancellation. Keep finalized-tool-call support unless incremental output is implemented and verified separately.
3. **Supervision and ingestion:** installed plugin loading, versioned config updates, explicit paths, active-request restart behavior, lifecycle cleanup and completed-record transfer/idempotency. Dashboard totals/last-request events and reset behavior must include dsh requests without counting them twice.
4. **Real backend:** dsh completes an agent turn with a tool call through the packaged core against a real local vLLM server, then a reasoning-preserving follow-up. Both dsh usage and the main ledger agree with backend totals; title/compaction calls are accounted for too. Applicable OpenRouter routing/cost behavior is checked separately.
5. **No-Copilot editor:** fresh VSCodium install from Open VSX, clean main/companion activation, registry/dashboard/usage and a complete dsh agent turn with no Copilot installed. This is bridge acceptance, not a substitute for the core's standalone-consumption gate.

## Competitive snapshot (verified 2026-10-01 against marketplace listings)

- `Jager.dsh-vscode` (3.7k, 5★): complete login-free client for `dsh web` (participant, sidebar, approvals, pills, model discovery, turn-level git rollback). MIT. Copyable material for Unit 4+ client work; never a dependency (owner ruling).
- `lixxx1.dsh-sidebar` (1.4k, 5★): debugger integration is unique; onboarding demands `DEEPSEEK_API_KEY`.
- `baobaolaodie.dsh-tui-vscode` (1.3k, 5★): dsh-TUI in the integrated terminal; Quick Start demands `DEEPSEEK_API_KEY`.
- `WentaoJIang.deepseek-harness` (385): bundled runtime, wants a DeepSeek API key or import from `~/.dsh`.
- `shengsuan-cloud.cline-shengsuan` "DSH Cline" (101k, 3.4★): DSH kernel with Cline-style UX behind an SSYCloud reseller account. Commercial funnel, and mass-demand proof despite login walls.

The gap: all five end onboarding at "configure model credentials yourself". None offers a vLLM-first, zero-credential first run. Our registry translated into a ready dsh deployment is the unclaimed entry point; the client window itself is commoditized, which is why the client is Unit 4 and the bridge is Units 2-3.

## VSCodium, no-Copilot editors (researched 2026-10-03)

The intended harness path has no Copilot dependency: dsh runs in its own Node process/web UI, and the companion supplies supervision, overlays and the adapter plugin. This is the target architecture, not a passed no-Copilot activation test. In VSCodium the harness replaces the agent experience rather than extending Copilot.

- **Gallery law:** VSCodium ships pointed at Open VSX; the Microsoft Marketplace ToS forbids use by non-VS-Code products. This extension is already published on Open VSX (as `System-Sciences.vllm-copilot`), which means VSCodium users already run it, currently on a stale version. Durable duty: every release of this extension AND the companion publishes to Open VSX too (`ovsx publish`, or CI trusted publishing so no token is hoarded), and the `System-Sciences` namespace gets verified to clear the unverified-publisher warning.
- **No-Copilot source inventory (2026-10-03, not editor acceptance):** provider/tool registration uses `vscode.lm`; the dashboard, settings and registry use editor services rather than Copilot's conversation API. Session cleanup has Copilot-specific storage paths. Where chat APIs exist, registration need not have a Copilot consumer; where a fork omits them, optional chat registration must not prevent unrelated editor features from activating. Fresh-editor tests establish actual support, including absent session storage. The future adapter path is not implemented yet. The Copilot picker, Agents window and Copilot CLI are separate from the dsh path.
- **Optional chat picker for VSCodium users:** Copilot Chat is now open source (`microsoft/vscode` `extensions/copilot`, MIT) and VSCodium documents a manual sideload via a custom `product.json` (`trustedExtensionAuthAccess`, `defaultChatAgent`, see VSCodium `docs/ext-github-copilot.md`). Our registered provider should surface in that picker because the `chatProvider` contract is core, but this is unverified and is not a support duty: document the link, add nothing.
- **Positioning:** the five marketplace competitors all assume VS Code and die at "configure your API key". "Agent harness for editors without Copilot" is an unserved search shape that only this stack can fill.

## Unit 3 (new repo): companion extension

Supervisor (detect Node/dsh, install offer, spawn with dedicated `DSH_HOME`, health, logs, dispose), adapter plugin (cordis plugin implementing `LlmAdapter`, reads the config snapshot), overlay generator (privacy rows disabled, preset persona splice from `--dump-config`), persona adapter, status bar, "Open harness" command. The companion writes the effective config snapshot to DSH_HOME on spawn and owns the main-ledger usage handoff. No separate bridge credential file or env-var token: configured backend headers remain part of the local config snapshot. Own client UI later; MIT-Jager code reusable with attribution.

**When the second repo is needed:** at Unit 3 start, after this repo's core restructuring and Copilot acceptance pass (bridge gate 1). Owner deliverable at that moment: create the repo and rule the marketplace name. Search-shape constraint: "dsh local vLLM". Candidates (ruling deferred): display name `DSH Local: DeepSeek Harness for vLLM` / id `dsh-local-vllm`; or `DeepSeek Harness Bridge (vLLM, local)` / id `dsh-vllm-bridge`.

## Unit 4: cross-promotion

This extension: one settings/command pointer "Run a local agent harness" → installs the companion. Companion: Quick Start demands the main extension. Possibly a marketplace collection. Changelog entries for both at their respective first releases; nothing lands in the changelog before ship (changelog epistemology).

## Risks and rails

- **Preview churn** (dsh semver is decorative until stable): we certify against a pinned range, generate overlays only through `--dump-config`-checked templates, and fail loudly on unknown-row errors rather than guessing.
- **Support surface for someone else's product:** the companion's job description is adapters plus a health check; dsh-internal bugs get redirected upstream with a repro bundle (their session JSONL plus our adapter log lines).
- **Node/npx dependency:** documented prerequisite, checked by the supervisor with an actionable error.
- **Stray processes:** the bridge adds no HTTP listener or bridge token; dsh's own web service still needs supervision. Supervisor writes `<DSH_HOME>/dsh.pid` on spawn and reaps a stale process (pid alive, parent dead) on next activation. `dispose()` does NOT fire on a hard host crash, so pidfile-reap is the real safety net, not dispose.
