# Known Bugs And Improvements

Only current outstanding work is tracked here. Fixed items → [CHANGELOG.md](../CHANGELOG.md). Feature ideas → [feature-ideas.md](./feature-ideas.md).
Do not bump version without asking.

---

## Recommended path

### Fix soon — after 1.32.1

1. **Finish the request-construction extraction, then split `VllmClient`.** First establish the request builder as the single body-construction owner. Then separate runtime-limit resolution, server validation, and streaming. Splitting earlier would spread the current mixed responsibilities across more files without improving ownership.
2. **Consolidate OpenRouter normalization helpers.** Keep one per-token → per-1M conversion and one catalog-entry validator. Avoid adding a generic provider framework while only one backend needs these rules.
3. **Add behavioral coverage where TypeScript cannot help.** Add the Deep-Dive DOM harness.

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
