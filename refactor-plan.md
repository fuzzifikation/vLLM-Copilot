# Refactor Plan — vLLM-Copilot

**Status:** Plan only — no code changed. Created 2026-08-09.
**Goal:** Reduce the responsibilities of the P1 mega-modules, unify the divergent `saveModelConfig` implementations, and improve testability. Structural phases preserve behavior; explicitly listed bug fixes and hardening changes land in separate, test-pinned steps.

---

## Executive summary

- **The P1 problem is mixed ownership, not file location or a line-count target.** Keep `provider.ts`, `autoConfig.ts`, and `commands.ts` as stable public facades and extract focused implementation modules behind them. Do not move cohesive shared modules solely to make the tree uniform.
- **`config.ts` is the hub (10 in-`src` importers, 15 test files). Leave it flat.** It's a single, tight "config domain" module. Only *add* a peer `configStore.ts` for unified model persistence. Avoids ~25 mechanical import edits for a pure deck-chair shuffle.
- **Unify persistence behind two named operations:** `replaceModelConfig` (autoConfig/preset semantics) and `patchModelConfig` (webview field-merge semantics). Replace drops stale model fields; patch preserves them. A single spread-merge "fix" would silently regress the preset path, while a mode flag would make the destructive choice too easy to hide at call sites. A shared `saveModelConfig` name is deliberately NOT used — the two operations are distinct contracts.
- **Side effects belong to callers, persistence belongs to the store.** `provider.clearCache()`, BYOK setup, the "Settings saved" toast, and `refreshWebview()` stay outside the store. The store reads, clones, merges, normalizes, and writes `vllm-copilot.models`, then returns the saved entry.
- **Test-first is a real requirement, not a slogan.** Replacement-file semantics and basic patch preservation are pinned today; replacement of stale model fields, header replacement/preservation, side-effect ordering, and input immutability are not. Characterize reachable current behavior before extraction, then add explicit red-to-green tests for intentional hardening.
- **Discovery's per-model `/v1/models` fetch is confirmed** (N configs on one server → N identical fetches, each with retry). `deriveTokenBudget`'s throw is confirmed unreachable from the provider. Both are smells, neither is a bug; leave them out of this refactor.

**Completion is behavioral, not numerical:** every phase compiles and passes focused tests; replace/patch semantics are characterized before consolidation; provider tests stop reaching through private members; mutable provider state stays instance-owned; and no temporary test-only delegate ships.

---

## 1. Proposed folder structure

### 1.1 The tree

```
src/
  extension.ts                        (STAYS — package.json "main": ./out/extension.js)
  config.ts                           (STAYS — the config hub; do not move)
  configStore.ts                      (NEW — replaceModelConfig / patchModelConfig, lives beside config.ts)
  types.ts / logger.ts                (STAYS — shared infra, single-file domains)
  sessionManager.ts                   (STAYS — self-contained maintenance utility)
  provider.ts                         (STAYS — thin public class, lifecycle/cache owner)
  provider/
    outcome.ts                        (StreamOutcome construction/reset helpers)
    discovery.ts                      (provideLanguageModelChatInformation core)
    requestBuilder.ts                 (buildRequest)
    streamOrchestrator.ts             (auto-continue retry loop)
    consumeStream.ts                  (SSE → parts/usage/last-request)
    postStream.ts                     (reportPostStreamDiagnostics + handleResponseError)
    systemMessages.ts                 (CaptureEntry + process/load/capture/enqueue pipeline)
    (newly extracted provider implementation only)
  autoConfig.ts                       (STAYS — public command-registration facade)
  commands.ts                         (STAYS — public command-registration facade)
  commands/
    testAndRefresh.ts                 (the ~470-line behemoth + grouping helpers)
    personality.ts                    (setModelPersonality command)
    autoConfigureFlow.ts              (auto-configure command workflow)
    presets.ts                        (preset load/find/merge)
    hfDiscovery.ts                    (autoConfigureModel + HF/vLLM fetchers)
    serverAuth.ts                     (parseHeadersInput / promptForServerAuth)
    addServerFlow.ts                  (registerAddServerModelCommand + confirm/save helpers)
    byok.ts                           (configureByokUtilityModel + ensureByokUtilityDefault)
```

**Do NOT create one-file folders or move stable shared modules for symmetry.** `messageConverter.ts` in particular stays at the root: networking and diagnostics import `describeError`, so moving it under `provider/` would reverse the dependency direction. Networking, views, personality, diagnostics, metrics, `sessionManager`, `logger`, `types`, and `config` stay flat unless a separate plan establishes an independent payoff.

### 1.2 Does the grouping improve cohesion, or shuffle deck chairs?

| Grouping | Verdict |
|---|---|
| `provider/` (new implementation modules) | **Real win.** Keep the public provider at the root; put only extracted implementation behind it. |
| `commands/` (new workflow modules) | **Real win.** `autoConfig.ts` and `commands.ts` remain public facades; extracted workflows get focused homes. |
| `networking/`, `views/`, `personality/` | **Rejected for this refactor.** Existing files are cohesive; moving them adds churn without changing ownership. |
| `config/` folder | **Rejected.** 25 import edits for a folder that just re-exports one cohesive file. Keep `config.ts` + add `configStore.ts`. |
| `diagnostics/`, `metrics/` folders | **Deferred.** First add focused tests and write a separate plan that justifies those splits. |

### 1.3 Import-churn estimate

The revised structure avoids repository-wide import-only moves, but "stable facade" does not mean every current import remains unchanged:

- `extension.ts` keeps importing extension-facing registration functions from root `autoConfig.ts` / `commands.ts`; those facades may re-export registrations from extracted workflow modules.
- Internal consumers import the owning module directly. In particular, `commands.ts` changes its current value import from `./autoConfig.js`: personality persistence comes from `./configStore.js`, and server-auth prompting comes from `./commands/serverAuth.js`.
- Tests target extracted units directly rather than relying on root-facade re-exports, except tests whose purpose is the facade wiring itself.

Import edits are therefore limited to facades being decomposed, internal consumers whose dependency owner changes, extracted modules, and tests intentionally retargeted to the new units.

Do not batch all extractions into one squashed commit. Each responsibility moves in a separate reviewable commit that compiles and passes its focused tests. This preserves `git bisect`, makes rollback local, and prevents a mechanical move from hiding a behavioral change.

### 1.4 Should tests move?

**No — keep `test/` flat.** Reasons:
- `vitest.config.ts` already includes `test/**/*.test.ts` (glob matches subfolders) — no config change needed either way.
- Moving test files adds import edits with zero behavioral gain.
- Several tests span modules after the split (e.g. `configStore.test.ts` tests `configStore.ts`; `autoConfig.test.ts` will test `commands/presets.ts` + `commands/hfDiscovery.ts`). A mirrored layout would force awkward renames.
- Update imports only when a test is deliberately retargeted from a facade/private method to an extracted public unit.

---

## 2. Module-by-module decomposition

### 2.1 `provider.ts` → thin facade + `provider/` implementation

Accurate method map (verified by reading):

| Current method | Lines | Destination |
|---|---|---|
| `StreamOutcome`, `CaptureEntry` interfaces | 28–50 | `outcome.ts` |
| `provideLanguageModelChatInformation` (discovery) | 100–222 | `discovery.ts` |
| `provideLanguageModelChatResponse` (orchestration + auto-continue loop) | 240–389 | `streamOrchestrator.ts` |
| `resetOutcome` | 370–380 | `outcome.ts` (free function) |
| `buildRequest` (request assembly) | 391–497 | `requestBuilder.ts` |
| `consumeStream` (SSE consumption → parts/usage/last-request) | 499–626 | `consumeStream.ts` |
| `reportPostStreamDiagnostics` | 628–754 | `postStream.ts` |
| `handleResponseError` (error classification) | 756–794 | `postStream.ts` |
| `provideTokenCount` | 796–825 | stays on thin class |
| `processSystemMessages` / `loadReplacements` / `captureToDisk` / `enqueueWrite` | 827–1015 | instance-owned `systemMessages.ts` pipeline/writer |
| `diag` | 1017–1021 | `postStream.ts` (small `log()` helper) |

The class remains the lifecycle, cache, event-emitter, client, and collaborator owner. Extracted functions receive narrow explicit collaborators; they do not receive the provider instance. The system-message write queue must remain instance-owned inside a pipeline/writer created by the provider; a module-global queue would couple provider instances and silently change state ownership.

**Dependency injection is an enabler, not a luxury:** `provider.ts:62-64` currently constructs `VllmClient` *inside* the constructor and holds it as `private client`. The tests stub `(provider as any).client = ...` precisely because there is no injection seam. Preserve the existing production call shape `constructor(context, output, fileLogger?)`; add an optional final dependency object, e.g. `constructor(context, output, fileLogger?, dependencies?)`, whose `client` is a narrow client interface. Production defaults to `new VllmClient(context, output, fileLogger)`. Do not insert `client` before `fileLogger`, which would silently reinterpret the existing third argument in `extension.ts`.

The `StreamOutcome` mutation-through-the-stack pattern may initially be preserved by passing an attempt-scoped outcome through free functions. Prefer creating a fresh outcome per retry attempt over reset-in-place only if characterization tests prove identical retry, usage, and diagnostic behavior.

**Cross-attempt contract (verified):** `assistantPrefill`, `prefillIndex`, `openaiMessages`, and `attemptCount` are loop state. Of the fields on `StreamOutcome`, `contentBuffer` is the value that must transfer into the next attempt: `provider.ts:335-345` appends it to `assistantPrefill` **before** `resetOutcome` clears it at `:359`/`:381`. Any fresh-outcome design must preserve the ordering: read `contentBuffer` into the attempt prefill first, then replace the outcome. The outcome retained after the loop must be the final attempt's outcome for diagnostics and error handling.

**Provider test handling — phased, NOT a permanent facade.** The three provider test files (`providerAutoContinue.test.ts` 314, `providerCapture.test.ts` 78, `providerSystemMessages.test.ts` 214) currently stub private methods via `(provider as any).buildRequest = ...`, `(provider as any).client.chatCompletionStream = ...`, `.processSystemMessages`, `.loadReplacements`, `.enqueueWrite`. That reach-in is test-induced design damage — do **NOT** build permanent production methods just to keep it alive. Instead:

- **Phase A (one boundary at a time):** export one extracted unit with explicit collaborators and add focused direct tests.
- **Phase B (wire the public path):** delegate from the real provider flow and run both focused and provider behavior tests.
- **Phase C (same commit):** remove the corresponding `(provider as any)` setup. If a temporary delegate is unavoidable, add and remove it within this phase; it must never become a phase or release boundary.

The required end state is zero provider private-member access in tests and zero production methods that exist only for tests. File sizes are reviewed after extraction but are not acceptance criteria.

### 2.2 `autoConfig.ts` → public facade + focused command modules

| Current block | Approx lines | Destination |
|---|---|---|
| Preset loading: `ModelPreset`, `stripJsonComments`, `findFirstUnquotedSlashSlash`, `loadModelPresets`, `parsePresetJson`, `findPresetForModel`, `mergePresetWithUserConfig` | ~230 | `commands/presets.ts` |
| HF/vLLM discovery: `HfModelInfo`, `HfGenerationConfig`, `VllmModelInfo`, `fetchWithTimeout`, `fetchHuggingFaceModel`, `fetchGenerationConfig`, `fetchVllmModelInfo`, `autoConfigureModel`, `AutoConfigResult` | ~290 | `commands/hfDiscovery.ts` |
| Persistence from `autoConfig.ts` + `serverSettingsView.ts` | ~70 | `configStore.ts` (`replaceModelConfig` / `patchModelConfig`) |
| `ensureByokUtilityDefault`, configure/register utility model | ~80 | `commands/byok.ts` |
| `parseHeadersInput`, `tryRepair`, `promptForServerAuth` | ~140 | `commands/serverAuth.ts` |
| `registerAddServerModelCommand`, `confirmAndSaveAddedModel`, `handleServerFailure`, `pickModelFromServer`, `ServerModelChoice` | ~300 | `commands/addServerFlow.ts` |
| `registerAutoConfigureModelCommand`, `resolveModelConfigForAdd`, `applyAutoConfigUpdate` | ~280 | `commands/autoConfigureFlow.ts` |

Clear responsibility boundaries: presets (pure data + matching), hfDiscovery (network discovery), configStore (persistence), serverAuth (input parsing), addServerFlow (wizard UI), autoConfig (public command wiring), byok (utility-model setting). Extract in that dependency order; do not use target line counts as a completion gate.

### 2.3 `commands.ts` → reassess after shared flows move

Each `registerXxxCommand` is already a cohesive unit — do **not** fragment the command bodies. The file is big because *one* command is huge:

- **`registerTestAndRefreshModelsCommand` + `ServerTestResult`/`ServerGroup`/`serverFingerprint`/`groupModelsByServer`/`checkNetworkGatingSettings`** ≈ **470 lines** → `commands/testAndRefresh.ts`. (The pure grouping helpers are already covered by `test/testAndRefresh.test.ts` — moving them is free.)
- **`registerSetModelPersonalityCommand` + `PersonalityPick`** ≈ 140 lines → `commands/personality.ts`.
- Remaining registrations (diagnose, open/clear logs, clean sessions, update auth, remove server, remove model, `removeModelFromConfig`) ≈ 260 lines → stay in `commands.ts`.

Keep `commands.ts` as a stable public facade. Extract these workflows only after config persistence and auto-config decomposition land, then re-measure responsibilities. The split is justified by independently testable workflows, not a promised final line count.

### 2.4 `diagnostics.ts` — deferred

This is a high-cohesion "run everything → conclude" flow. Do not split it during the P1 refactor. A later plan may evaluate the one defensible boundary, platform primitives versus orchestration, after adding focused tests:

- `diagnostics/platform.ts` (~700 lines): the PowerShell scripts (`POWERSHELL_CHAIN_SCRIPT`, `runPowerShellTest`, `runChainBuildWindows`, `runCurlTest`, `detectCurlBackend`, `runChainBuildOpenSSL`, `detectWinHttpProxy`, `detectIeProxySettings`, `tryExportMissingIntermediate`, `runDirectNodeFetch`) — pure exec-wrappers, zero business logic.
- `diagnostics.ts` (~320 lines): `DiagnosticReport` types, `runDiagnostics` (orchestration + conclusion), `formatReport`.

### 2.5 `vllmMetrics.ts` — deferred

Possible seams exist, but do not split the file in this refactor:
- `metrics/prometheus.ts` — `MetricsParser`, `parseLabels`, `parseRawMetrics` (pure, already tested by `vllmMetrics.test.ts`; moving is free).
- `metrics/engine.ts` — `ServerMetricsEngine`, registry, `getMetricsEngine`, `getPollSettingMs`.
- `metrics/fetch.ts` — `fetchAllEndpoints`, `safeFetch`, `emptyMetrics`.
- `metrics/format.ts` — `fmtPct`, `fmtMs`, `fmtN`, `fmtTokens`, `fmtThroughput`, `shortUrl`.
- `metrics/types.ts` — all interfaces.

First add the missing formatting/view-model tests already listed as P2 in `known-bugs.md`. Re-evaluate the split in a separate plan after those tests establish the boundaries.

### 2.6 Over-engineering guard

Do **NOT** split: `config.ts` (cohesive hub), `messageConverter.ts` (499, one conversion domain), `logger.ts` (294, one class), `sessionManager.ts` (375, self-contained utility), `streamReader.ts`/`sseParser.ts` (already small and layered), `extension.ts` (252) — don't extract an `activation.ts` unless it grows.

---

## 3. Unified model persistence design

### 3.1 The two implementations, precisely (verified)

**`autoConfig.ts:535`** (`saveModelConfig(newConfig: ModelConfig)`, replace mode):
- Match via `findModelConfigIndex(existing, resolveConfigId(newConfig), newConfig.serverUrl)`.
- On match: `merged = { ...newConfig, serverUrl: newConfig.serverUrl ?? prev.serverUrl, requestHeaders: newConfig.requestHeaders ?? prev.requestHeaders, systemMessageReplacementsFile: newConfig.systemMessageReplacementsFile !== undefined ? newConfig.systemMessageReplacementsFile : prev.systemMessageReplacementsFile }` → `normalizeModelEntry(merged)`.
- On no match: push `normalizeModelEntry({ ...newConfig })` (no composite-id generation; caller pre-builds it).
- Side effect inside: `ensureByokUtilityDefault()` at **:578 — un-awaited** (floating promise, see findings).

**`serverSettingsView.ts:310`** (`private saveModelConfig(updates: Partial<ModelConfig>)`, patch mode):
- Match via `findModelConfigIndex(models, updates.id || updates.vllmModelId, updates.serverUrl)`.
- On match: `normalizeModelEntry({ ...existingEntry, ...updates })` — field-level merge.
- On no match: build composite `id = buildModelId(targetServer, vllmModelId)`, `vllmModelId = updates.vllmModelId || targetId`, push.
- Side effects inside: `showInformationMessage` toast, `clearCache?.()`, `refreshWebview()`.

### 3.2 Semantics table

| Field | autoConfig (`replace`) | webview (`patch`) | **unified** |
|---|---|---|---|
| `serverUrl` | required to match an existing entry; the fallback expression is unreachable when omitted | supplied as explicit patch identity | required by both named APIs; never inferred from update payload |
| `requestHeaders` | `newConfig.requestHeaders ?? prev.requestHeaders` | absent preserves | replace: `?? prev`; patch: strip-undefined-then-merge |
| `systemMessageReplacementsFile` | `!== undefined ? newConfig : prev`, then `normalizeModelEntry` (`''` deletes) | absent preserves; `''` overwrites then `normalizeModelEntry` deletes | **both modes: undefined preserves, `''` clears via `normalizeModelEntry`** |
| model-specific fields (`modelModes`, `family`, `capabilities`, `defaultParams`, token settings, `autoContinueRetries`, `streamInactivityTimeout`) | **replaced** by `newConfig` (stale fields dropped) | **preserved** unless present in `updates` | replace: replaced; patch: preserved — *the divergence is the contract* |
| `id` / `vllmModelId` | from `newConfig` (caller set) | from `updates`; new-entry composite built | replace: caller-supplied; patch: composite on new-entry |
| new-entry id | as-is | `buildModelId(serverUrl, vllmModelId)` | operation-dependent (above) |
| caller object mutation | none (`{...newConfig}` clone) | none | none — always clone |
| legacy id fallback (`id`-only entries) | via `findModelConfigIndex`/`resolveConfigId` | same | same shared `findModelConfigIndex` |

### 3.3 Function signatures & location

Lives in new `src/configStore.ts` (peer of `config.ts`, importing `findModelConfigIndex`/`normalizeModelEntry`/`buildModelId` from it — no circulars).

```ts
export interface ModelIdentity {
  id: string;
  serverUrl: string;
}

export interface SaveModelResult {
  model: ModelConfig;
  created: boolean;
}

export type IdentifiedModelConfig = ModelConfig
  & { serverUrl: string }
  & ({ id: string } | { vllmModelId: string });

export function replaceModelConfig(
  entry: IdentifiedModelConfig
): Promise<SaveModelResult>;

export function patchModelConfig(
  identity: ModelIdentity,
  updates: Omit<Partial<ModelConfig>, 'id' | 'serverUrl'>
): Promise<SaveModelResult>;
```

Callers:
- autoConfig add/auto-configure paths → `replaceModelConfig(fullConfig)`.
- personality command → `replaceModelConfig({...model, systemMessageReplacementsFile})` (it already supplies the full model, so replacement preserves all copied fields). **Requires a `serverUrl`:** a model without one currently appends a duplicate entry (verified — `findModelConfigIndex` gets no match → `existing.push`). The personality command must skip + warn for server-less models, not fail to compile silently at a distance.
- serverSettingsView → `patchModelConfig({ id, serverUrl }, updates)`.

Identity is explicit because the current matcher requires both config id and server URL. The existing `serverUrl: newConfig.serverUrl ?? prev.serverUrl` fallback is not reachable for an existing-entry match when the incoming URL is absent; do not claim otherwise in tests. Requiring identity prevents an accidental append when a caller omits a matching field.

`replaceModelConfig` accepts either an explicit `id` or the legacy `vllmModelId` fallback used by `resolveConfigId`; it requires at least one at the type boundary. `patchModelConfig` treats `identity.id` and `identity.serverUrl` as immutable lookup fields. The webview handler extracts them from its payload before calling the store; they are not patchable properties. Both store operations also reject blank/whitespace server URLs and unresolved/blank config identities at runtime rather than writing malformed entries.

**New-entry id precedence in `patchModelConfig`:** derive `wireId = updates.vllmModelId || identity.id`, then call `buildModelId(identity.serverUrl, wireId)` and store that same `wireId` as `vllmModelId`. Thus, when config identity and `updates.vllmModelId` differ, the wire id wins — matching current webview behavior (`serverSettingsView.ts:336`). Pin both the precedence and fallback cases in tests.

### 3.4 Side-effect ownership

| Side effect | Owner |
|---|---|
| Read `vllm-copilot.models`, match, merge, `config.update(...)` | **store** |
| `normalizeModelEntry` clear semantics | **store** |
| Clone configured arrays/entries before modification | **store** |
| `ensureByokUtilityDefault` | **add/onboarding caller**, awaited after a successful model write; activation keeps its idempotent fallback |
| `provider.clearCache()` | **caller** (already the pattern in autoConfig's `onSaved` callbacks; webview keeps its `clearCache?.()` after the store call) |
| Toast "Settings saved…" | **caller** (webview handler, after store returns) |
| `refreshWebview()` | **caller** (webview handler) |
| Add-flow confirm dialogs / "Model added" toasts | **caller** (unchanged) |

The store must not know about `chat.byokUtilityModelDefault`. Moving that write to the add/onboarding caller preserves first-model setup without coupling two unrelated settings domains. Add a call-order test proving BYOK setup starts only after the model write resolves.

| Flow | Persistence operation | Effects after successful write |
|---|---|---|
| Add model — discovered/preset path | `replaceModelConfig` | await `ensureByokUtilityDefault`, clear provider cache, show “Model added” |
| Add model — “Keep Anyway” stub | `replaceModelConfig` | await `ensureByokUtilityDefault`, clear provider cache, log/show stub saved |
| Auto-configure existing model | `replaceModelConfig` | clear provider cache, show updated; no BYOK write needed |
| Set Model Personality | `replaceModelConfig` | clear provider cache, show applied/cleared; no BYOK write needed |
| Server Settings save | `patchModelConfig` | log, clear provider cache, refresh webview, show saved; no BYOK write needed |

---

## 4. Test-first sequence

### 4.0 Coverage policy and broken baseline

**Step 0 resolved (2026-08-09).** The gate was red before the refactor — 43.75% statements, 41.64% branches, 41.58% functions, 43.73% lines vs the configured 50/43/50/50 — with a stale threshold comment in `vitest.config.ts`. It was repaired by **reclassifying genuinely VS Code/subprocess-bound orchestration surfaces** out of measurement (`diagnostics.ts`, `dashboard.ts`, `deepDiveView.ts`) and the `autoConfig.ts` command facade, each with written justification beside the exclusion. The reclassified baseline is **statements 70.82%, branches 66.28%, functions 65.66%, lines 71.64%**; thresholds are set at 60/60/50/60 (~10pp headroom) and **enforced via `npm run build`** so the gate cannot rot silently again. These green percentages are the extraction baseline.

Coverage inclusion is ownership-based, not path-preservation-based:

- `coverage.include: ['src/**/*.ts']` includes newly extracted subfolder files.
- Existing excludes are exact paths; excluding `src/provider.ts` does not exclude `src/provider/*.ts`.
- Do **not** mechanically add every extracted provider/command module to `coverage.exclude`. Extracted logic with direct unit tests is deliberately admitted to coverage.
- In the same commit that creates an extracted module, run `npm run test:coverage`. Add focused tests until the module and aggregate gate are healthy.
- Exclude a new module only when it remains a genuinely VS Code/Extension Host-bound surface, document the reason beside the exclusion, and review the aggregate thresholds in the same commit. A folder-wide exclusion is not allowed merely because the code originated in an excluded facade.
- Keep thin root facades excluded only while they remain integration surfaces; extracted pure/orchestration units are measured.
- **Tracked (step 4): `src/autoConfig.ts` is excluded wholesale though it is NOT yet a thin facade** — 17 exports / ~1070 lines of presets, header parsing, BYOK, and Add-flow logic. The exclusion hides testable logic (e.g. `stripJsonComments`/`parseHeadersInput`/`mergePresetWithUserConfig`/`findPresetForModel`, which already have direct tests in `test/autoConfig.test.ts` that are not counted), so the baseline looks healthier than the ownership boundaries justify. The `vitest.config.ts` comment overstates its "facade" status. Corrected naturally during step 4: extract each responsibility into a measured module, then reclassify only the true command-registration facade. Do NOT exclude extracted modules (see bullets above).

### 4.1 Coverage gap analysis (what's pinned vs not)

**Already pinned:**
- `test/configStore.test.ts` (253) — replace-mode `systemMessageReplacementsFile` semantics: preserve-on-undefined, clear-on-`''`, replace-on-value, new-entry no-mutation, legacy id fallback (update-not-duplicate), multi-preset keyed by id, distinct-id-creates-new-entry.
- `test/serverSettingsView.test.ts` (420) — patch-mode update preserves existing `maxOutputTokens`/`modelModes`, create-new-with-composite-id, same-model-two-servers distinct ids, clear semantics, plus the showInformationMessage toast assertion.
- `test/autoConfig.test.ts` (301) — presets/parse/headers/merge (pins `commands/presets.ts` + `serverAuth.ts`).
- `test/testAndRefresh.test.ts` (106) — `serverFingerprint`/`groupModelsByServer` (pins the `testAndRefresh.ts` helpers).
- `test/providerAutoContinue/Capture/SystemMessages` (606) — pin the provider's request-handling behavior via `as any` stubs; these are rewritten to target the extracted free functions in §2.1 Phase B, so they act as the behavior tripwire during the move.

**Green characterization tests required BEFORE structural changes:**
1. **Replace-mode header preservation/replacement** — omitted `requestHeaders` preserves the previous object; supplied headers replace it rather than merge it. `serverUrl` is required identity, not an omitted-field preservation case. → extend `test/configStore.test.ts`.
2. **Replace-mode drops stale model-specific fields** — new config without `modelModes`/`family` removes the existing entry's `modelModes`/`family` (this is what distinguishes `replace` from `patch`; if lost, the preset path silently turns into a merge). → extend `test/configStore.test.ts`.
3. **Patch-mode broader preservation** — the existing test covers modes and output tokens; extend it to headers, family, defaults, and transport settings. (Reverse of #2.) → extend `test/serverSettingsView.test.ts`.
4. **New-entry replace does not build composite ids** — replace-mode new entry uses the id as passed (the composite is caller's job). → extend `test/configStore.test.ts`.
5. **Patch new-entry wire-id precedence** — when config identity and `vllmModelId` differ, derive the composite id from `vllmModelId`. → extend `test/serverSettingsView.test.ts`.

**Red-to-green changes with explicit implementation steps:**

1. **Server-less personality apply** — ✅ **done (step 0a):** `personalityApplicableTo` guard + `test/personalityCommand.test.ts`.
2. **Patch-mode explicit-`undefined` hardening** — `{ displayName: undefined }` must not wipe the stored value. JSON never sends undefined, so add this against `configStore`, not as current-behavior characterization. ✅ **done (step 3c):** `stripUndefined` in `patchModelConfig`; red-then-green test in `test/configStore.test.ts`.
3. **Side-effect boundary** — the store must not call `showInformationMessage`/`refreshWebview`/`clearCache`; a separate handler test proves those effects still occur after persistence succeeds. ✅ **done (3b/3c):** store-level pin (no toast) in `test/configStore.test.ts`; handler success + failure-path tests in `test/serverSettingsView.test.ts`.
4. **Input immutability** — freeze/snapshot the configured array, entries, and update object. Current implementations mutate the configured array, so add this against `configStore` during extraction. ✅ **done (3c):** array/entry snapshot test in `test/configStore.test.ts` (both ops clone via `slice`/`concat`).
5. **Identity validation** — blank server URLs or unresolved config ids fail without writing; patch updates cannot alter `id` or `serverUrl`. ✅ **done (3a/3b/3c):** blank-id/serverUrl guards tested; runtime backstop strips smuggled `id`/`serverUrl` from patch updates (`delete clean.id/serverUrl`).

### 4.2 Ordered sequence

| Step | Action | Gate |
|---|---|---|
| 0 | ✅ Record compile/test baseline; repair the already-failing coverage gate per §4.0 | compile, test, and coverage green; counts/percentages recorded (§4.0) |
| 0a | ✅ Fix server-less personality duplicate append (standalone commit) | `personalityApplicableTo` guard + regression test; compile + full suite green |
| 1 | ✅ Pin reachable replace behavior (characterization #1, #2, #4) against current `autoConfig.saveModelConfig` | green — 5 tests in `test/configStore.test.ts` (`6aae832`), 444 suite green |
| 2 | ✅ Extend reachable patch behavior (characterization #3, #5 and current side effects) against `serverSettingsView.saveModelConfig` | green — 4 tests in `test/serverSettingsView.test.ts` (`fc0f0c6`), 448 suite green |
| 3a | ✅ Create `configStore.ts`; migrate replace callers; move BYOK setup to both Add-model success paths and await it after persistence | focused store/save + Add/BYOK ordering tests; compile + full suite green — `configStore.ts` + `persistAddedModel` (`test/configStore.test.ts`, `test/persistAddedModel.test.ts`); 452 suite green |
| 3b | ✅ Migrate the webview to `patchModelConfig`; move toast/cache/refresh to the handler | focused store/view tests + full suite green — `patchModelConfig` + `ModelIdentity` in `configStore.ts`; webview `saveModelConfig` is now a thin handler (identity extraction + side effects); 8 direct store tests in `test/configStore.test.ts`; 460 suite green |
| 3c | ✅ Add store hardening tests (undefined stripping, side-effect boundary, immutability, identity validation) | each new test red before its implementation, then green; full suite green — `stripUndefined` + runtime identity backstop in `patchModelConfig`; 4 new tests in `test/configStore.test.ts` (2 red-then-green); 465 suite green |
| 4 | Extract presets, model discovery, auth, BYOK, add-server, and auto-configure flows one responsibility at a time; retain root facade | focused tests + compile + coverage after each extraction; full suite at phase end; **narrow the `src/autoConfig.ts` coverage exclusion to the true facade as logic moves out (see §4.0 tracked)** |
| 5 | Extract instance-owned system-message pipeline; migrate capture/replacement tests off private methods | focused pipeline/provider tests + compile + coverage |
| 6 | Extract request builder and stream consumer; remove corresponding private test access in the same commits | focused unit/provider tests + compile + coverage |
| 7 | Extract discovery, post-stream diagnostics, and orchestration last | all provider tests + compile + full suite + coverage; no provider private-member access in tests |
| 8 | Reassess `commands.ts`; optionally extract test-and-refresh/personality workflows only if still justified | relevant command tests + compile + full suite |
| 9 | Final: compile, tests, coverage, webview JS validation, prompt-drift canary, and package build | all green; prompt-drift failures are externally triaged per §8 |

Do not combine 3a and 3b: replace/patch is the highest-risk boundary and each migration must be independently reviewable. Step 3c contains intentional hardening and must not be described as a mechanical move. Later extraction steps remain behavior-preserving.

**Phase rule:** run the smallest affected Vitest files first, then compile, run the full suite, and run coverage before completing the phase. Review `vitest.config.ts` in every extraction commit: either the new module is measured with adequate tests, or a narrow documented exclusion is an explicit review decision. Do not start the next extraction while the current phase has temporary delegates, skipped tests, new diagnostics, a newly broad exclusion, or unexplained coverage loss.

---

## 5. Verified findings (bugs/smells found during planning)

Confirmed against source. Findings are explicitly classified as correctness bugs, maintainability defects, hardening, or enhancements; do not promote a smell into a bug without a failing user-visible behavior. The known-bugs False Positives (composite ids, unreachable-model removal, bundled-preset re-sync, global-writes, first-model-headers-per-server, `d.ontoggle`) were checked and **not** re-reported. Each finding was verified by reading the code (2026-08-09).

1. **Discovery re-fetches `/v1/models` once per model config, not per server** — `provider.ts:129-137` loops every override and calls `getModelContextWindow` → `vllmClient.ts:93-126` does a full `GET /v1/models` + JSON parse + `fileLogger` per call, each wrapped in `fetchWithRetry` (2 attempts, 1.5s retry sleep). N models on one server ⇒ N identical parallel fetches. `testAndRefresh` already groups by server (`commands.ts` `groupModelsByServer`); discovery doesn't reuse it. Confirmed over-engineering smell (known-bugs), not a correctness bug. **Leave for now.**
2. **`deriveTokenBudget` throw unreachable from the provider** — `provider.ts:131` guards `if (!maxModelLen)` before `buildModelInfo`; `modelInfo.ts:78` → `tokenBudget.ts:44-48` throws on missing `max_model_len`. Defensive-only contract (pinned by `tokenBudget.test.ts`). Confirmed (known-bugs). **Leave.**
3. **Divergent `saveModelConfig`** — `autoConfig.ts:535` (replace + explicit preservation + un-awaited `ensureByokUtilityDefault()` at `:578`) vs `serverSettingsView.ts:310` (patch + composite id + toast/`clearCache`/`refreshWebview`). Confirmed (known-bugs P?). **This is what §3 fixes.** *Resolved in steps 3a–3b: both operations now live in `configStore.ts` (`replaceModelConfig`/`patchModelConfig`); the webview delegates with identity extraction and owns side effects.*
4. **Floating promise: `ensureByokUtilityDefault()` not awaited** — `autoConfig.ts:578` inside `saveModelConfig`. Self-catching (never rejects), so not a crash — but model-save completion does not establish BYOK-write completion. **Move it to the add/onboarding caller and await it there; do not couple BYOK to the unified store.** (Noted in known-bugs.md.) *Resolved in step 3a — `persistAddedModel` awaits it after the write on both Add paths.*
5. **Stale "Python" comment** — `sessionManager.ts:~150` says "batch-query in a single Python process"; the implementation (`discoverWorkspaces` → `countSessionsBatch`) uses `node:sqlite` `DatabaseSync` (`sessionManager.ts:96-220`). Pure doc rot that would misdirect a maintainer. (Noted in known-bugs.md.)
6. **Dead defensive guard** — `commands.ts:646` `if (!clear && !sourcePath) { showWarningMessage('No personality presets found.'); }` is unreachable (every non-separator pick item is either `clear: true` or carries a `sourcePath`); it exists only for TS narrowing. Matches PR5 memory. **Not a bug — leave the guard, fix the misleading message.** (Noted in known-bugs.md.)
7. **Replace-mode transport-field footgun** — `autoConfig.ts:535-585`: `{...newConfig}` as the base means `autoContinueRetries`/`streamInactivityTimeout` are **dropped on replace** unless the caller re-attaches them. The auto-configure re-run path does re-attach them (`:1170-1173`); the personality path inherits via full spread; the Add path always creates new entries. No observed data loss today, but the contract must be documented in the unified store ("replace mode drops model fields not present in the entry").
8. **Patch-mode `undefined` spread hazard (theoretical)** — `serverSettingsView.ts:336` `{...existingEntry, ...updates}`: an explicit `serverUrl: undefined` in `updates` would overwrite the stored value. JSON messages never carry `undefined`, so the webview is safe today; the unified store should strip `undefined`-valued keys in patch mode (hardening, not a bug). *Resolved in step 3c — `stripUndefined` in `patchModelConfig`, plus a runtime backstop so `id`/`serverUrl` cannot be moved via updates.*
9. **`commands.ts:11` value-import of `VllmChatModelProvider` used only as a type** — should be `import type`. tsc elides it today (`verbatimModuleSyntax` off); cosmetic. (Noted in known-bugs.md.)
10. **`serverSettingsView.refreshWebview` refetches `/v1/models` on every config change and every save** — `serverSettingsView.ts:169-187`. Already filed in `docs/feature-ideas.md:203`. Not new, but re-confirmed; a server-model cache would fix it.
11. **Test-induced design damage in the provider tests** — `providerAutoContinue/Capture/SystemMessages` reach into private methods via `(provider as any).buildRequest`, `.processSystemMessages`, `.loadReplacements`, `.enqueueWrite`, `.client.chatCompletionStream`. This is what tempts a facade-method workaround; the correct end state is no `as any` and no private-method stubbing — tests target the extracted free functions with explicit collaborators. (Verified 2026-08-09.) Resolved by the §2.1 phased approach.
12. **Server-less personality apply appends a duplicate entry** — the command picker includes every configured model, while `saveModelConfig` cannot match without `serverUrl` and takes its append branch. This is a verified low-risk correctness bug, filed in `known-bugs.md` and fixed with a regression test in pre-refactor step 0a.
13. **Test suite is never type-checked as a gate** — the root `tsconfig.json` includes only `src/**`; `npm run compile` skips tests and vitest runs via esbuild (no type-check). Step 3a's linter errors exposed this: real contract mismatches (`ModelConfig` → `IdentifiedModelConfig`) and the mock-only `workspace._mockConfig` surface passed green because no gate checks tests. A real gate (`test:typecheck`) surfaces **~46 pre-existing test bugs** — proposed-API usage (`LanguageModelThinkingPart`), `LanguageModelChatMessageRole.System` vs real types, strict-null, mis-typed fixtures. Also: `tsc` (both `-p` and `-b`) does **not** honor `paths` for ambient module names like `vscode`, so an editor-only `test/tsconfig.json` (mapping `vscode` → the mock, added 2026-08-10 with the step-3a linter fix) quiets the editor but cannot be a CLI gate. Deferred — see §7 AFTER schedule.

---

## 6. Risks & sequencing

**Order of operations (why this order):**
1. **Server-less personality duplicate fixed (step 0a, committed); pin merge semantics next (steps 1–2).** The duplicate append was a verified caller bug, now guarded by `personalityApplicableTo`. The underlying replace/patch merge contracts are otherwise intentional and must be characterized before consolidation.
2. **Migrate replace, then patch, then harden (steps 3a–3c).** This is the smallest, highest-risk behavior boundary. Step 3a moves BYOK ownership in the same releasable commit as replace migration, preventing an intermediate first-model regression. Each caller migration is independently reviewable; input cloning and undefined stripping remain explicit hardening changes.
3. **Split autoConfig, then provider internals** (steps 4–7). Provider extraction starts with its instance-owned system-message pipeline, continues through request/stream units, and leaves orchestration until last.
4. **Create directories only as extracted files land.** Root facades and stable shared modules do not move, so unrelated importers remain untouched.

**What breaks first / rollback safety:**
- The **`saveModelConfig` unification** is the only step that can silently change behavior (a wrong merge on the patch/replace boundary). It's also the most rollback-safe: it's contained in one new file + 3 caller sites.
- **Provider test stubs (`as any`)** break when a stubbed method becomes a free function. For each boundary, add direct tests, wire the public path, and remove the corresponding private access in the same commit. Temporary delegates are not an acceptable release boundary.
- **Import-path churn** breaks `tsc` loudly — the compiler is the tripwire; every move commit must end green (`npm run compile` + `npm test`).
- **Coverage path churn is silent until coverage runs.** Exact-path excludes do not follow extracted code into subfolders. The baseline gate is already red, so Step 0 repairs it; every extraction commit then runs coverage and makes an explicit include/exclude decision per §4.0.
- **Git history/PR conflicts:** extraction still touches central files. Land one responsibility per commit near the start of a release cycle; do not squash unrelated extractions into an import-heavy change.
- **Don't touch** `deriveTokenBudget`, the discovery guard at `provider.ts:131`, `findModelConfigIndex`, or `normalizeModelEntry` — they're shared contracts; changing them is out of scope for this refactor.

---

## 7. Finding triage — before / during / after the refactor

There was one verified low-risk correctness bug, the server-less personality duplicate append; it is fixed in step 0a (`personalityApplicableTo` guard + regression test) and committed. After that gate, no known correctness issue blocks the refactor. The triage below is by *coupling to the refactor*, not by severity.

### Land BEFORE the refactor (independent, low-risk cleanup)

Trivial, isolated, zero-structural-dependency fixes. Land first on their own commits; they don't entangle with the restructure.

| Item | Location | Fix | Risk |
|---|---|---|---|
| Stale "Python" comments | `sessionManager.ts:112,134` | Reword to `node:sqlite` / `DatabaseSync` | None — doc rot |
| Dead guard, misleading message | `commands.ts:689` | Reword message or mark unreachable | None — dead code comment |
| Value-import used only as type | `commands.ts:11` | `import type { VllmChatModelProvider }` | None — cosmetic |

(Server-less personality duplicate append — **done**, step 0a: `personalityApplicableTo` guard + regression test in `test/personalityCommand.test.ts`.)

### Address DURING the refactor (coupled to restructured code)

These touch code the refactor rewrites anyway — fixing them standalone would be double churn. Fold them into the corresponding refactor step.

| Finding | Refactor step | Fix |
|---|---|---|
| Unify divergent `saveModelConfig` | §4.2 steps 3a–3b | Named `replaceModelConfig` / `patchModelConfig` operations — *done (3a replace, 3b patch)* |
| Floating promise `ensureByokUtilityDefault()` | §4.2 step 3a | Move to both Add-model success paths and await after model persistence — *done 3a* |
| Patch-mode `undefined` spread hazard | §4.2 step 3c | Strip `undefined` update keys (hardening) — *done 3c* |
| Replace-mode transport-field footgun | §4.2 step 3a | Document and test that replace drops fields absent from the full entry |
| Test-induced `as any` damage | §4.2 steps 5–7 | Direct tests per extracted unit; remove each private access in the same commit |
| Discovery per-model `/v1/models` refetch | Out of scope | Enhancement, not a bug; extraction must preserve current request behavior |

### Schedule AFTER the refactor (independent, additive work)

New tests and enhancements that benefit from the post-refactor structure; doing them before would fight the churn.

| Item | Type | Why after |
|---|---|---|
| Remaining P2 dashboard/deep-dive/formatting tests not needed for Step 0 | Test coverage | Continue additive coverage after the baseline gate is repaired; establish boundaries before separate metrics/view decomposition |
| P3: webview picker wiring tests | Test coverage | Needs a JS test harness; independent of TS refactor |
| Test type-check gate (`test:typecheck`) | Test infrastructure | Enabling it surfaces ~46 pre-existing test bugs (§5 #13) that span test files steps 5–7 rewrite (proposed APIs, strict-null, fixtures). Do it once those files are migrated; `test/tsconfig.json` is editor-only today and cannot gate (`tsc` ignores `paths` for ambient `vscode`) |
| Server-model cache for `refreshWebview` | Enhancement | feature-ideas.md; build on stable `serverSettingsView.ts` |
| `test:coverage` gate / `npm run build` | Verify | Final validation of the whole pass (§4.2 step 9) |

### What NOT to include

`deriveTokenBudget` throw, the discovery guard (`provider.ts:131`), `findModelConfigIndex`, `normalizeModelEntry` — shared contracts, out of scope (§9). The known-bugs False Positives list is the do-not-re-file roster.

## 8. Final acceptance checks

Automated checks:

```powershell
npm run compile
npm test
npm run test:coverage
npm run validate-webview-js
npm run check:prompt-drift
npm run build
```

`check:prompt-drift` is an external release canary, not evidence that a refactor changed runtime behavior: it fetches `microsoft/vscode` from GitHub and exits non-zero on network failure, upstream source/SHA drift, or dead replacement rules. A failure requires the documented fresh `systemMessageCapture` review; do not “fix” it by updating baseline SHAs without that review. Its verified pre-refactor baseline on 2026-08-09 is green (11 rules matched; 6 watched files unchanged).

The final test search must find no provider private-member access, including the `(provider as any).client` stub — it is private-member access too, not just the four method stubs. Review matches manually; comments describing removed code do not count as coverage.

```powershell
rg "provider as any|\.buildRequest\s*=|\.processSystemMessages\(|\.loadReplacements\(|\.enqueueWrite\(" test
```

Manual smoke checks before release:

1. Add a new server/model and verify its persisted identity and BYOK setup.
2. Reconfigure an existing model: preset-owned fields replace stale values while headers and personality survive.
3. Change one Server Settings field: unrelated modes, headers, token settings, and transport settings survive.
4. Apply and clear a personality; the next request uses the change without reload.
5. Attempt personality apply on a server-less config; verify it warns and does not append or materialize a personality.
6. Exercise normal, tool-calling, cancelled, empty-response, truncated, and auto-continue requests.
7. Enable system-message capture and issue concurrent requests; the result remains valid, deduplicated JSON.

## 9. Out of scope

- `deriveTokenBudget` contract (leave).
- Discovery per-server grouping optimization (leave — noted in known-bugs, revisit when discovery is touched).
- Server-model cache for `refreshWebview` (feature-ideas).
- Webview JS test harness (P3, separate concern).
- Moving `test/` into mirrored subfolders (keep flat, per §1.4).
