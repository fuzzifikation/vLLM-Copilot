# Known Bugs And Improvements

Only current outstanding work is tracked here. Fixed items → [CHANGELOG.md](../CHANGELOG.md). Feature ideas → [feature-ideas.md](./feature-ideas.md).
Do not bump version without asking.

---

## Recommended path

### Fix soon — after 1.32.2

_None currently queued._ Deferred items live in **Deferred architecture** below.

### Ignore for now

- **Optional persistence failures being Output-only.** Chat continues safely and the data is optional. Add a visible degraded state only after evidence that users need it.
- **Sanitized export for opt-in local logs.** Raw local diagnostic logs are an accepted expert feature. Do not complicate normal logging unless an export workflow is added.
- **A backend registry or broad provider abstraction.** The current backend switches are still understandable. Revisit only when another backend creates repeated behavior, not in anticipation of one.
- **General UI or module rewrites around Model Settings/OpenRouter onboarding.** Prefer targeted behavior fixes. A rewrite now would increase release risk without improving user-visible correctness.
- ~~**OpenRouter provider selection itself.**~~ Implemented (2026-08-20) once the authoritative provider-list endpoint (`GET /api/v1/models/{id}/endpoints`) and the `provider.only` semantics were verified live against the API. All provider slugs come from that endpoint verbatim — no derivation.

### Better-codebase rule

Prioritize in this order: **wrong behavior → dishonest failure classification → duplicate authority → misleading API/tests → measured performance cost → structural cleanup**. Keep each change tied to one observable invariant. Do not refactor merely because a file is large; refactor when ownership can be stated more clearly afterward and protected by a focused behavioral test.

---

## Outstanding findings

### P3 - optional persistence failures are Output-only
Usage and system-message capture continue after a failed write, with no one-time visible warning that the data won't survive restart. Keep chat non-failing; add a restrained failure state only if it has operational value.

## Deferred architecture

- Group provider discovery metadata fetches per server instead of per model.
- Move the OpenRouter onboarding flow out of the oversized generic Add Server module (behavior-preserving).

## Accepted product decisions

- **Raw headers in opt-in local logs/diagnostics** — intentional, user-controlled, stays on the user's machine. Optional sanitized export/warning is backlog, not a blocker.
- **Per-model server identity** — each model carries its own `serverUrl`/`requestHeaders`; there is no global server.

## Grade

**90/100.** Remaining deductions are deferred discovery/onboarding structure and a few low-impact lifecycle/diagnostic surfaces — not known core-path correctness defects.
