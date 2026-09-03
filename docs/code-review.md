# Known Bugs And Improvements

Only current outstanding work is tracked here. Fixed items → [CHANGELOG.md](../CHANGELOG.md). Feature ideas → [feature-ideas.md](./feature-ideas.md).
Do not bump version without asking.

**Full-project review 2026-09-03.** Six review passes over all of `src/` + `resources/*.js` (request path, stream pipeline, config/state/migrations, commands/flows, UI/webviews, backends/usage/persona). Every candidate was re-verified line-by-line against callers and callees before being listed here; unverifiable and by-design candidates were rejected and are not in this file. Baseline at review time: compile + test:typecheck clean, suite 824 pass / 3 skip.

**Fix passes 2026-09-03 (same day).** Pass 1: CR-1 through CR-6, CR-13. Pass 2: CR-7 through CR-11. Pass 3: CR-12, CR-14, CR-15, CR-17, CR-18, CR-21, CR-23, CR-24, CR-28, CR-32, CR-33, plus the popup half of CR-34 and the `KNOWN_SERVER_TYPES` enum dedup. All verified (suite back to green after each pass; final 825 pass / 3 skip, dep-cruiser gates clean). Fixed entries are removed from this file; remaining IDs are unchanged. No CHANGELOG entries: found and fixed inside one unreleased cycle.

---

## Recommended path

### Fix soon

Nothing with teeth remains. Passes 1-3 closed the High section, the whole activation/data-loss/staleness/resurrection class, and the wire-contract and log-math nits. What is left is the diagnostic tail below: honest-failure-labeling gaps (CR-16, CR-25, CR-31), diagnostics-only detection misses (CR-19, CR-20, CR-29), comment honesty (CR-22, CR-30), two webview robustness nits (CR-26, CR-27), and the remaining Output-channel em dashes (CR-34 partial). None of them corrupts data or kills the request path. Deferred items live in **Deferred architecture** below.

### Ignore for now

- **Optional persistence failures being Output-only.** Chat continues safely and the data is optional. Add a visible degraded state only after evidence that users need it.
- **Sanitized export for opt-in local logs.** Raw local diagnostic logs are an accepted expert feature. Do not complicate normal logging unless an export workflow is added.
- **A backend registry or broad provider abstraction.** The current backend switches are still understandable. Revisit only when another backend creates repeated behavior, not in anticipation of one.
- **General UI or module rewrites around Model Settings/OpenRouter onboarding.** Prefer targeted behavior fixes. A rewrite now would increase release risk without improving user-visible correctness.
- ~~**OpenRouter provider selection itself.**~~ Implemented (2026-08-20) once the authoritative provider-list endpoint (`GET /api/v1/models/{id}/endpoints`) and the `provider.only` semantics were verified live against the API. All provider slugs come from that endpoint verbatim — no derivation.

### Better-codebase rule

Prioritize in this order: **wrong behavior → dishonest failure classification → duplicate authority → misleading API/tests → measured performance cost → structural cleanup**. Keep each change tied to one observable invariant. Do not refactor merely because a file is large; refactor when ownership can be stated more clearly afterward and protected by a focused behavioral test.

---

## Verified findings (full-project review, 2026-09-03)

### Low

**CR-16 | "Server error (mid-stream)" label is used before anything streamed.** `src/provider/chatTransport.ts:84`: a proxy answering HTTP 200 with a complete JSON error body throws `Server error (mid-stream): ...`, and `formatError` (`src/provider/messageConverter.ts:487`) renders it with the same marker the genuine mid-stream case uses (`streamReader.ts:101`), whose copy in the `formatError` doc explicitly asserts "the request already streamed a 200 before the server aborted". Two different events share one diagnostic; the pre-stream case sends users hunting proxy timeouts instead of the request-shape problem. Fix: distinct marker for the pre-stream JSON case.

**CR-19 | Pure tool-call turns report TTFT as null.** `src/provider/consumeStream.ts:62-77` stamps `outcome.firstTokenTime` only in the reasoning and content branches; the tool-call branch never does. Agent-mode turns whose first streamed output is a tool call record `firstTokenTimeMs: null` and lose the dashboard's measured TTFT, despite the field being documented as "Time-to-first-token".

**CR-20 | Raw think tags split across chunk boundaries are never flagged.** `src/provider/consumeStream.ts:76` tests `RAW_THINK_TAG` per chunk; a `<thinking>` marker straddling two network chunks matches neither, so the missing-`--reasoning-parser` diagnostic silently no-ops. Diagnostics-only impact. Fix: test against a sliding tail window of the buffer.

**CR-22 | `buildRequestHeaders` docstring lies about "always wins" for differently-cased caller headers.** `src/shared/fetchRetry.ts:26-35` merges two passes with exact keys. An entry header `content-type: text/foo` plus caller `Content-Type: application/json` both survive into the record and `fetch` joins them (`text/foo, application/json`), same for a lowercase `authorization` on the entry. The repo already models header names as case-insensitive everywhere else (`sameHeaders`, `sanitizeRequestHeaders`): this merge is the odd one out. `chatTransport.ts`'s inline header spread has the same shape. Narrow blast radius today, honest-contract problem tomorrow.

**CR-25 | Dashboard seeds every server node as red "Offline" while loading.** `src/ui/dashboard.ts:490` passes `emptyMetrics('Loading…')` (which carries `online: false`) into `ServerTreeItem`, whose constructor renders red circle + description "Offline" + child row "Error: Loading…". A healthy server announces itself offline for up to a full connect timeout on every view show and settings change. The comment admits the repaint timing; the seeded state still lies. Fix: a loading sentinel with a neutral icon.

**CR-26 | Deep-Dive `render()` has no error handling.** `resources/deepDive.js:23` calls `render()` bare inside the message listener; any unexpected raw payload shape throws in the listener and the panel silently sits on "Fetching vLLM server data…" forever. Its sibling `serverSettings.js` wraps render in try/catch and paints the failure. Same job, asymmetric posture.

**CR-27 | Both webview `E()` escapers skip double quotes while being interpolated into attributes.** `resources/serverSettings.js:107` and the deepDive.js twin: `div.textContent → innerHTML` escapes `& < >` only, yet results are embedded in `value="..."` and `title="..."` for third-party strings (OpenRouter endpoint `tag`/`providerName`). Both webviews' CSP (`script-src ${cspSource}`, no unsafe-inline) kills any injected handler, so the exposure is attribute breaking and UI spoofing, not script execution. Fix: `E()` should also `.replace(/"/g, '&quot;')`.

**CR-29 | A legitimately empty OpenRouter endpoints list defeats all cache policy.** `src/backends/openRouter.ts:760-784`: success caches only non-empty lists; backoff is set only in the catch. A model returning 200 with an empty `data` array re-fetches on every 15 s metrics tick and every Model Settings refresh, indefinitely, each burning the 2 s abort budget. "Empty lists never cached" was the rule; it was never given an exit. Fix: throttle empty successes with the same retry-at stamp.

**CR-30 | Effort-ladder comment promises ordering the code never establishes.** `src/backends/openRouter.ts:400`: "Effort ladder from supported_efforts (descending, ...)": the code filters `'none'` and never sorts, and the API does not contract an order. The `defaultMode = Object.keys(modelModes)[0]` fallback is "highest effort" only if the API happens to emit descending. Fix: sort by an explicit rank ladder, or drop the parenthetical claim.

**CR-31 | BYOK bootstrap failure is misreported as a failed model save.** `persistAddedModelOrRollback` (`src/commands/addServerFlow.ts`) awaits `ensureByokUtilityDefault()` inside the same try as the model write. If it rejects (activation treats it as warn-worthy, so the path exists), the model IS saved, the entry is NOT rolled back (correctly kept: it is referenced), yet the toast claims the save failed and the entry was rolled back, and `onSaved` (the provider cache clear) never runs. Fix: move the BYOK bootstrap into its own catch that logs a warning.

**CR-34 (partial) | Em dashes remain in Output-channel log lines.** The user-facing popups (toasts, warnings, consolidated Test & Refresh reports) were scrubbed in fix pass 3, along with the write-path refusal messages. Remaining: Output-channel `[WARN]`/`[ERROR]`/`[INFO]` lines across `src/**` still carry em dashes. Policy: no em dashes in anything a user reads; the Output channel counts, but it is a large mechanical sweep best done as its own commit. `src/commands/testAndRefresh.ts` and `src/ui/diagnostics.ts` carry the densest clusters.

## Deferred architecture

- Group provider discovery metadata fetches per server instead of per model.
- Move the OpenRouter onboarding flow out of the oversized generic Add Server module (behavior-preserving).

## Accepted product decisions

- **Raw headers in opt-in local logs/diagnostics** — intentional, user-controlled, stays on the user's machine. Optional sanitized export/warning is backlog, not a blocker.
- **`scope` in prompt-replacement files is dev-only metadata** — `parseRules` strips it; enforcement lives in `check:cli-rules`, not runtime. Do not file this as an unenforced contract.
- **Server registry** — servers are entries in the global `vllm-copilot.servers` registry (`serverUrl`/`requestHeaders`/`serverType` live there); models only reference an entry via `server`. There is no global/default server: nothing resolves an entry without a model reference. The entry id is the identity unit everywhere (grouping, engines, panels); URL+headers equality is only consulted at write time (`entryMatchesConnection`).

## Grade

**90/100.** Fix passes 1-3 (2026-09-03) closed every High and Medium finding: the webview corruption pair, the user-decision wipe, the dead graceful-termination path, the sentinel credential misroute, the schema-violating `modelModes: ""`, the stale-snapshot duplicate-append, the wrong-capability assertion, the corrupt-file-disables-all-personas trap, the cross-window usage clobber (usage now persists to a profile-shared `usage.json` with delta-merge — `globalState` proved to be a per-window cache), the activation/validation coupling, the migration marker that could orphan legacy models, the silent protocol flip and dialog-window resurrection in the migrations, the personality staleness twin, the resolver divergence, the trust-me-no-clamp usage plane, and the lying comments. Remaining deductions: the diagnostic tail (CR-16, CR-19, CR-20, CR-22, CR-25, CR-26, CR-27, CR-29, CR-30, CR-31) and the surviving Output-channel em dashes (CR-34 partial). The core request/stream/wire path survived six hostile read-throughs with no wire-format or clamp-math defect: the moat holds.
