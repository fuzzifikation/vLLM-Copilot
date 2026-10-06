# LLM Gateway — the user-control forwarder plan

**Status (2026-10-06): proposal, spike passed.** Nothing here is adopted law yet —
the spike evidence is real, the remaining decisions are listed as open rulings.
Origin: a live architecture audit of the dsh bridge (same day) traced four
separate "the UI doesn't know" symptoms (status chip, dashboard chrome,
`systemMessageCapture`, preset personalities) to **one bug class**: feature state
living in one extension host while several clients produce traffic. A library
cannot fix that class — a service can. This document proposes building the
service as a second head of this repo, not as a new product elsewhere.

## The thesis

> core + an independent settings file + a small HTTP server = every client
> (Copilot chat, Agents window, dsh, BYOK, curl, the next UI nobody has written
> yet) gets this extension's full behavior — modes, budgets, retries,
> personalities, capture, accounting — with the extension nowhere on the wire.

Positioning sentence (working): **"Your models, your rules, your ledger — across
every agent."** Not a convenience proxy (one endpoint, many models — LiteLLM,
OpenRouter own that story). A **control plane**: what the model was told
(visibility), what it's allowed to be told (policy), what it cost
(accountability), who may know the servers exist (privacy).

## What the spike already proved

`spike/gateway/` in the **dsh-vllm-bridge** repo — one ~250-line Node file, zero
dependencies, importing this extension's public core API (staged profile copy)
exactly as the bridge's harness adapter does. Against the real server, first run:

| Check | Result |
| --- | --- |
| fat catalog `/v1/models` | live-probed context window 262144, all 3 modes, default mode, personality name — from `describeModel`/`resolveRuntimeLimits`, no client code |
| personality in-line | a system message containing the preset's exact `find` text came back REWRITTEN ("Sarcastic Genius Identity" rule fired server-side) |
| capture | core `CaptureQueue` wrote the entry with `rulesApplied` — P6 is a placement question, not a missing feature |
| streaming relay | real tokens streamed through the relay, 149 ms round trip — one localhost hop, unmeasurable next to generation |
| accounting | usage metered at the relay point (the correct meter location for "one ledger, every client") |

Two findings that corrected the plan's premises:

1. **Preset name-resolution is already core** (`resolveModelReplacements` in the
   core export list). The gap that hid "Sarcastic Robot" from the harness is the
   bridge's own mirror reading only the path flavor — bridge-side fix, not a
   core change.
2. The core's own header already names this future: *"the Copilot provider
   today, a harness gateway tomorrow … one source build, no copies."* The
   export list is already shaped for this consumer.

## Why it lives in THIS repo (proposed ruling 1)

The wishlist mechanism of the companion bridge exists because one core consumer
sat outside the core repo — every P-item was a drift-toll payment (staging
stamps, fingerprints, version handshakes, contract stand-ins). A third repo
consuming core over the same vendored-staging chain, under the standing
no-npm-publish law, re-invents that machinery for a consumer sharing our working
tree, CI, and author. Inside the repo, drift goes to zero by construction and
the one-source-build law holds unchanged.

Distribution falls out of the same decision: **the VSIX ships the gateway, and
the extension launches and supervises it** — the exact spawn → pid-record →
adopt-across-windows → drain-on-stop pattern the bridge hardened over 0.0.4 →
0.0.15. Marketplace ships the daemon; no publish pipeline needed; lifecycle is
known engineering, not a new risk.

**Re-open this ruling only if:** the gateway ever needs a different license or
sponsor model, a second autonomous maintainer, or a headless-server runtime the
VSIX cannot carry.

## Target architecture

```
VS Code chat / Agents window / BYOK ─┐
dsh harness (via bridge) ────────────┼── HTTP + SSE (loopback) ──►  gateway  ──►  vLLM / OpenRouter servers
aider / opencode / curl (any client)─┘        │                  (this repo's core,
                                               │                   own settings file,
VS Code extension ── settings editor,          │                   owns the ledger)
  provider shim, dashboard client, supervisor ┘
```

The extension stops being the wire for anyone's traffic; it becomes **client +
control UI + supervisor**. Clients learn one port and one token; server URLs,
credentials, and hostnames become the gateway's private knowledge — which makes
"the harness can't leak a hostname" a structural property instead of snapshot
discipline.

## API surface (draft)

| Endpoint | Purpose | Notes |
| --- | --- | --- |
| `GET /health` | liveness, served models | unauthenticated, no secrets |
| `GET /v1/models` | fat catalog: OpenAI list + `context_window`, `modes`, `default_mode`, `personality`, `wire_model_id` | pickers render from it; ids are display keys (P3 identity stays) |
| `POST /v1/chat/completions` | OpenAI-compatible chat, streamed (SSE relay) or single JSON | personality → `assembleRequest` → `executeChatRequest` verbatim; mode via `mode` field (documented non-standard extension); relay duties: abort propagation, no buffering, usage on the completion event |
| `GET /usage` | ledger totals per server/model | replaces the cross-window sync question with a query |
| (later) `GET /captures`, `POST /usage/ingest` | visibility + accounting endpoints | `CaptureQueue`/`ingestExternalUsage` are already core exports |

Auth: bearer token(s), loopback-bound; per-client tokens are the seed of
per-client attribution and quotas (control pillar #4's enforcement point).

## Ladder (each rung standalone-useful)

- **M0 — done:** spike in the bridge repo, recorded there (`spike/gateway/README.md`).
- **M1 — skeleton in-tree:** `src/gateway/` (thin HTTP face, imports core only),
  settings-file schema v0, `node out/gateway` boot, the smoke script promoted
  into this repo's rails. Extension gets a launch/stop command (supervisor port).
- **M2 — first real client:** bridge adapter switches to gateway-client behind a
  setting; BOTH architectures coexist (today's library path keeps working);
  **BYOK test**: a VS Code custom-endpoint model pointed at the gateway keeps
  personalities + capture with zero gateway-aware client code. M2 is the
  thesis-or-not moment.
- **M3 — settings ownership flips** (proposed ruling 2, the big one): the
  gateway's file becomes the registry's source of truth; VS Code settings become
  a projection the extension edits. Adjacent to (and should merge with)
  `config-file-plan.md` — decide once, not twice.
- **M4 — one ledger:** the extension's usage store becomes a gateway client;
  chip/dashboard finally read the truth that includes every client; cross-window
  sync machinery retires.
- **M5 — the moat:** per-client attribution and budgets at the token, redaction
  (PII, paths, models-that-never-see-X), approval intercepts. The relay seam was
  built for exactly this; nobody local ships it.

## Non-goals

- No chat UI. A dashboard (web, the pattern both repos already ship) yes; chat is
  correctly someone else's product — "we own no chat UI" is what makes "we serve
  every chat UI" credible.
- No renames before the role changes. `vllm-copilot` stays until the gateway
  ships; then repo rename (GitHub redirects, the marketplace id doesn't notice).
- No new distribution channels, no npm publish, no cloud component.
- The bridge repo is not deprecated: it stays the harness's client, the editor's
  supervisor, and — permanently — the one external staged consumer that keeps
  the core's public-API discipline honest (with `core-api.txt`).

## Open rulings (decide before/at M1)

1. **R1 repo placement** — build in this repo (recommended above) vs standalone.
2. **R2 settings ownership** — M3's flip mechanics; co-design with `config-file-plan.md`.
3. **R3 supervisor ownership** — port the bridge's supervisor here, or extract a
   shared package (drift vs duplication, small either way).
4. **R4 gateway API stability law** — the wire is OpenAI-clean except the
   documented `mode` extension and the custom catalog fields; adopt the
   core-export discipline (contract changes ride version bumps + a rail) from day one.
5. **R5 BYOK test verdict gate** — M2 cannot close without it.

## Verification gates

- core API surface: existing `core-api.txt` rail must cover the gateway's import set.
- promoted smoke script runs against `node out/gateway` in CI rails.
- bridge `bridge:check` keeps its full suite through M2 (coexistence means both paths test).

## Evidence trail

- dsh-vllm-bridge repo: `spike/gateway/` (gateway, settings, smoke, README findings),
  `docs/vllm-copilot-integration.md` (the drift ledger that motivated R1),
  `docs/dsh-bridge-plan.md` (supervisor precedent), `docs/plan.md` L18 (the
  rejected-proxy precedent — this gateway is the *opposite* trade: the data plane
  moves INTO our owned process, not through a foreign one).
- Session evidence (2026-10-06): chip ruling by design; dashboard live-verified
  growing +83k tokens/45 s while its chrome looked frozen; capture proven
  writer-in-core; preset resolution proven already-core.
