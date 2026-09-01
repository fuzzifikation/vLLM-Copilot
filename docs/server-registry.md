# Server Registry — Architecture & Implementation Plan

**Status:** Decided, not implemented. The registry is the only place a server lives: inline
`serverUrl` is deleted, models reference a registry entry, and existing users' settings are
migrated on activation without being asked. Additive designs (inline kept forever, opt-in
migration) were considered and rejected — the reasoning is in §13 so nobody reopens it.

Verified against `cc8b3f7` (v1.35.3-rc0, suite green: 1195 passed / 3 skipped).

**Created:** 2026-08-24 · **Revised:** 2026-09-01
**Idea origin:** [feature-ideas.md](./feature-ideas.md) → "Named-Server Registry"

---

## 1. Why this exists

Every surface a human looks at already treats a server as a first-class entity: the dashboard
renders **server nodes**, `Rename Server` is a command, `Update Auth` is scoped to a server,
metrics engines are pooled per server, the deep-dive panel is per server. Only settings.json
still denies it — a server has no identity there, so its URL, credential, backend type and
label are copied into every model that touches it.

This is not a design choice the code stands behind; `ModelConfig.serverDisplayName` says so
itself ([config.ts](../src/config.ts), the `serverDisplayName` docstring):

> SERVER-level (not model-level), **stored per-model because the config has no global server
> object.**

The registry deletes that apologetic paragraph. Server facts move to a `servers[]` entry with
an id; models reference it.

**What it buys:** a server exists before any model does ("add a server, add models later");
one copy of a credential; config shape that matches the UI.

**What it does not buy — say this plainly to anyone who asks:** rotating a shared credential
*already* works, because `Update Auth` and `Rename Server` fan out URL-wide across every model
on that URL ([commands.ts](../src/commands.ts)). Anyone who expects this feature to fix
rotation will be disappointed; it fixes ownership, not reach.

---

## 2. Why pure instead of compatible (the actual argument)

An additive design — keep inline `serverUrl` working forever — costs about five lines of read
code. It is not the compatibility that is expensive. It is that **keeping the field on the type
keeps every read of it valid**, and a ref-only model has no `serverUrl`:

- `validateConfig` warns "has no serverUrl and cannot be reached" for a perfectly good model.
- `findModelConfigIndex` starts with `if (!m.serverUrl) return false` and yields `-1`, silently.
- `discovery.ts` skips `!override.serverUrl`; `dashboard.ts` skips it in the grouping loop;
  `commands/personality.ts` labels such models "no serverUrl"; `outputLengthMigration.ts` skips them, so
  a startup migration quietly stops applying.

There are **115 `.serverUrl` property accesses across 16 of the 50 files in `src/`** today
(verified with Select-String, 2026-09-01). In a compatible design, finding the ones that gate a
model out is a manual audit followed by tests for behaviour that changed *silently* — exactly
the class of bug this project has repeatedly been bitten by.

Delete the field and **the compiler finds them**: every read of `ModelConfig.serverUrl` becomes
a type error, including the ones that feed a same-named local or a store identity (the
`serverUrl: m.serverUrl` identities in `outputLengthMigration.ts` and `commands.ts`). "Phase
done" stops meaning "I hope I grepped well" and starts meaning `tsc` is clean.

Corollary — and the reason the pure version is *smaller* than any additive variant despite doing more:
with no inline form there is nothing to fall back to, so there is no precedence table, no
mixed-group logic, no partial-adoption state, no header-merge semantics, no
append-on-no-match hazard, and no "supported forever" documentation promise.

**Cost of purity, accepted up front:** it is a breaking config change and there is **no
shippable intermediate state** — deleting the field and shipping the migration are one commit.

---

## 3. Configuration shape

```jsonc
"vllm-copilot.servers": [
  {
    "id": "gw-shared",                        // REQUIRED, unique. The reference target.
    "displayName": "IT Server for GLM5.2",    // optional; Rename Server writes here
    "serverType": "vllm",                     // optional; missing = vllm (policy unchanged)
    "serverUrl": "https://gw.example-corp.com/team-a/inference/gw-shared", // REQUIRED
    "requestHeaders": { "X-API-Key": "..." }  // optional; the credential lives here
  }
],

"vllm-copilot.models": [
  {
    "id": "glm52-prod",
    "vllmModelId": "zai/glm-5.2",
    "server": "gw-shared",                    // REQUIRED
    // ...all model facts unchanged (modes, params, budgets, capabilities, cost)
  }
]
```

Deleted from `ModelConfig`: `serverUrl`, `requestHeaders`, `serverType`, `serverDisplayName`.
Added: `server: string` (required). `provider` and `routingMode` **stay on the model** — they
pin OpenRouter routing for *one* model, which is a model fact, not a server fact.

OpenRouter therefore lives in the registry like any backend (one entry: the fixed
`openrouter.ai` endpoint, `serverType: "openrouter"`, the user key in `requestHeaders`). This is
a **simplification forced by purity**: with no inline form there is no OpenRouter special case
either — `addServerFlow.ts` upserts an entry like
anyone else. The existing "never rename `openrouter.ai`" policy moves from a model check to an
entry check.

Server ids are user-facing (shown in pickers) and generated ids use **host + path tail**
(`gw-example-corp-com-gw-shared`), de-duplicated `-2`, `-3`. Host alone collides for
two tenants on one reverse-proxied gateway, and pure counter de-dup would make ids depend on
iteration order — unstable across machines, which breaks the "stable id" promise.

---

## 4. Resolution — a lookup, not a merge

```ts
interface EffectiveServer {
  serverUrl: string;                      // normalized
  requestHeaders: Record<string, string>; // sanitized
  serverType: ServerType;                 // entry value, 'vllm' when omitted
  displayName?: string;
}

resolveServer(model: ModelConfig, servers: ServerEntry[]): EffectiveServer | undefined
```

Two cases, because there is only one way to name a server: **ref found** → the entry *is* the
server; **ref unknown** → `undefined`, the model is unreachable and `validateConfig` says so by
id. No fallback to any stale URL, no merge, no per-key ownership question. One sanitization path
(today's `sanitizeRequestHeaders`, exported from `config.ts` rather than re-implemented).

`resolveServerConfig` keeps its name and its call sites; it gains a required `servers` argument
and returns `EffectiveServer`. **It must own all four fields**: today `serverType` comes from
`resolveServerType(model)` (`requestBuilder.ts` x3, `discovery.ts`, `testAndRefresh.ts`,
`extension.ts`) and the label from raw `model.serverDisplayName` (`dashboard.ts`,
`serverSettingsView.ts`, `commands.ts`, `extension.ts`). Those fields no longer exist, so the
compiler enforces the point.

A model can override nothing. Needs different auth, or a different backend on the same host?
Point it at a different registry entry.

---

## 5. Identity stays the fingerprint

Grouping, engine pooling, credential isolation, usage keys and `buildModelId` composite ids
continue to derive from `serverFingerprint(normalizedUrl, effectiveHeaders)` — **never** from the
registry id. The registry id is a write target, not an identity.

Why this is not negotiable: two entries at the same URL with different credentials must stay two
engines and two dashboard nodes (that is the credential-isolation guarantee this project
documents), and usage history is keyed by that same pair — id-based keys would rewrite or orphan
every user's usage history for no benefit. `buildModelId(url, wireId)` keeps receiving the
*resolved* URL, so existing composite ids and `getServerUsage`/`getModelStartedAt` lookups
survive migration untouched.

Fingerprint header sorting stays plain comparison operators, never `localeCompare`: the
fingerprint is identity-bearing and must be locale-invariant (`config.ts`).

**Server-scoped commands keep their current scope.** `Rename Server` matches the *normalized URL*
(the label names the box, not one credential's view of it) and `Update Auth` merges into every
model on that URL. Deriving targets from the credential group instead would silently narrow both
— a visible regression. With the registry they gain entries as write targets: rename writes
`displayName` on every entry whose URL matches (`serverDisplayName` is gone, so nothing fans out
to the models any more). Confirmation dialogs keep listing concrete targets.

---

## 6. Forced migration on activation

Runs **once per install**, silently: no offer, no preview. The precedent to follow exactly —
including the globalState marker idiom and the plan-then-dumb-apply structure — is
[outputLengthMigration.ts](../src/outputLengthMigration.ts); marker
`vllmCopilot.serverRegistryMigration.v1`.

1. If `models` is missing or empty → set the marker, write nothing.
2. Otherwise group every model by `serverFingerprint(normalizeServerUrl(m.serverUrl),
   m.requestHeaders)` — same URL, different auth means separate entries, which carries today's
   semantics over unchanged.
3. One `ServerEntry` per group: generated id (§3), `displayName` = first non-empty member
   `serverDisplayName`, `serverType` = the group's type, `requestHeaders` = the group's headers.
4. A model with no usable `serverUrl` (already unreachable today) gets no entry and is named in
   the output log. The migration never invents a URL.
5. Snapshot the current `models` **and** `servers` arrays to globalState, then write in this
   order: **`servers` first** (existing plus new), then `models` rewritten to `server` refs.
   `config.update()` has no multi-key transaction, so "atomic" is not on the table; this order
   means an interrupt leaves models pointing at entries that already exist rather than at
   nothing. **Snapshot contents, said out loud:** it contains `requestHeaders`, so between the
   migration and the snapshot's eventual replacement the machine holds a second plaintext copy
   of every credential (VS Code's globalState storage) next to the one in `settings.json`. Same
   machine, same threat model, and plaintext-in-settings is an accepted project decision — this
   just extends it, deliberately, for as long as Undo stays offered.
6. Set the marker **only if both writes succeeded**. If a write throws (invalid `settings.json`),
   leave the marker unset so the next activation retries — the same handling
   [outputLengthMigration.ts](../src/outputLengthMigration.ts) already uses. Post one info
   notification — *"Adopted N servers from your model settings (Show / Undo)"* — and log full
   before/after JSON to the output channel.
7. `Undo Server Registry Migration` (palette) restores the snapshot and marks the migration
   reverted so it does not immediately re-run. The snapshot *is* the rollback story: users'
   settings.json is usually not under version control, so "restore via git" is not one.

**Two rules the steps do not make obvious, now settled:**

- **The migration is a pure function of the `models` array: one entry per distinct
  `(fingerprint)` group present in the settings, no others.** So an OpenRouter entry is created
  only if some model actually points at the OpenRouter endpoint — a user who never used it does not
  get an unknown server with an empty key. This also means no speculative "default local server"
  entry, and no second code path for any provider (§3).
- **Byte-for-byte preservation of `settings.json` is not the goal and was never available.** Every
  model-array write goes through the single `writeModels()` in `configStore.ts`, and
  every one hands it the whole array, so formatting inside these keys is already whatever VS Code
  re-serialises it to; `Update Auth` changes one header and rewrites the array today. The bar is
  therefore *semantic* equality — same resolved servers, same models, nothing added or reordered
  that the change does not require. Never touch `settings.json` through `fs` to "preserve
  formatting": that would fight VS Code's own writer for a benefit the user cannot see.

**Ordering constraint:** this must run *before* `outputLengthMigration` in `activate()`, because
that one identifies models by `{ id, serverUrl }` and patches through `patchModelConfig`. Its
identity becomes `{ id, server }` (§8); if the registry migration ran second, its proposals
would be built from a `serverUrl` that is no longer there.

Never run this from `onDidChangeConfiguration`. Credentials live in plain text in settings.json
(a deliberate project decision); rewriting that file while the user is typing in it is how you
destroy them.

---

## 7. Impact — the compiler is the checklist

Deliberately no file-by-file inventory of `serverUrl` reads: hand-maintained lists go stale within
a week, and `tsc` enumerates them better.
What follows are only the decisions the compiler cannot make for you.

| Area | The non-obvious part |
|---|---|
| `src/serverRegistry.ts` **(new)** | `ServerEntry`, `indexServers()`, `resolveServer()`, id-slug generator, the pure `planRegistryMigration()`, `toPublicServerEntry()` (credential-stripped webview projection, mirrors `toPublicModelConfig(..., {strip:true})`). |
| `src/config.ts` | `VllmConfig.servers` + `getConfig()`; `resolveServerConfig(model, servers)` returning `EffectiveServer` or undefined; `sanitizeRequestHeaders` exported; `findModelConfigIndex`/`findModelConfig`/`resolveOverrideForModel` take `servers` and compare the **resolved** URL (callers that only know a URL — the usage and dashboard lookups — still need it); `validateConfig` gains unknown-id, duplicate-id and unresolvable-ref warnings and loses the "has no serverUrl" branch; `CLEARABLE_ON_EMPTY` drops `serverDisplayName` and `serverType`. |
| `src/configStore.ts` | **`ModelIdentity` becomes `{ id, server }`** and `assertValidIdentity` requires a non-blank `server`. Purity removes a hazard here: identity is always complete now, so the append-on-no-match path can no longer materialise a stray inline entry that outranks the registry — appending means what it says, "a new model on a known server". Replace-mode preserve list drops the two server fields, keeps `systemMessageReplacementsFile`. |
| `src/commands.ts` | Update Auth, Rename Server, Remove Server and Remove Model write through `writeModels` (see §15) and must carry `server` through untouched. `resetUsage` scope and usage lookups keep taking the resolved URL. |
| `src/dashboard.ts` | Grouping iterates **`servers[]` in array order** and attaches the models that resolve to each entry, so node order follows settings order and drag-reordering servers later stays a one-line change in `getChildren` — do not introduce an alphabetical sort. Nodes are keyed by **fingerprint, not entry**: when an entry's fingerprint equals one already emitted (two entries with the same URL *and* auth — allowed per §12), it does not emit a second node; its models join the existing node and the label stays with the first entry in array order. Engines and usage keys are fingerprint-keyed (§5), so entry-keyed nodes would double-render what the engine pool holds as one. An entry with no models is then just an empty group, which is why an empty-server node costs roughly 15 lines instead of a restructure. A model whose `server` ref does not resolve has no URL to group by: report it as unreachable, named by its ref, rather than letting it vanish from the sidebar. Node label from `EffectiveServer.displayName`. |
| `src/serverSettingsView.ts` (+ `resources/serverSettings.js`) | Its `affectsConfiguration('vllm-copilot.models')` listener is the one listener that genuinely must widen to `servers` — the extension's blanket `vllm-copilot` listener already covers the provider and dashboard caches. Server card edits **display name and type** only; auth stays in the native `promptForServerAuth` flow, so no credential value ever enters webview state. |
| `src/commands/presets.ts` | `PresetConfig` already omits `serverUrl`, `requestHeaders`, `serverType`, `serverDisplayName`; it gains `server` in the same `Omit` list and `PRESET_CONFIG_KEYS` stays closed. Presets describe model facts and cannot name a server — a preset file carrying one is rejected by the existing allow-list, remote presets included. |
| `src/commands/addServerFlow.ts`, `src/commands/autoConfigureFlow.ts`, `src/presetRemote.ts` | These **create** servers today by writing `serverUrl` into model entries. They become: upsert the entry, then write models referencing it. The OpenRouter branch stops being special (§3). |
| `src/outputLengthMigration.ts` | Proposal identity `{ id, serverUrl }` becomes `{ id, server }`; runs after §6. |
| `schemas/vllm-copilot-models.schema.json`, `package.json` | Model items: delete the four server properties, add required `server` — so `"required": ["serverUrl","id"]` becomes `["id","server"]` — plus the new `vllm-copilot.servers` property and a `serverEntry` definition. `test/configSchemaTool.test.ts` asserts that `required` array and must be updated in the same commit. |
| `src/configSchemaTool.ts` GUIDE, the `vllm-copilot_model_schema` tool `modelDescription` | The LM writes configs on the user's behalf; if it is not taught the two-array shape it will keep emitting `serverUrl` and produce config the shipped schema rejects. |
| `src/usageStore.ts`, `src/vllmMetrics.ts`, `src/deepDiveView.ts`, `src/vllmClient.ts`, `src/provider/chatTransport.ts` | **No change** — they receive already-resolved `(url, headers)`. That is §5 doing its job. |

---

## 8. Write paths

- **Model Settings save** — `patchModelConfig` unchanged in contract; the server dropdown writes
  `model.server`, the server card writes the entry (name/type), auth through native prompts.
- **Update Auth** — writes the entry the model references; merge-never-replace preserved. There is
  no second layer to keep in sync and nothing to log about shadowing, because a model cannot
  carry headers.
- **Remove Server** — no longer deferrable: entries are real objects in a list the user edits.
  Minimal, non-destructive rule: **refuse while any model references the id**, name those models,
  point at Remove Model. No cascade, and no "detach to inline" because there is nothing to detach
  to. The question of what to do with a dangling ref does not arise: there is nothing to dangle to.
- **Remove Model** — unchanged apart from identity.
- **New server** — `Add Server` saves the entry even with zero models; the Model Settings server
  dropdown gains a "New server…" item that runs the same flow.

---

## 9. UX flow

1. **Add Server**: URL (plus key) → probe → optional display name → saved to `servers[]`, zero
   models allowed. A model pick is offered immediately, optional and cancellable.
2. **Add Models…** on a dashboard server node and on the server card: lists that server's
   `/v1/models` through the existing unconfigured-stub mechanism and configures one or many.
   Works on a server with zero models, which is the whole point of step 1.
3. Dashboard shows every registry server, including empty ones ("no models yet").
4. Editing server name/type/auth happens on the server. Per-model server overrides do not exist.

---

## 10. Testing

- **Migration** (the riskiest new code): golden tests for single model; N models on one server;
  same URL two credentials producing two entries; OpenRouter models; OpenRouter models **absent**
  (no OpenRouter entry is created); empty or absent `models` (marker set, nothing written); a model
  missing `serverUrl` (reported, not invented); marker idempotency; **a throwing `config.update()`
  leaves the marker unset and the settings untouched**; undo restores both arrays;
  servers-before-models write order asserted.
- **Resolver matrix**: ref found; unknown ref (unreachable plus warning); omitted `serverType`
  resolves to vllm; whitespace `displayName` falls back to the URL; duplicate ids warned.
- **Identity freeze**: the existing dashboard grouping, per-credential engine and usage-store
  tests must keep their **assertions byte-identical** — same fingerprints, same composite ids,
  same usage keys, same node order. That is the acceptance gate for §5; if an assertion needs
  editing, something broke. Fixtures are explicitly *not* frozen: 35 test files carry 332
  `serverUrl:` fixture literals (verified 2026-09-01), every one of which must change shape for
  `test:typecheck` to compile at all — editing a fixture's construction is required, editing what
  the test asserts is the violation. Sanctioned assertion edits: `configSchemaTool.test.ts`'s
  `required` assertion (§7) — nothing else.
- **No credential leak**: `toPublicServerEntry` strips values; assert no header value appears in
  webview state for an entry.
- **Preset denial**: a preset file carrying `server` is rejected; replace-mode keeps `server`.
- **Migration ordering**: registry migration then output-length migration inside one activate().
- `node --check resources/serverSettings.js` after any webview change.

---

## 11. Closed questions

1. **May the migration reformat `settings.json`?** It already does, unavoidably — see §6. Semantic
   equality is the bar; the golden tests in §10 and the snapshot/undo pair are how it is checked.
2. **Does an OpenRouter entry appear before the user adds an OpenRouter model?** No — the migration
   creates entries only from models that exist (§6).
3. **Where do zero-model servers appear in the dashboard?** As ordinary top-level server nodes,
   sorted after every node that has models. A separate collapsible "Servers without models" group
   would need a new node type for no gain and would hide the row the user needs: the node already
   carries *Update Auth / Rename / Remove / Add Models*, which is exactly how you fix the state.
4. **Is `Add Models from this server` also a palette command?** It already is —
   `vllm-copilot.addServerModel` ("Add or Reconfigure Server/Model") is contributed today and the
   dashboard node just invokes it. Nothing to build.

Everything an additive design would have had to answer (server-removal semantics, inline-vs-ref
precedence, how long `serverDisplayName` lives) is either answered by this design or deleted along with the inline form.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| **Silent settings rewrite on activation** — the genuinely dangerous part of this plan | One-shot marker; never on config change; snapshot written *before* the first write; `Undo` command; before/after JSON in the output channel; a visible notification naming what happened. |
| Migration splits or duplicates what the user thinks of as "one server" | It never merges across fingerprints and never rewrites a URL, so the worst case is one extra entry to rename or delete — and `Undo` covers the whole step. |
| Downgrade: an older VSIX reads migrated settings and finds models with no `serverUrl` | Accepted breaking change; stated in the CHANGELOG and in the post-migration notification. |
| Something still reads a URL without resolving it | Deleted field, therefore compile error. That *is* the mitigation — no manual audit list exists at all. |
| LM tool / GUIDE / presets emit the old shape | Same-commit update plus the schema test; the tool's `modelDescription` is in §7. |
| Server-scoped commands silently narrow their target set | §5: fan-out stays URL-wide; dialogs enumerate targets. |
| Two entries with identical URL and auth | Allowed, warned about in validation, never auto-merged. Same fingerprint means one engine, one usage key and **one dashboard node carrying both entries' models** (§7) — they are one server wearing two name tags, and renaming one tag does not rename the box. |

---

## 13. Rejected alternatives

Recorded so this file does not get re-litigated:

- **Keep inline `serverUrl` forever (additive registry).** It keeps all 115 `.serverUrl` reads
  type-valid, so every `!model.serverUrl` guard that silently excludes a ref'd model becomes a
  hunt-and-test exercise instead of a compile error — and it leaves two ways to name one thing,
  permanently.
- **Additive registry plus an opt-in migration command.** Rejected with it: that flow exists only
  to serve the hybrid, and a preview modal plus JSON diff plus clipboard backup was the heaviest
  UI in the old plan for what is a cleanup step.
- **Header merge / per-model overrides on a referenced model.** No inline form means no second
  layer; a model needing different auth points at a different entry.
- **No registry at all, just an "Add Models from an existing server" command.** The honest minimal
  alternative: about a day of work, fixes the roundabout flow, and permanently keeps the
  zero-model server gap, N copies of every credential, and a config that contradicts the UI.
  Chosen against because server-as-entity already exists in every other surface.

---

## 14. Documentation that must change in the same release

Live statements this design makes false. The next reader — human or AI — will otherwise "fix"
the code back to match them:

1. **`.github/copilot-instructions.md`** — "ALL servers are per-model", "The ONLY global setting
   is `enableFileLogging`", "There is NO global `serverUrl`". Amend to: the registry is an
   explicit lookup table that models reference; nothing may resolve a server without a model
   reference. The anti-pattern "discovery must not probe a global server" stays true.
2. **`src/config.ts`** — the `getConfig()` docstring ("only two genuine globals exist") and the
   `serverDisplayName` docstring quoted in §1, which is deleted along with its field.
3. **`docs/code-review.md` → "Accepted product decisions: Per-model server identity"** — rewrite:
   server identity is a registry entry; the fingerprint remains the unit of grouping.
4. **`docs/feature-ideas.md` → "Server identity becomes `id`, not a header-value fingerprint"** —
   wrong per §5; correct it so that idea's cost estimate is not reused.
5. **`configSchemaTool.ts` GUIDE, `package.json` tool `modelDescription`, README,
   configuration-reference.md** — all document `serverUrl` on the model as required.

---

## 15. Existing code this plan builds on

Facts about the current codebase that the design assumes. If one stops being true, the section
that depends on it needs revisiting.

- **Server identity has one formula.** `serverIdentity()` / `modelServerIdentity()` in
  `src/config.ts` return `{ serverUrl, requestHeaders, fingerprint }`, and
  `resolveServerConfig()` delegates to the same function, so the request path and every identity
  key are computed from the same sanitised pair. `vllmMetrics`' engine registry, dashboard
  grouping, the server settings projection, the deep-dive panel key and the auto-configure
  sibling check all go through it. Both header sets are **sanitized** on every key, so an
  irrelevant header (`Connection`) can neither orphan an engine's poller nor spawn a second engine
  on refresh.
- **Update Auth moves one identity at a time.** `updateMetricsEngineHeaders(url, previous, next)`
  re-keys the engine of *that* model's old identity — never every engine of the URL, because the
  header merge is per-model and siblings that already differ must stay different (different
  credentials, different Deep-Dive). Repeated transitions are no-ops; a transition onto an
  identity another engine already owns leaves that engine in place rather than displacing it.
- **One write path.** `readModels()` / `writeModels()` in `src/configStore.ts`; `writeModels` is
  the only `update('models', ...)` in `src/`. §6's write-order and "marker only after every write
  succeeded" rules live there, where they can be enforced in one place.
  (`config.ts` still reads the array itself: importing `configStore` there would be a cycle.)
- **`test/factories.ts`.** `makeModelConfig()` fills in the fields a model entry demands, so
  fixtures that do not care about the server stop naming one.

Not routed through `resolveServerConfig()`, deliberately: the direct `serverUrl` /
`requestHeaders` / `serverType` reads. A meaningful share of them must keep the *declared* value
(write-back fan-out, the settings editor), and they can only be classified reliably once
`ModelConfig` actually loses the fields — so that rewrite belongs to this change, not to a
separate commit that would have to be partly undone.
