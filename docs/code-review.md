# Known Bugs And Improvements

Only current outstanding work is tracked here. Fixed items → [CHANGELOG.md](./CHANGELOG.md). Feature ideas → [docs/feature-ideas.md](./docs/feature-ideas.md).
Do not bump version without asking.

---

## Outstanding findings

All P1/P2 findings from the 2026-08-19 full review are fixed (see the changelog). What remains:

### P3 - optional persistence failures are Output-only
Usage and system-message capture continue after a failed write, with no one-time visible warning that the data won't survive restart. Keep chat non-failing; add a restrained failure state only if it has operational value.

## Deferred architecture

- Finish the request-construction move, then split `VllmClient` by resolver, validation, and streaming responsibilities.
- Group provider discovery metadata fetches per server instead of per model.
- Consolidate the duplicate OpenRouter per-token → per-1M pricing conversion.
- Move the OpenRouter onboarding flow out of the oversized generic Add Server module (behavior-preserving).
- Add a DOM harness for Deep-Dive webview behavior (Server Settings already has one).

## Accepted product decisions

- **Raw headers in opt-in local logs/diagnostics** — intentional, user-controlled, stays on the user's machine. Optional sanitized export/warning is backlog, not a blocker.
- **Per-model server identity** — each model carries its own `serverUrl`/`requestHeaders`; there is no global server.

## Grade

**88/100.** Remaining deductions are architectural concentration, a few low-impact lifecycle/diagnostic surfaces, and incomplete Deep-Dive behavioral coverage — not known core-path correctness defects.
