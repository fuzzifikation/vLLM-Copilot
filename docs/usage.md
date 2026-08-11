# Token & Cost Usage Tracker

**Created:** 2026-08-11
**Status:** ✅ Implemented, compiled, tests pass (615 passed / 0 failed)
**Schema / user-facing config:** see [Configuration Reference → Token Usage & Cost](configuration-reference.md#token-usage--cost)

---

## What it is

A client-side tracker that shows **cumulative** token consumption and estimated cost for every configured vLLM server, live in the dashboard. It captures each completed prompt exactly once and surfaces it in two places:

- **Last Request** — the most recent prompt per server (per-prompt tokens, timing, and estimated cost).
- **Token Usage** — cumulative **Today / Session / Total** token counts with a per-model breakdown, persisted across reloads.

## What it is NOT

It is **not** a replacement for server-side metrics (`/metrics`). vLLM's `/metrics` endpoint reports cumulative counters from *server start*; this tracker is about *client-side* usage that survives individual vLLM server restarts and is visible without scraping Prometheus.

---

## How a request flows: one ingestion point → two UI surfaces

```
vLLM SSE stream → provider/consumeStream.ts (if pendingUsage)
                       │ recordRequest(LastRequestData)
                       ▼
                 src/usageStore.ts
                       │ 1. store last request (per server, replace)
                       │ 2. accumulate all-time + today + session (per server+model)
                       │ 3. persist (serialized globalState write)
                       │ 4. fire onUsageStoreDidChange
                       ▼
              dashboard.ts → fireTreeUpdate() → tree re-render
```

Both the **Last Request** and **Token Usage** nodes are fed by the same ingestion point and the same change event. This is deliberate: they consume the identical input payload and publish to the identical UI, so a single module (rather than two with separate caches and event plumbing) is the only maintainable structure. **There is exactly one writer** — `recordRequest` — and readers (the dashboard) read through the store, never around it.

## Data model

### Keying

Everything keys on the **normalized server URL → wire model ID** (`vllmModelId`, falling back to `id`). The same model on two servers is two distinct counters; two presets pointing at the same wire model on one server share one counter. The dashboard normalizes `model.serverUrl` before lookup (scheme-less / trailing-slash / `/v1` forms all resolve), matching the store's write key.

### Three planes

| Plane | Lifetime | Persisted | Purpose |
|---|---|---|---|
| `allTime` | until reset | ✅ | the exact "Total" — survives retention pruning |
| `days[YYYY-MM-DD]` | 90-day retention | ✅ | daily breakdown + future weekly/monthly sums |
| `session` | one activation | ❌ (in-memory) | "since this window opened" — resets on reload |

Day buckets are date-keyed (`YYYY-MM-DD`) so "today", "total", and any future weekly/monthly aggregate are all sums over buckets — no schema change later. Stale buckets are pruned at load (90 days).

### Summation semantics

`cached` ⊆ `prompt` (cache-read input tokens) and `reasoning` ⊆ `completion`. Components are summed independently; **totals are always Σprompt + Σcompletion** — never `total + cached`. Cached% and reasoning% are derived from the same buckets at render time.

## Persistence

- Single `globalState` key `vllm-copilot.usage.v1`, versioned for forward migration.
- **Writes are serialized** through a chained promise. `globalState.update` is async, so two rapid completions could otherwise interleave read-modify-write and lose an update; chaining guarantees writes land in order. The snapshot is deep-copied at schedule time so later mutations cannot bleed into an in-flight write.
- Loaded once in `activate()` (`initUsageStore`), before any request can complete. Corrupt/missing data degrades to a fresh store.

## Cost: per-model only, derived never stored

Cost is **never persisted**. It is derived at render time from each model's `cost` config and the stored token counts:

```
cost = (prompt − cached) / 1M × input
     + cached / 1M × cachedInput
     + completion / 1M × output
```

- **Rates are per 1,000,000 tokens**, entered in the model's `currency` unit (default `USD`; `"AI Credits"` renders a credits label — 1 credit = $0.01 — values are entered directly, no conversion applied).
- Fresh input is priced at `input`; cache-read input at `cachedInput`. No cache-write surcharge — self-hosted vLLM never bills for it.
- Because cost is derived, **editing a rate re-prices all history** — no migration.
- **Cost is per MODEL only; there is no server-level cost sum.** Models on one server may legitimately use different currencies (USD vs AI Credits), so summing them into a server aggregate would produce a wrong money number. The **Today / Session / Total** rows are token-only; cost appears on each per-model row (and on the per-request **Cost** row under Last Request) labeled with that model's currency. The user sums costs manually. This was a deliberate decision after `aggregateCost` was removed — do not re-introduce a server cost aggregate.
- **Entry point:** right-click the Token Usage node → **Set Cost…** (`vllm-copilot.configureCost`) guides through model → rates → currency and writes the `cost` block via the config store. Hidden from the command palette because it requires a server-context argument.

## Reset semantics

`resetUsage('all' | { serverUrl })` clears `allTime` + `days` + `session` for the scope, persists, and fires the change event. **The Last Request node is deliberately NOT cleared** — it remains the useful last prompt. Entry points: a **Reset Usage** row at the bottom of the Token Usage node, and the `vLLM-Copilot: Reset Usage` palette command (all / per-server QuickPick). "Reset" means *start counting from zero* — all history, not just today.

## Live dashboard updates (the staleness fix)

Both nodes re-render **immediately** after every completed prompt via `onUsageStoreDidChange` → the dashboard's `fireTreeUpdate()` (microtask-coalesced, so auto-continue retries that complete back-to-back cause a single re-render).

This fixed a **pre-existing bug**: the Last Request node was previously written by `setLastRequest` with no notification, so the dashboard only re-rendered on the metrics poll interval — the node was stale for up to `pollIntervalMs` after every request. The change event removes that lag for both nodes.

## Design decisions & gotchas

- **Auto-continue retries count as separate requests.** The retry loop calls `consumeStream` once per attempt, and each completion that carries a usage payload is recorded — a continuation request genuinely re-sends the context and generates new tokens, so per-HTTP-request accounting is the honest number.
- **Session counters reset on an explicit usage reset** (not just on reload) — "start from zero" is literal. Changing this is a one-line edit.
- **`formatCost` precision adapts** so a per-request cost of `$0.000019` never collapses to `$0.0000`: ≥$100 → 0 decimals, ≥$1 → 2, ≥$0.01 → up to 4 with trailing-zero stripping, else up to 6.
- **Server URLs are normalized before any store read/write** — the two existing normalization bugs (scheme-less, `/v1` forms) are the reason the store keys on the normalized form.

## Where the code lives

| Concern | File |
|---|---|
| Store (last request + accumulation + persistence + cost math) | `src/usageStore.ts` |
| Ingestion point | `src/provider/consumeStream.ts` |
| Dashboard tree (Last Request, Token Usage, Reset, Set Cost) | `src/dashboard.ts` |
| Set Cost / Reset commands | `src/commands.ts` |
| Config schema (`cost` field) | `src/config.ts`, `package.json` |
| Tests | `test/usageStore.test.ts`, `test/dashboard.test.ts`, `test/configureCost.test.ts` |

**Related:** [Configuration Reference → Token Usage & Cost](configuration-reference.md#token-usage--cost) for the full config schema; [feature-ideas.md](feature-ideas.md) tracks the feature's evolution.
