# Known Bugs And Improvements

Only current outstanding work is tracked here. Fixed items → [CHANGELOG.md](./CHANGELOG.md). Feature ideas → [docs/feature-ideas.md](./docs/feature-ideas.md).
Do not bump version without asking.

---

## Recommended path

### Fix soon — after 1.32.1

1. **Respect per-model header identity in Model Settings.** Do not let the first configured model's credentials define probing and inactive status for every model sharing a URL. Group by URL + relevant header identity or report probe status per model.
2. **Remove obsolete OpenRouter plumbing.** Reduce parsed references to the fields production uses; remove unused `author`/stripped `slug` results and either remove ignored header parameters or deliberately support and test them. Rename tests so their claims match their assertions.
3. **Finish the request-construction extraction, then split `VllmClient`.** First establish the request builder as the single body-construction owner. Then separate runtime-limit resolution, server validation, and streaming. Splitting earlier would spread the current mixed responsibilities across more files without improving ownership.
4. **Consolidate OpenRouter normalization helpers.** Keep one per-token → per-1M conversion and one catalog-entry validator. Avoid adding a generic provider framework while only one backend needs these rules.
5. **Add behavioral coverage where TypeScript cannot help.** Add the Deep-Dive DOM harness and targeted tests for multiple header identities on one canonical URL.

### Ignore for now

- **Optional persistence failures being Output-only.** Chat continues safely and the data is optional. Add a visible degraded state only after evidence that users need it.
- **Sanitized export for opt-in local logs.** Raw local diagnostic logs are an accepted expert feature. Do not complicate normal logging unless an export workflow is added.
- **A backend registry or broad provider abstraction.** The current backend switches are still understandable. Revisit only when another backend creates repeated behavior, not in anticipation of one.
- **General UI or module rewrites around Model Settings/OpenRouter onboarding.** Fix the specific ownership problems above first. A rewrite now would increase release risk without improving user-visible correctness.
- **OpenRouter provider selection itself.** Correct the specification now, but leave implementation until the authoritative provider-list endpoint and strict-vs-preferred routing semantics are decided.

### Better-codebase rule

Prioritize in this order: **wrong behavior → dishonest failure classification → duplicate authority → misleading API/tests → measured performance cost → structural cleanup**. Keep each change tied to one observable invariant. Do not refactor merely because a file is large; refactor when ownership can be stated more clearly afterward and protected by a focused behavioral test.

---

## Outstanding findings

### P3 - optional persistence failures are Output-only
Usage and system-message capture continue after a failed write, with no one-time visible warning that the data won't survive restart. Keep chat non-failing; add a restrained failure state only if it has operational value.

### P3 - Model Settings server probes are first-model-header dependent
`ServerSettingsViewProvider.refreshWebview()` correctly groups equivalent URL spellings under one canonical server, but stores only the first model's `requestHeaders` for the shared `/v1/models` probe. Headers are per-model in this project. If two models share a URL but use different credentials/scopes, probe results, backend detection, and `(inactive)` labels depend on configuration order. Either probe per distinct header identity or represent probe status per model; do not imply one model's credentials describe every sibling.

### Non-blocking - old exact-endpoint plumbing remains
`parseOpenRouterModelRef()` still returns unused `author` and variant-stripped `slug` fields; `requestHeaders` are threaded through `fetchOpenRouterModel()`, `resolveOpenRouterRuntimeLimits()`, and `autoConfigureOpenRouterModel()` but are dropped by `fetchOpenRouterCatalog()`. A test named "passes per-model headers" only checks the URL and therefore passes while no headers are sent. Remove the dead fields/parameters or make the header behavior real and assert it. → see Fix soon #2.

## Deferred architecture

- Finish the request-construction move, then split `VllmClient` by resolver, validation, and streaming responsibilities.
- Group provider discovery metadata fetches per server instead of per model.
- Consolidate the duplicate OpenRouter per-token → per-1M pricing conversion.
- Move the OpenRouter onboarding flow out of the oversized generic Add Server module (behavior-preserving).
- Add a DOM harness for Deep-Dive webview behavior (Model Settings already has one).

## Accepted product decisions

- **Raw headers in opt-in local logs/diagnostics** — intentional, user-controlled, stays on the user's machine. Optional sanitized export/warning is backlog, not a blocker.
- **Per-model server identity** — each model carries its own `serverUrl`/`requestHeaders`; there is no global server.

## Grade

**88/100.** Remaining deductions are architectural concentration, a few low-impact lifecycle/diagnostic surfaces, and incomplete Deep-Dive behavioral coverage — not known core-path correctness defects.
