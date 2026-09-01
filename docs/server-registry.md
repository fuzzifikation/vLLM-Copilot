# Server Registry — Architecture

**Status:** ✅ **Implemented 2026-09-01** (Phase 1 `b496583`, Phase 1.5 `cf0caf3`, Phase 2 breaking
sweep `e3ccec4`, docs `f2a70c3`). The registry is the only place a server lives: inline
`serverUrl` is deleted, models reference a registry entry, and existing users' settings are
migrated on activation without being asked. Additive designs (inline kept forever, opt-in
migration) were considered and rejected — the reasoning is in §11 so nobody reopens it.
Open: manual smoke test of the migration in an Extension Development Host, release bump.

Verified against `cc8b3f7` (v1.35.3-rc0, suite green: 1195 passed / 3 skipped);
post-implementation suite green at `e3ccec4` (1243 passed / 3 skipped, `tsc` clean).

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

**What it does not buy:** rotating a shared credential *already* works — `Update Auth` and
`Rename Server` fan out URL-wide across every model on that URL
([commands.ts](../src/commands.ts)). The registry fixes ownership, not reach.

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

Header *names* are case-folded inside the fingerprint, and `sanitizeRequestHeaders` collapses
case-duplicate spellings to the last occurrence (RFC 7230 §3.2 — `authorization` and
`Authorization` are one header). Values keep their exact bytes. A hand-written lowercase entry
and the extension-written `Authorization` are therefore one identity, and a rotated key replaces
the old header instead of persisting a doubled auth header. `validateConfig` warns when two
registry entries describe the same connection — allowed, never auto-merged.

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
5. Write in this order: **`servers` first** (existing plus new), then `models` rewritten to
   `server` refs. `config.update()` has no multi-key transaction, so "atomic" is not on the
   table; this order means an interrupt leaves models pointing at entries that already exist
   rather than at nothing. No pre-migration snapshot — see step 7.
6. Set the marker **only if both writes succeeded**. If a write throws (invalid `settings.json`),
   leave the marker unset so the next activation retries — the same handling
   [outputLengthMigration.ts](../src/outputLengthMigration.ts) already uses. Post one info
   notification — *"Adopted N servers from your model settings (Show servers)"* — and log full
   before/after JSON to the output channel.
7. There is deliberately **no Undo command and no snapshot**: restoring the legacy shape would
   leave settings this version cannot use (models without `server` refs are unreachable), so a
   rollback path is a one-way trap dressed as an escape hatch — and a globalState snapshot would
   be a second plaintext copy of every credential serving a recovery story nobody can act on.
   Rollback means restoring `settings.json` by hand or staying on an older VSIX — stated in the
   CHANGELOG.
**Two rules the steps do not make obvious, now settled:**

- **The migration is a pure function of the `models` array plus the already-present `servers`
  registry: one entry per distinct `(fingerprint)` group present in the settings and not already
  in the registry, no others.** Reuse-by-fingerprint of a registry entry is what makes a retried
  migration (step 6) converge instead of appending a duplicate; the registry is read for dedupe
  only, never written speculatively. So an OpenRouter entry is created
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
| `src/configStore.ts` | **`ModelIdentity` becomes `{ id, server }`** and `assertValidIdentity` requires a non-blank `server`. Purity removes a hazard here: identity is always complete now, so the append-on-no-match path can no longer materialise a stray inline entry that outranks the registry — appending means what it says, "a new model on a known server". Replace-mode preserve list drops the two server fields, keeps `systemMessageReplacementsFile`. Gains a `writeServers()` mirroring `writeModels()` — the single `update('servers', ...)` in `src/`. |
| `src/commands.ts` | Update Auth, Rename Server, Remove Server and Remove Model write through `writeModels` and must carry `server` through untouched. `resetUsage` scope and usage lookups keep taking the resolved URL. |
| `src/dashboard.ts` | Grouping iterates **`servers[]` in array order** and attaches the models that resolve to each entry, so node order follows settings order and drag-reordering servers later stays a one-line change in `getChildren` — do not introduce an alphabetical sort. Nodes are keyed by **fingerprint, not entry**: when an entry's fingerprint equals one already emitted (two entries with the same URL *and* auth — allowed per §10), it does not emit a second node; its models join the existing node and the label stays with the first entry in array order. Engines and usage keys are fingerprint-keyed (§5), so entry-keyed nodes would double-render what the engine pool holds as one. An entry with no models is then just an empty group, which is why an empty-server node costs roughly 15 lines instead of a restructure. A model whose `server` ref does not resolve has no URL to group by, so it simply has no node; `validateConfig` at activation and the discovery pass on every refresh both name it by ref in the Output channel, so the sidebar stays quiet. Node label from `EffectiveServer.displayName`. |
| `src/serverSettingsView.ts` (+ `resources/serverSettings.js`) | Its `affectsConfiguration('vllm-copilot.models')` listener widens to also match `vllm-copilot.servers` — the only listener that needs it. The blanket `vllm-copilot` listeners in `extension.ts` and `dashboard.ts` already cover cache invalidation and tree refresh for the new key. Server card edits **display name and type** only; auth stays in the native `promptForServerAuth` flow, so no credential value ever enters webview state. |
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
- **Add Model / Replace Config** — two write-timing rules keep the registry honest. Replacing a
  model's config with new credentials rotates the entered auth *into* the entry the model already
  references (Update Auth doctrine) instead of deriving a fresh entry from the new headers — a new
  entry would change the `server` ref, make the replace match nothing and append a duplicate
  model. An entry *created* by the add flow is rolled back when the confirm is **dismissed**: no
  entry holding credentials the user walked away from may survive. "Copy JSON" keeps it — the
  copied `server` ref points at that entry, and a zero-model entry is a legal state ("Add
  Server" makes one on purpose), removable with Remove Server. Entries the flow only reused are
  never touched. Credential rotation for a replaced model happens on the existing entry *before*
  the confirm (the preview needs a resolved server) and is logged, so a dismissed confirm leaves
  a rotated, not a silent, entry behind.
- **New server** — `vllm-copilot.addServer`: URL → auth → entry saved with zero models; the
  success toast offers "Add a Model". No confirm/rollback dance — the entry *is* the deliverable,
  so it persists unconditionally. The existing `addServerModel` flow stays as-is (URL → probe →
  pick model → save) and rolls back entries whose model was never saved.

---

## 9. UX flow

1. **Add Server** (`vllm-copilot.addServer`): URL → auth → saved to `servers[]`, zero models
   allowed; the toast offers "Add a Model" right after.
2. **Add or Reconfigure Server/Model** (`addServerModel`): URL → probe → pick model → save.
   Re-entering an existing server's URL + auth reuses its entry (fingerprint dedupe) instead of
   duplicating it.
3. Dashboard and Model Settings show every registry server, including empty ones.
4. Editing server name/type/auth happens on the server. Per-model server overrides do not exist.

---

## 10. Risks


| Risk | Mitigation |
|---|---|
| **Silent settings rewrite on activation** — the genuinely dangerous part of this plan | One-shot marker; never on config change; before/after JSON in the output channel; a visible notification naming what happened. |
| Migration splits or duplicates what the user thinks of as "one server" | It never merges across fingerprints and never rewrites a URL, so the worst case is one extra entry to rename or delete. |
| Downgrade: an older VSIX reads migrated settings and finds models with no `serverUrl` | Accepted breaking change; stated in the CHANGELOG and in the post-migration notification. |
| Something still reads a URL without resolving it | Deleted field, therefore compile error. That *is* the mitigation — no manual audit list exists at all. |
| Replace Config: the target entry is deleted (another window, manual edit) between the confirm and the credential rotation | The rotation finds nothing, so a fresh entry is created and the model is appended instead of replaced — a duplicate, visible in settings, fixable by deleting one entry. Closing it needs a compare-and-set on `config.update()`, which VS Code does not offer; not worth a lock for a self-inflicted double-edit. |
| LM tool / GUIDE / presets emit the old shape | Same-commit update plus the schema test; the tool's `modelDescription` is in §7. |
| Server-scoped commands silently narrow their target set | §5: fan-out stays URL-wide; dialogs enumerate targets. |
| Two entries with identical URL and auth | Allowed, warned about in validation, never auto-merged. Same fingerprint means one engine, one usage key and **one dashboard node carrying both entries' models** (§7) — they are one server wearing two name tags, and renaming one tag does not rename the box. |

---

## 11. Rejected alternatives

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
