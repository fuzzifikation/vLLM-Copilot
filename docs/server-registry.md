# Server Registry ("B") — Architecture & Implementation Plan

**Status:** Draft for review — not implemented. Reviewed 2026-08-31: conflict case
tightened to a config error (§4), preview ids made user-editable (§8), Phase 0 folded
into Phase 1 (§9), shadow-override reporting moved into the Update Auth dialog
(§4/§7), zero-model server flow questioned (§2), server order = array order recorded
(§6).
**Created:** 2026-08-24
**Idea origin:** [feature-ideas.md](./feature-ideas.md) → "Named-Server Registry"
**Related decision:** supersedes nothing yet; reconsiders code-review.md's "Accepted product decisions: per-model server identity".

---

## 1. Summary & Goals

Introduce a first-class **server registry**: `vllm-copilot.servers[]` entries own URL,
auth, display name, and backend type. Models reference a server by id instead of
copying those fields. Inline (`serverUrl` on the model) remains supported forever.

**Goals**

1. **Single source of truth for auth.** Rotate a shared credential once, not once per model.
2. **New UX flow:** add a *server* first; add models from it at any time via Model Settings.
3. **Non-breaking**, per the three agreed rules (additive / read-inline-forever / opt-in migrate).
4. **Model-level overrides stay possible** — Model Settings can still overwrite auth and
   server assignment for a single model without touching the registry.
5. Rename feature (v1.33.0) migrates cleanly onto the registry.

**Non-goals (v1)**

- No silent migration, no settings auto-rewrite on activate.
- No new server-level knobs beyond the five fields below (future: TLS, poll interval — reserved, not specified).
- Server-removal semantics (does removing a server remove its models?) — **deliberately deferred**; see §11.

---

## 2. Target UX Flow

**Today (roundabout):** one wizard does server + auth + model pick together; adding a
second model on the same server re-enters or reuses auth through "Add or Reconfigure";
auth lives N times in settings.

**Target:**

1. **Add Server** — user enters URL (+ optional key/headers) → probe validates →
   an optional display name is asked → the server is **saved to the registry**
   (`servers[]`) even with zero models. A model pick is offered immediately but is
   optional and cancellable.
   *(Open decision, to make BEFORE Phase 3, not during: keep this zero-model flow,
   or keep today's "server + first model together" wizard writing the server part
   to the registry? A registry entry with no models is a new object type the
   dashboard must render and §11 removal must cover. If "add the server now,
   models later" is not a real workflow, drop this and Phase 3 shrinks.)*
2. **Add models anytime** — from Model Settings: pick the server from the dropdown →
   its `/v1/models` are listed (the existing "unconfigured stub" mechanism, promoted
   from side-effect to first-class flow) → configure one or many. Also exposed as an
   **"Add Models…"** action on dashboard server nodes.
3. **Dashboard** shows every registry server, including ones with zero configured
   models (state: no models yet), so the entry point in 2 is discoverable.
4. **Editing** — display name, type, auth are edited on the server (registry) by default;
   per-model overrides remain available in the model's form for special cases.

Phase ordering keeps today's flow working until Phase 3 swaps it (§9).

---

## 3. Configuration Shape

```jsonc
// NEW top-level setting, sibling of vllm-copilot.models
"vllm-copilot.servers": [
  {
    "id": "gw-shared",                       // REQUIRED. Unique, stable, user-visible.
    "displayName": "IT Server for GLM5.2",   // optional (Rename Server writes here)
    "serverType": "vllm",                    // optional; missing = vllm (same policy as models)
    "serverUrl": "https://gw.example-corp.com/team-a/inference/gw-shared", // REQUIRED
    "requestHeaders": { "X-API-Key": "..." } // optional; base auth for referencing models
  }
],

"vllm-copilot.models": [
  {
    "id": "glm52-prod",
    "vllmModelId": "zai/glm-5.2",
    "server": "gw-shared",          // NEW. Reference into servers[].id. Optional.
    // ...everything else unchanged (modes, params, budgets, capabilities)
  },
  { "id": "legacy-inline", "serverUrl": "http://localhost:8000" }  // still valid forever
]
```

Notes:

- Field name on the model is **`server`** (string id). Short, reads naturally next to
  `serverUrl`/`serverType`; documented in all three schema surfaces.
- Registry ids are user-facing (shown in pickers). Generated ids during migration use a
  host-derived slug (`vllm-example-corp-com`), de-duplicated with `-2`, `-3` suffixes.
- OpenRouter **may** live in the registry like any backend; rename of `openrouter.ai`
  targets stays blocked (existing policy).

---

## 4. Resolution Semantics — the ONE resolver

All reads go through a single pure function in a new module `src/serverRegistry.ts`:

```ts
interface EffectiveServer {
  serverUrl: string;                      // normalized
  requestHeaders: Record<string, string>; // sanitized, merged
  serverType?: ServerType;
  displayName?: string;
}

resolveEffectiveServer(model: ModelConfig, servers: ServerEntry[]): EffectiveServer
```

Deliberately minimal: no `origin`/`serverId` bookkeeping. Code that needs to know
*which* registry entry it is talking to reads `model.server` directly — ownership is a
question about the model's reference, not about the resolved values.

**Precedence rules (normative):**

| Case | Result |
|---|---|
| `model.server` set, found | base = registry entry; `model.requestHeaders` **shallow-merge over** the base (model wins per key; empty string value = remove key). URL/type/displayName come from the registry. |
| `model.server` set, NOT found | warning (validation): unknown server id. Fall back to inline `serverUrl` if present, else unreachable (today's missing-serverUrl path). |
| `model.server` unset | exactly today's inline behavior. |
| `model.server` AND `model.serverUrl` both set | **config error**: the model is unreachable and validation names both fields. There is no silent precedence to honor forever: the migrate command is the only legitimate producer of refs, and nobody should ship a hand-edited conflict. Migrate cleans up any it creates. |

Rationale for header **merge** (not replace): matches Update Auth's mental model
("add one proxy header without re-entering auth"). Removing a registry header for one
model = set it to `""` on the model (documented; consistent with CLEARABLE_ON_EMPTY).

**Merge implementation order (normative):** sanitize registry headers and model
overrides independently (existing `sanitizeRequestHeaders`), then merge model-over
base, then use the result. Never sanitize the merged object only — a blocked key must
be dropped even when the base alone would have kept it inert.

**Override philosophy:** overrides exist for *extra* per-model headers (proxy routing,
tenant tags) — duplicating credentials there defeats the registry. Precedence stays
absolute (**override wins, silently**) and v1 adds NO drift-detector warnings:
instead, the Update Auth confirmation dialog LISTS any referencing models whose
override shadows the rotated key (one line each; they are already computed for the
target list), so divergence is surfaced at the write, where a decision is possible,
not buried in a log nobody reads at the moment it matters.

`displayName` resolution order (for labels): registry displayName → model
`serverDisplayName` (legacy/override) → `shortUrl(url)`. Whitespace-only values are
treated as unset everywhere (v1.33.0 rule).

---

## 5. Identity & Grouping — the invariant that makes this safe

**Key design decision:** grouping/fingerprinting does NOT switch to id-based keys.
Dashboard nodes, metrics engines, and deep-dive panel keys continue to be derived from
`serverFingerprint(effectiveUrl, effectiveHeaders)`.

Consequences:

- **Zero behavioral change** for grouping, engine pooling, credential isolation
  (same-URL-different-auth still yields separate engines/nodes), usage-store keys,
  `buildModelId` composite ids, and BYOK — because all of them already operate on the
  resolved `(url, headers)` pair. Only the *computation* of that pair moves into §4.
- Two different registry ids pointing at the same URL+headers collapse into one node /
  one engine, exactly as duplicate inline models do today. Validation warns on such
  duplicates but never merges them silently.

This is the property that keeps the blast radius small: **§4 is the only place that
learns about the registry.**

**Server-scoped actions during transition (decision):** NO new node state — no
`registryId` field, no "(mixed)" label. Rename/Update Auth derive their write targets
from the group's members at invocation time (`model.server` refs → registry entries;
ref-less members → inline fan-out as today), and the confirmation dialog ALWAYS lists
the concrete targets (entries + affected model counts). The always-list rule makes the
rare ambiguous cases — refs mixed with inline, or two entries sharing URL+auth —
self-explanatory without special UI states, and migrate converges groups to pure-ref
form so they are temporary by construction.

---

## 6. Impact Analysis — file by file

| File | Change |
|---|---|
| `src/serverRegistry.ts` | **NEW.** Types (`ServerEntry`), `indexServers()`, `resolveEffectiveServer()`, validation warnings, id-slug generator, migration helpers (pure). |
| `src/config.ts` | `VllmConfig.servers?`; `getConfig()` reads `servers`; extend `resolveServerConfig(model, servers?)` to delegate to the resolver when servers are provided (legacy signature still works); `findModelConfigIndex` resolves effective URL via servers before matching; validation warns on unknown/duplicate ids, conflicting `serverUrl`+`server`. |
| `src/configStore.ts` | patch/replace/remove match on the model's **effective** URL — the matcher resolves it via the registry internally; no `ModelIdentity` shape change; **replace-mode preserve list grows: `server`** (presets/Auto-Configure must not detach a model from its server), keeping `serverDisplayName` preservation during the transition. |
| `src/provider/requestBuilder.ts`, `chatTransport.ts`, `discovery.ts` | Pass `config.servers` into `resolveServerConfig`; otherwise untouched (they consume the resolved pair). |
| `src/dashboard.ts` | Grouping loop uses resolver; **listen also on `vllm-copilot.servers` changes**; list registry-only servers (Phase 3) with "Add Models…" child; Rename Server target becomes registry-aware (§7). **Server order = array order of `servers[]`** (one line in `getChildren`): keeps the door open for drag-reorder later, so do not introduce an alphabetical sort. |
| `src/serverSettingsView.ts` (+ `resources/serverSettings.js`) | Group via resolver; **config listener extended to `servers`**; server dropdown lists registry entries (label = displayName); server-level edit card (name/type/auth) writing to `servers[]`; webview messages carry `serverKey` alongside url; `selServerUrl()` becomes "effective URL of selection". |
| `src/commands.ts` | Rename Server / Update Auth derive write targets from group members (refs → registry entries, inline → fan-out); Update Auth rotates the owning layer only and logs overrides shadowing a rotated key. Remove Model unchanged (matcher resolves effective URL). Remove Server: **deferred** (§11) — Phase 2 ships it operating on models only, leaving the registry entry intact, with a note in the confirmation dialog. |
| `src/commands/addServerFlow.ts` | Phase 3: saves a registry entry first-class; model pick optional; OpenRouter branch stores its fixed endpoint as a registry entry too. |
| `src/commands/testAndRefresh.ts` | Grouping/reporting via resolver. |
| `src/extension.ts` | Register Migrate command; deep-dive fallback lookup resolves via registry. |
| `src/vllmClient.ts` | No structural change; cache invalidation after `servers[]` writes (callers already call `clearCache`). |
| `schemas/vllm-copilot-models.schema.json` | `$defs.serverEntry`; model gains `"server"`; `additionalProperties` updated. |
| `package.json` | New configuration property `vllm-copilot.servers`; `server` prop on model items; new command(s). |
| Docs/LM tool | configuration-reference.md, README, `configSchemaTool.ts` GUIDE, this doc's status. |

---

## 7. Write-Path Specifications

All writes go through VS Code config update (Global target) as today, followed by the
existing `clearCache()` convention. **No new storage location** — only a second
configuration key.

1. **Migrate command** (§8) — creates `servers[]`, rewrites models to refs.
2. **Add Server (Phase 3)** — upserts one registry entry (id stable across re-runs:
   match by exact normalized URL+headers fingerprint before generating a new id).
3. Rename Server — targets are derived from the group's members (§5): referenced
   registry entries get `displayName`; ref-less members fan out `serverDisplayName` as
   today. Confirmation lists every write target; two entries sharing URL+auth are
   updated together — they are indistinguishable by definition.
4. **Update Auth** — writes go to the layer that **owns** each key: referenced models
   → their registry entry (auth lives on the server); inline models → the model entry
   (today's behavior). Merge-never-replace preserved in both layers. An earlier draft
   wrote to *both* layers — rejected because it would pin rotated credentials into
   model overrides, after which registry-side rotation could never reach that model.
   If a member's override shadows a rotated key, it is left as-is (override wins) and
   LISTED in the confirmation dialog (§4), not merely logged. Engine header push
   (`updateMetricsEngineHeaders`) receives each group's *effective* headers, computed
   via §4.
5. **Model Settings save** — unchanged contract (`patchModelConfig`), plus: editing the
   server card writes the registry entry; changing the model's server dropdown writes
   `model.server`.
6. **Presets / Auto-Configure (`replaceModelConfig`)** — preserve `server` and
   `serverDisplayName` when the replacement omits them (extends the v1.33.0 rule).

---

## 8. Migration Command

`vLLM-Copilot: Migrate Servers to Registry` (palette + offered once from the dashboard
header row; **never** auto-invoked).

Algorithm:

1. Read `models`; group by existing `serverFingerprint(normalizedUrl, headers)`
   (same-URL-different-auth ⇒ separate entries — preserves today's semantics).
2. For each group: propose `id` (host slug). The preview step (3) presents every
   proposed id in an EDITABLE input, defaulted to the slug: ids are user-facing
   (§3), and letting the user name them at preview removes any need for
   de-duplication suffix machinery. Uniqueness is validated at confirm.
3. Preview step: modal listing each proposed server entry (id editable) and affected
   model count, plus full JSON diff in the output channel. The modal offers
   **Copy backup** — the complete pre-migration `models` array as JSON to the
   clipboard. This is the primary rollback path: users' `settings.json` is
   typically NOT under version control, so "restore via git" is not a real story.
   Confirm required.
4. Single atomic write: `servers` = existing ∪ proposed; each member model gains
   `"server": "<id>"` and drops `serverUrl`, `requestHeaders` (identical to the group),
   and `serverDisplayName` (moved up). Models whose headers differed are simply members
   of their own group — divergence can't occur inside a group by construction.
5. Idempotent: second run is a no-op (all models already carry refs).

---

## 9. Implementation Phases (each ends green: compile + full suite)

**Phase 1 — Core read path (invisible).** `serverRegistry.ts`, `getConfig().servers`,
resolver wired into all 8 `resolveServerConfig` call sites + `findModelConfigIndex`;
validation warnings; config listeners extended to `servers`. Includes the audit the
old draft called "Phase 0": the existing suite already pins the grouping/engine-pooling
invariants (dashboard identity-split tests, per-credential engine tests), so verify
coverage and add tests only for real gaps — a parallel "freeze" suite would duplicate
what CI enforces. Hand-written registry configs work end-to-end; zero UI change.
Existing tests pass unmodified — that IS the acceptance gate for non-breakage.

**Phase 2 — Write paths.** Migrate command; Rename/Update Auth/Remove Server
registry-awareness; configStore identity + preserve-list (`server`). Full test matrix
for each (§10).

**Phase 3 — UX flow.** Add Server saves registry-first; dashboard lists registry-only
servers + "Add Models…" action; Model Settings server-centric layout (dropdown →
server card → model list with configure affordance). Webview JS changes validated with
`node --check` + render tests.

**Phase 4 — Polish.** Schemas/docs/GUIDE; CHANGELOG; version bump (**only with user
approval**); release notes describing the migrate command.

Phases 1–2 are independently shippable; Phase 3 may ship in one or two releases.

---

## 10. Testing Plan

- **Pure resolver matrix** (new): ref-found / ref-unknown / inline-only / conflict /
  header override adds-key / overrides-remove-key (`""`) / whitespace displayName /
  duplicate-id warning / OpenRouter entry.
- **Migrate golden tests:** representative configs (single model; N models one server;
  same URL two credentials; OpenRouter mix) → exact expected `servers`+`models` JSON;
  idempotency; cancel-writes-nothing.
- **Behavioral freeze:** existing dashboard/engine/settings tests run unmodified
  throughout every phase (the Phase 1 acceptance gate) — any change to them means
  something broke, not that behavior evolved.
- **Own-layer auth rotation:** a referenced model's rotation updates the registry
  entry only (model untouched); an inline model's rotation stays model-local; an
  override shadowing the rotated key is left as-is and named in the output log.
- **Request-time merge end-to-end:** requestBuilder emits registry+override merged,
  sanitized headers on the wire (blocked keys dropped even when present in the base).
- **Server-scoped actions:** Rename/Update Auth on any group write exactly the targets
  listed in their confirmation (refs → entries, inline → fan-out).
- **Preserve-list:** preset replace keeps `server` + `serverDisplayName`.
- **Webview:** server dropdown labels from registry; server-card save round-trip;
  draft-preservation across external `servers[]` refreshes.

---

## 11. Open Questions (decided later, by design)

1. **Server removal lifecycle** — when a registry server is removed: block while models
   reference it, cascade-delete models with confirm, or detach models to inline form?
   *(Deferred per product decision 2026-08-24. Phase 2 interim: removal operates on
   models only and leaves the entry.)*
2. Dashboard placement of registry-only servers (top-level vs collapsible "Unused
   servers" node).
3. Whether `model.serverDisplayName` stays as a permanent per-model label override or
   becomes migration-only legacy (lean: permanent override, documented).

---

## 12. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **`findModelConfigIndex`/store resolve effective URLs through the registry — the ONE place the registry stops being additive and changes what existing writes MEAN. A resolver bug here can silently rewrite the WRONG model. This is Phase 2's real gate.** | Resolve **effective** URL inside the matcher; Phase 2 golden tests cover it; treat as above the preserve-list tests in priority. |
| Stale caches miss `servers[]` edits | All `servers[]` writers call `clearCache()` (existing convention); listeners watch the new key. |
| Partial adoption confusion (some models inline, some referenced, same box) | Supported; server actions always list their concrete targets; migrate converges. |
| Presets silently detaching models from servers | Preserve-list extension + regression tests (Phase 2 gate). |
| Two registry entries with identical URL+auth | Validation warns on creation; server actions update all entries the group references, listed in the confirmation. |
| Validation warnings become noise on partially-migrated setups | Warnings are deduplicated per session per distinct cause, and every warning names the exact fix (run Migrate / remove conflicting field). |
| Schema drift across three declaration sites | Artifact sync tests exist since v1.33.0; extended to `servers` in Phase 4. |
