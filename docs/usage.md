# Token & Cost Usage Tracker

**Created:** 2026-08-11
**Status:** ✅ Implemented, compiled, tests pass
**Schema / user-facing config:** see [Configuration Reference → Token Usage & Cost](configuration-reference.md#token-usage--cost)

---

## What it is

A client-side tracker that shows **cumulative** token consumption and cost for every configured server, live in the dashboard (the server-level **Token Usage and Cost** node is suppressed on OpenRouter — relay models show their own cost/token rows instead). It captures each completed prompt exactly once and surfaces it in two places:

- **Last Request** — the most recent prompt per server (per-prompt tokens, timing, and cost).
- **Token Usage and Cost** — **model-first**: one collapsible node per model whose collapsed line carries the price (`$11.51 today and $31.13 total`), expanding to **Today / Overall** token-only rows (persisted across reloads).

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
                       │ 2. accumulate all-time + today, stamp first-record time (per server+model)
                       │ 3. persist (serialized globalState write)
                       │ 4. fire onUsageStoreDidChange
                       ▼
              dashboard.ts → fireTreeUpdate() → tree re-render
```

Both the **Last Request** and **Token Usage and Cost** nodes are fed by the same ingestion point and the same change event. This is deliberate: they consume the identical input payload and publish to the identical UI, so a single module (rather than two with separate caches and event plumbing) is the only maintainable structure. **There is exactly one writer** — `recordRequest` — and readers (the dashboard) read through the store, never around it.

## Data model

### Keying

Everything keys on the **normalized server URL → wire model ID** (`vllmModelId`, falling back to `id`). The same model on two servers is two distinct counters; two presets pointing at the same wire model on one server share one counter. The dashboard normalizes `model.serverUrl` before lookup (scheme-less / trailing-slash / `/v1` forms all resolve), matching the store's write key.

### Two count planes + start timestamps

| Plane | Lifetime | Persisted | Purpose |
|---|---|---|---|
| `allTime` | until reset | ✅ | the exact "Overall" — survives retention pruning |
| `days[YYYY-MM-DD]` | 90-day retention | ✅ | daily breakdown + future weekly/monthly sums |

Day buckets are date-keyed (`YYYY-MM-DD`) so "today" and any future weekly/monthly aggregate are all sums over buckets — no schema change later. Stale buckets are pruned at load (90 days).

Additionally, `startedAt[serverUrl][modelId]` records the epoch ms of each model's **first recorded request** — it backs the `· started X ago` label on the model's Overall row and is persisted (shape v2) so it survives reloads. Reset clears the entry, so the next record re-stamps it (recording "restarted").

### Summation semantics

`cached` ⊆ `prompt` (cache-read input tokens) and `reasoning` ⊆ `completion`. Components are summed independently; **totals are always Σprompt + Σcompletion** — never `total + cached`. Cached% and reasoning% are derived from the same buckets at render time.

## Persistence

- Single `globalState` key `vllm-copilot.usage.v1`, versioned for forward migration (currently **v3**: adds the actual-cost planes `allTimeCost`/`daysCost`; v1/v2 data loads in place, counts unchanged, cost planes default to `{}` with no fabricated cost).
- **Writes are serialized** through a chained promise. `globalState.update` is async, so two rapid completions could otherwise interleave read-modify-write and lose an update; chaining guarantees writes land in order. The snapshot is deep-copied at schedule time so later mutations cannot bleed into an in-flight write.
- Loaded once in `activate()` (`initUsageStore`), before any request can complete. Corrupt/missing data degrades to a fresh store.

## Cost: estimates derived, actual spend stored

**Estimated cost is never persisted.** It is derived at render time from each model's `cost` config and the stored token counts:

```
cost = (prompt − cached) / 1M × input
     + cached / 1M × cachedInput
     + completion / 1M × output
```

**Actual reported cost (OpenRouter `usage.cost`) IS stored** — it is server truth, not derivable from rates — in separate all-time/day planes (`allTimeCost`/`daysCost`, v3), also per `(server, model)`. The dashboard **prefers actual cost when a model has any**, falling back to the per-1M estimate per slot otherwise. Actual and estimated cost are **never summed**. Editing a rate re-prices the estimate history without any migration; recorded actual spend is unchanged.

- **Rates are per 1,000,000 tokens**, entered in the model's `currency` unit (default `USD`; `"AI Credits"` renders a credits label — 1 credit = $0.01 — values are entered directly, no conversion applied).
- **Currency decoration uses a small static map, not an i18n library** — `$` (USD), `€` (EUR), `£` (GBP), `¥` (JPY/CNY), `credits` (AI Credits); any other currency falls back to its raw code (`EUR 12.35`). This also means a non-USD currency never renders as a wrong `$`. Actual OpenRouter cost is always USD.
- Fresh input is priced at `input`; cache-read input at `cachedInput`. No cache-write surcharge — self-hosted vLLM never bills for it.
- **Cost is per MODEL only; there is no server-level cost sum.** Models on one server may legitimately use different currencies (USD vs AI Credits), so summing them into a server aggregate would produce a wrong money number. Each model's price sits on its collapsed line (labeled with its currency); the **Today / Overall** rows are token-only. The per-request **Cost** row under Last Request shows the single-request cost with fine precision. The user sums costs across models manually. This was a deliberate decision after `aggregateCost` was removed — do not re-introduce a server cost aggregate.
- **Entry point:** right-click the Token Usage and Cost node → **Set Cost…** (`vllm-copilot.configureCost`) guides through model → rates → currency and writes the `cost` block via the config store. Hidden from the command palette because it requires a server-context argument.

## Reset semantics

`resetUsage('all' | { serverUrl })` clears `allTime` + `days` + `startedAt` (and the v3 actual-cost planes `allTimeCost`/`daysCost`) for the scope, persists, and fires the change event. **The Last Request node is deliberately NOT cleared** — it remains the useful last prompt. Entry points: **right-click the Token Usage and Cost node → Reset Usage** (server scope), and the `vLLM-Copilot: Reset Usage` palette command (all / per-server QuickPick). "Reset" means *start counting from zero* — all history, not just today.

## Live dashboard updates (the staleness fix)

Both nodes re-render **immediately** after every completed prompt via `onUsageStoreDidChange` → the dashboard's `fireTreeUpdate()` (microtask-coalesced, so auto-continue retries that complete back-to-back cause a single re-render).

This fixed a **pre-existing bug**: the Last Request node was previously written by `setLastRequest` with no notification, so the dashboard only re-rendered on the metrics poll interval — the node was stale for up to `pollIntervalMs` after every request. The change event removes that lag for both nodes.

## Design decisions & gotchas

- **Auto-continue retries count as separate requests.** The retry loop calls `consumeStream` once per attempt, and each completion that carries a usage payload is recorded — a continuation request genuinely re-sends the context and generates new tokens, so per-HTTP-request accounting is the honest number.
- **`formatCost` precision adapts** so a per-request cost of `$0.000019` never collapses to `$0.0000`: ≥$100 → 0 decimals, ≥$1 → 2, ≥$0.01 → up to 4 with trailing-zero stripping, else up to 6. The collapsed cost summary uses the same fine precision for real currencies (AI Credits keep 2 decimals), so sub-cent actual spend never renders as `$0.00`.
- **Server URLs are normalized before any store read/write** — the two existing normalization bugs (scheme-less, `/v1` forms) are the reason the store keys on the normalized form.

## Where the code lives

| Concern | File |
|---|---|
| Store (last request + accumulation + persistence + cost math) | `src/usageStore.ts` |
| Ingestion point | `src/provider/consumeStream.ts` |
| Dashboard tree (Last Request, Token Usage and Cost, Reset, Set Cost) | `src/dashboard.ts` |
| Set Cost / Reset commands | `src/commands.ts` |
| Config schema (`cost` field) | `src/config.ts`, `package.json` |
| Tests | `test/usageStore.test.ts`, `test/dashboard.test.ts`, `test/configureCost.test.ts` |

**Related:** [Configuration Reference → Token Usage & Cost](configuration-reference.md#token-usage--cost) for the full config schema; [feature-ideas.md](feature-ideas.md) tracks the feature's evolution.
