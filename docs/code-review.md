# Live Issues

**House rule (the only permanent thing in this file): this is a collection of LIVE issues.** A finding that gets fixed **leaves the document**. No "status after fix pass N" section, no "fixed by CR-n" annotations, no archive, no grade, no victory lap. Git history holds the record; the CHANGELOG holds the user-visible slice per its own policy. We do not collect fixed issues here, because nobody reads what was already done and the file would end up the size of War and Peace.

Two exceptions stay, because they are still live work:
- **Rejected findings** (bottom). A rejection is a standing decision, not a fixed bug: it stops a future review re-filing the same dead idea. Keep those.
- **Accepted product decisions and deferred architecture.** Same reasoning: standing rulings.

When you fix something, delete its entry in the same commit. If a fix was a partial amputation, rewrite the entry down to whatever is genuinely left, and drop stale line numbers while you are there (they rot within hours). Do not bump version without asking. Write prose as one line per paragraph or list item, no hard wraps, the editor does the wrapping.

---

## Triage

No open findings. Everything below this section is standing rulings (rejections and accepted decisions), not open work.

---

## Rejected during verification (do NOT re-file)

Standing decisions, not history. Re-verified by hostile re-read before landing here.

- **`.github/workflows/preset-index.yml` "contradicts" the gen-preset-index header.** The file does not exist; the reviewer read an open editor tab. Both phantom-file findings this project has produced were caught by touching actual bytes. `Test-Path` before believing any claim about file existence, including a subagent's.
- **`addServerFlow.ts` `@internal Exported for the auto-configure flow` on `confirmAndSaveAddedModel`.** `autoConfigureFlow.ts` genuinely imports it. Honest marker; a sweep-and-destroy on these comments would have broken a truth.
- **`sessionManager.ts` `vsCodeRoot()` fallback is dead.** Production-unreachable, confirmed, but self-labelled "Defensive fallback for direct module use before extension activation". Same class as the `serverAuth.ts` narrowing guards, kept deliberately.
- **Test comments citing round-1 tracker IDs (`CR-7`, `finding 1`).** Those point at history this file no longer carries. Citation rot is the accepted price of the live-issues-only rule; the asserted behaviors were spot-checked against current `src` and match.
- **`configSchemaTool.ts` GUIDE's vLLM param-mapping claims "may be outdated".** External vendor behavior, ungroundable from inside this repo, no evidence of drift.
- **`registryMigration.ts` "the ONLY place the legacy fields are named" is violated by `dashboard.ts`.** Those are same-named current-era entry-label fields, not the legacy per-model field. The ownership claim reads true.
- **Update Auth rotates credentials URL-wide, destroying sibling entries.** Ratified §5 doctrine, user-approved: the URL is the user's mental unit for credential rotation.
- **"Metrics tick has a garbled comment paragraph."** The quoted text does not exist in the file (grep-proven). Reviewer misread.
- **`serverSettingsView` message-handler dereferences `msg.type` inside its catch.** Only this extension's own webview script posts to that listener; no code path posts a non-object. Defense-in-depth nit.
- **Cross-window whole-array RMW can clobber a concurrent add.** Structurally real, VS Code offers no MVCC, every in-window path re-reads at write time. Documented architecture note, not ours to fix.
- **Session cleaner deletes keys from the live `vscdb` while VS Code holds it.** Documented, modal-warned, restart-instructed. Accepted risk.
- **`serverRegistryMigration.ts` "mixed-shape skip count locks out a user's hand-fixed serverUrl forever".** Traced end to end: fixing a model's `serverUrl` makes `planRegistryMigration` create a server entry for it in the SAME run, so `plan.servers.length` is no longer 0 and the whole "all skipped" branch (the one that can set the `done` marker) never executes for that run. The `repairable` scan only reads `done` when literally no model in the array carries a leftover `serverUrl` string, which is exactly the state where there is nothing left to migrate. No lockout exists.
- **`logger.ts` `close()` "awaits `ws.once('finish', ...)` after `ws.destroy()`, hangs shutdown forever".** Does not match the file: `close()` calls `stream.end(callback)` (not `destroy()`), with a 3s `setTimeout` safety net and an `'error'` listener racing the same resolve. Phantom-code finding — verify claims against actual bytes before filing, same lesson as the other phantom-file entries above.
- Batch disproven by tracing this session, keep out of future censuses: `outputLengthMigration.ts` apply-loop TOCTOU (the pre-check and `patchModelConfig`'s own re-check are both synchronous with no `await` between them - nothing can interleave in a single-threaded extension host); `outputLengthMigration.ts` declined-marker never re-offering after proposals change (working as designed - "Not now" means "don't ask again", not a bug); `configStore.ts` `patchModelConfig` append path losing `id`/`server` on no-match (reads `identity.id`/`identity.server` into the appended entry, verified); `personalityStore.ts` `syncBundledPersonalities` cache-invalidation race with in-flight requests (the write clears the cache synchronously in the same call, no batching/delay exists to race); `errorEnvelope.ts` `collectErrorMessages`'s unguarded `walk()` recursion on a circular object (all three call sites only ever feed it fresh `JSON.parse()` output, which cannot contain a cycle).
- Batch disproven by tracing, keep out of future censuses: `normalizeServerUrl` slash-trim eating `://` (guarded); dedupe rename colliding with a user-authored `foo-2` (counter checks the full taken set); migration writes rejecting against the models schema (VS Code's ConfigurationEditing does not value-validate on `config.update`); `fetchJsonRaw` ignoring `response.ok` (`fetchWithRetry` throws first); `deriveTokenBudget` emitting 0 input tokens (output clamp forces >= 1); numeric header values breaking fetch (dropped as non-strings); usage merge double-counting in normal two-window / negative-delta / corrupt-file paths (all clean); `eventsource-parser` `onError` being dead in v3 (it ships in the types); usage recorded after cancel being a bug (tokens were consumed server-side, correct by design); tool names unvalidated against OpenAI's charset; `vllmModelId` with a baked `:nitro` suffix; timezone-divergent `dayKey`; CRLF `/metrics` breaking parsing (Prometheus is LF by convention); plus the round-1 rejects (presetRemote cap-after-download, `scope:"cli"`, `validateMessages` stringify, "nudge mode" comment).

Backlog note (not a finding): `test/webviewContract.test.ts` honestly scopes itself to message TYPES; payload key names ride one drift-level below its tripwires. Extending it to a per-direction key census is a feature idea, and the test header does not claim more than it pins.

## Deferred architecture

- Group provider discovery metadata fetches per server instead of per model.
- Move the OpenRouter onboarding flow out of the oversized generic Add Server module (behavior-preserving).
- `requestBuilder` runs `resolveServerType` + `resolveServerConfig` (two resolver passes for one entry); mergeable into one resolved object. Waived as structural taste unless a third caller appears ("could be one helper" is not "should be one helper").
- Backend descriptor table, migration rails, typed error taxonomy: see the build triggers in `feature-ideas.md`. None of the triggers has fired.
- General UI or module rewrites around Model Settings / OpenRouter onboarding. Prefer targeted behavior fixes.
- Sanitized export for opt-in local logs. Raw local diagnostic logs are an accepted expert feature.

## Accepted product decisions

- **Raw headers in opt-in local logs/diagnostics** - intentional, user-controlled, stays on the user's machine.
- **`scope` in prompt-replacement files is dev-only metadata** - enforcement lives in `check:cli-rules`, not runtime.
- **Server registry** - entry id is the identity unit; models only reference an entry via `server`; no global/default server.
- **URL-wide fan-out for Update Auth and Rename pre-flight** (§5); entry-addressing stays for Replace Config and Remove Server.
- **Usage keyed by URL, not entry id.**
- **Cross-window `settings.json` writes are whole-array read-modify-write with no MVCC**; every in-window path re-reads at write time; the cross-process race is the platform ceiling.
- **The bundled model schema keeps `required: ["id", "server"]`.** Migration orphans are a warned, self-healing transient; blessing them in the schema would hand Copilot's `vllm-copilot_model_schema` tool a contract that tolerates broken entries. The editor squiggle is the feature.
- **Optional persistence failures stay Output-channel-only.** Chat continues safely; the data is optional.
- **Keys in plain-text settings.** Project decision, recorded so reviews stop filing it: plaintext beats secret storage for this use case. Never surface it as a finding.
- **`check:prompt-drift` red on upstream SHA drift is expected noise until re-pinned.** The canary watches `microsoft/vscode` prompt sources; when upstream moves, the script exits 1 by design until a human re-verifies the CLI rules against a fresh `systemMessageCapture` and runs `--update-baseline`. That re-pin is a deliberate human ritual (it needs a live Copilot CLI capture), not a bug and not CI's business; `check:cli-rules` is the mechanical half and stays green.

## Prioritization rule

**wrong behavior -> dishonest failure classification -> duplicate authority -> misleading API/tests -> measured performance cost -> structural cleanup.** Keep each change tied to one observable invariant. Do not refactor merely because a file is large; refactor when ownership can be stated more clearly afterward and protected by a focused behavioral test.
