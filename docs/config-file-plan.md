# Config File Plan: Moving Model and Server Config Out of settings.json

Status: DECIDED, pending the small confirmations in section 10. No code written yet.
Date: 2026-09-04. v2, rewritten after owner rulings and verification (BYOK behavior, remote/WSL behavior, comment-parsing spike, schema tool inspection).

## 0. Ruling ledger (owner decisions, 2026-09-04)

| # | Topic | Decision |
|---|---|---|
| 1 | Migration cleanup | Migration prompts the user after writing the file; default action (Enter) is **cleanup** (empty the settings arrays). "Keep as backup" is the alternative, plus a later cleanup command. See section 7. |
| 2 | Default pointer target | `~/.vllm-copilot/config.json`, resolved on the host the extension runs on. Windows: `C:\Users\<you>\.vllm-copilot\config.json`. See section 4. |
| 3 | Schema + LM tool | Reuse `configSchemaTool` plumbing; swap its schema, rewrite its guide, add a "where is my config" section. See section 6. |
| 4 | No URLs | The pointer is a local file path, full stop. No remote fetching, no fork semantics, no https rules. The target must be writable; a non-writable target is an error, not a degraded mode. See section 5. |
| 5 | WSL / remote boxes | Accepted: the path resolves per-host, which is exactly how the config already behaves today. Section 4 explains. BYOK is the reference for the file's *shape*, not its topology (see row 9). |
| 6 | Migration depth | Two arrays only. Diagnostics and dashboard settings stay in settings permanently. |
| 7 | File format | Strict JSON. Comments in the JSON sense do **not** work (measured, section 8); human annotations use `//` / `_comment` data keys instead. No `jsonc-parser` dependency. |
| 8 | Reload semantics | No FileSystemWatcher. Update-after-write internally, `Reload config file` command for the rest, manual edits normally followed by window reload per owner habit. See section 9. |
| 9 | Extension topology | **Workspace-first stays for now.** The BYOK-style ui topology (Ask E) failed historically on remote windows, but the failure was never diagnosed (localhost trap vs structural). Gated retest spike added as unit 0 of section 11, to run before migration code; until it reports, the per-host file of section 4 is the live design. |

## 1. The problem

`vllm-copilot.servers` and `vllm-copilot.models` are arrays in VS Code settings that the extension itself writes. Model entries run 40 to 80 lines once modes, params, and costs fill in, so settings.json becomes a database wearing a trenchcoat. Verified in code:

- `configStore.ts` is the sole writer, always whole-array. Human hand-edits racing extension writes lose silently, and comments inside the arrays are destroyed by today's writes anyway.
- Both settings are `scope: "machine"`, so they never sync. Portability today is manual settings.json surgery.
- Cross-entry integrity (every `model.server` must name a registry id) cannot be expressed in the settings schema. It is runtime code with warnings.
- Several hundred lines of package.json exist only to validate these arrays, and the LM tool plus `schemas/vllm-copilot-models.schema.json` both instruct humans and AIs to edit "in VS Code settings".

The repo already points at the exit (`systemMessageReplacementsFile` is a pointer-to-data setting), and so does VS Code itself. See BYOK, section 3.

## 2. The design

One config file holds both arrays. settings.json keeps a pointer plus four genuine editor preferences.

```json
{
  "$schema": "https://github.com/fuzzifikation/vLLM-Copilot/blob/main/schemas/vllm-copilot-config.schema.json",
  "version": 1,
  "//": "my notes survive here, this is a real key with real string values",
  "servers": [ { "id": "home", "serverUrl": "http://localhost:8000/v1" } ],
  "models": [ { "id": "qwen", "server": "home", "maxOutputTokens": 4096 } ]
}
```

- `configStore` becomes the sole reader AND writer. It is already the sole writer; the scattered `get('models')` read sites get inventoried and re-pointed first (task 11.1), because "sole reader" is the part that is not true today.
- The swap is invisible to roughly 90 percent of the codebase; backend selection happens once at activation.
- `$schema` autocompletion reuses the existing per-entry schema via `$ref` in a new envelope schema. The existing schema's `$id` is already a remote GitHub URL; schema URLs are documentation links, unrelated to ruling 4.
- The envelope carries `version: 1`. A file newer than the extension understands is refused, not garbled.

## 3. BYOK is the proof this pattern works

VS Code's own Bring Your Own Key feature is the precedent, verified against current docs today:

- BYOK custom models live in a dedicated **`chatLanguageModels.json`** file that VS Code opens for editing. The old settings route (`github.copilot.chat.customOAIModels`) is **deprecated** in favor of the file. Microsoft hit the exact same disease (giant config array in settings.json) and amputated into the exact same limb: a named, user-editable JSON file next to the profile.
- Its shape is nearly ours: an array of providers with nested `models`, `requestHeaders` for gateway auth, `modelOptions` (their `defaultParams`), `maxInputTokens`/`maxOutputTokens`.
- Its secrets trick is worth stealing slowly: `"apiKey": "${input:myApiKey}"` and `${apiKey}` inside header values, so the file references a secret stored elsewhere instead of containing it. Our analog would be `${env:VAR}` expansion at load time, which would make the config file genuinely dotfiles-safe. Deferred behind milestone 1 (section 10, ask D).
- Its annotation trick: sample files carry `"__comment"` keys because the parser is strict JSON. That is ruling 7's `//` key, already proven in a Microsoft-shipped format.

What we deliberately do NOT copy: BYOK is UI-side-only and always one local file. We run workspace-first (see section 4), so our file is per-host by design instead.

## 4. Where the file lives, including WSL and remote boxes

**Ruling: workspace-first is the live design. The BYOK-style ui topology (Ask E, one local file for every window) failed on remote windows in a historical build; because that failure was never diagnosed, a gated retest spike (section 11, unit 0) runs before migration code and may reopen the ruling. Until it reports, this section stands.**

The facts, verified against the manifest and VS Code's remote-extension architecture docs:

- The manifest declares `"extensionKind": ["workspace", "ui"]`, workspace first. In a WSL, SSH, or container window, **the extension runs on the remote host**, on purpose: that is what makes `http://localhost:8000/v1` mean "the GPU box I am connected to". This is load-bearing behavior, not an accident.
- Consequently, machine-scoped settings already resolve per-host today. Add a model inside a WSL window and that entry lands in the WSL-side settings, not your Windows settings. Per-host config is the existing, shipping status quo; the file backend does not introduce it, it just stops hiding it.
- `os.homedir()` and `globalStorageUri` likewise resolve on the running host. The default target therefore is:
  - Windows desktop: `C:\Users\<you>\.vllm-copilot\config.json`
  - WSL / Linux: `/home/<you>/.vllm-copilot/config.json`
  - macOS: `/Users/<you>/.vllm-copilot/config.json`
  - SSH host / container: that machine's home directory
- So: **is the settings file still reachable? Yes, always, because we only ever touch the filesystem of the host we run on. Is it one physical file everywhere? No, and that is correct.** One path *string*, resolved per host, matching where the vLLM servers live. The dashboard shows the resolved absolute path plus the host it resolved on, because a config you cannot locate is a config you will file a bug about.
- Cross-OS pointer behavior, spelled out because it is the question every multi-OS user asks:
  - An absolute Windows pointer (`C:\Users\me\.vllm-copilot\config.json`) is **dead on any Linux-family host**. In a WSL or SSH window the extension runs on that host, where `C:\...` is not a drive reference but an invalid relative filename. Result: a loud "path does not resolve on this host" diagnostic, never a silent fallback. Same for a `/home/...` pointer inside a Windows window.
  - No path-translation magic: `C:\` to `/mnt/c/` conversion would work only on WSL, lie on SSH, and is exactly the cleverness that generates issue forever. Rejected.
  - This is why `~/.vllm-copilot/config.json` is the default and the recommended value: it is the only pointer string that resolves on every OS, and since the pointer is application-scoped (synced), `~`-relative is the only synced value that never becomes someone else's machine's fiction. Raw absolute pointers remain allowed for power users who understand they are host-specific.
  - An application-scoped pointer is ONE value shared by every window, local and remote; the remote host receives the same string and resolves it locally. Per-host divergence therefore cannot live in the pointer, it lives in the filesystem (symlinks), which is exactly what makes `~` + one symlink the canonical multi-OS setup.
  - The only-copy-on-Windows scenario, spelled out because users will hit it: pointer set, physical file exists only on Windows, user opens a WSL or SSH window. The remote-side extension resolves the path on its own host, finds nothing, and says so loudly (dashboard shows the dead resolved path, zero models, provider alive). This is byte-for-byte today's behavior: machine-scoped arrays on Windows are already invisible to a WSL-side extension host. The file backend inherits the behavior, it does not add it, and the honest fix is the `/mnt/c` symlink recipe, not a magic cross-machine read, which is rejected on both capability (SSH cannot see C:) and security grounds.
  - Sharing one physical file across hosts is by user choice, documented as a cookbook, not enforced:
    - Windows + WSL, one file: create the symlink once, inside WSL: `ln -s /mnt/c/Users/<you>/.vllm-copilot ~/.vllm-copilot`. The `~` pointer then resolves to the same physical file on both sides. (Alternative: point only the WSL side at `/mnt/c/...` and keep separate pointers per scope, messier.)
    - Windows + SSH host: no transport exists and none should; the remote cannot and must not see the C: drive. Sync the dotfile yourself (git, syncthing, scp) or keep per-host configs, which matches per-host servers anyway.
- Rejected alternative: forcing `extensionKind: ["ui"]` to get one physical file. That kills the GPU-box-localhost case for every remote user. Not happening for cosmetics.
- Pointer scope: `application` (syncs via your profile). The pointer is a short path string, and `~`-relative strings are portable by design, which is precisely what a synced setting should be. Non-machine settings also reach remote extension hosts, so WSL/SSH windows see the pointer without manual setup. One spike gates this (task 11.0): confirm that updating an application-scope setting from a remote-host extension works as expected.

Path rules, in force as law:

- The pointer must be absolute or `~`-prefixed. Bare relative values are rejected with a diagnostic. The workspace never participates in resolution: a repo that can steer which config gets loaded, and therefore which servers receive your auth headers, is an exfiltration chain with a git checkout as the delivery mechanism.
- `~` expands via the running host's home. Environment expansion inside the pointer string itself: not supported, one less magic to document.

## 5. Writability and failure handling (URLs are gone, so this is small)

Ruling 4 deleted the entire remote failure zoo (fetch timeouts, fork semantics, offline caches, https policy, fetch-auth bootstrapping). What remains:

- Load time: file missing, unparsable, or version-too-new is a loud error (toast + dashboard entry), provider registers with zero models, activation never hangs. Reads from a readable-but-sad file continue where possible.
- The target must be writable. Checked at load: if the file (or its directory) refuses writes, the extension shows an error, keeps serving reads, and every write command fails with that same explicit message. No silent read-only mode, no pretending.
- Migration writes to the default path with mkdir -p semantics; if that fails, the migration aborts, the pointer stays unset, the settings backend keeps working, and the error says which path refused and why.
- Cheap safety net kept from v1: after each successful load, a copy goes to globalStorage. If the real file is deleted or mangled later, the error offers "restore last known copy" plus "reveal file". That covers the dotfile-porcelain moment, costs almost nothing, and is local-only.
- Atomic writes: temp file in the same directory, then rename. The file is always whole, never half. Two windows writing: last writer wins without corruption; staleness handled by section 9.

## 6. The LM tool (`vllm-copilot_model_schema`) reuse and changes

Inspected `src/shared/configSchemaTool.ts`. It is a clean fetch-the-schema tool: registration via `contributes.languageModelTools` + `vscode.lm.registerTool`, a `section` input (`all` | `schema` | `guide`), cancellation discipline, never-fail fallback to the guide alone.

| Part | Fate |
|---|---|
| Registration, section handling, cancellation, never-fail shape | Survives untouched. |
| `SCHEMA_PATH` (bundled per-entry schema) | Swapped to the new envelope schema. |
| The embedded GUIDE string | Full rewrite. Today it opens with "You are editing the `vllm-copilot.models` array in the user's VS Code `settings.json`" and its example is settings.json syntax. Post-flip it teaches the file format and tells the agent to edit the file. |
| New `section: 'where'` | Returns the active resolved config path (and settings-vs-file backend state). Cheap and load-bearing: the whole point is that the AI must know *where* to edit; a path the model can ask for beats guessing. |
| package.json `modelDescription` / `userDescription` | Rewritten in the same commit; both currently say "in VS Code settings". |

After the flip the tool gets *more* useful, not stale: file edits are Copilot's home turf, and the tool becomes the signpost.

## 7. Migration

Template: the existing pure-planner + wrapper split (`planRegistryMigration` + `serverRegistryMigration`), including set-flag-only-after-success. Marker: `vllmCopilot.configFileMigration.v1`.

Order and mechanics at activation:

1. `serverRegistryMigration` runs first, blocking, as it does today. Registries settle before anything moves.
2. `configFileMigration` runs next, blocking. Blocking is deliberate: every read from here on needs to know which backend answers, and a half-migrated state must never serve traffic. Failure is survivable: pointer unset means the old backend simply stays in charge.
3. If the pointer setting is empty AND at least one of the two arrays has content: build the envelope from the current arrays (pure planner), write it to the default path atomically, then set the pointer. That completes the backend flip; the arrays are now inert either way.
3b. Empty-host guard: pointer unset and both arrays empty (a fresh WSL or SSH host whose config lives on another machine) means there is nothing to migrate. The migration silently no-ops, the pointer stays unset, and no empty file is written. Without this guard an empty remote host would migrate nothing into a fresh file, flip the pointer, and strand itself on an empty backend. The config for such a host arrives by pointer edit, symlink, or dotfile, like any other host.
4. The cleanup prompt appears after activation completes, not as a modal during it: "Migrated N models and M servers to `<path>`. Remove the old entries from your settings?" with **Clean up** as the default (Enter) and **Keep as backup** beside it. One-shot: dismissal counts as "keep", no nagging, and the dashboard keeps a `Remove migrated settings from settings.json` command forever.
5. Cleanup = empty the two arrays (whole-value writes through the settings backend). Idempotent: arrays already empty, nothing to do.
6. If the pointer is already set when activation runs (second window, second day, or the user set it by hand), migration is a no-op beyond validation.

Per-host note: globalState flags are host-local too, so a WSL window migrates WSL's arrays into WSL's file with WSL's flag. Consistent everywhere, no cross-host coordination invented.

Rollback: delete the pointer setting and the arrays (if kept) or restore from the globalStorage copy / your dotfiles git. That is the whole story.

Doc debt riding in this same commit: the `markdownDescription`s that say "Stored in User settings only", the per-entry schema's "One entry of the `vllm-copilot.models` array in VS Code settings" description, the tool texts (section 6), `configuration-reference.md`, README, manual. These become lies on flip day, and a lying AI tool is a release blocker, not cleanup.

## 8. File format: strict JSON, measured, not believed

You said most parsers forgive comments, and asked to test. Tested (Node 24, the repo's installed deps):

| Input | `JSON.parse` | `jsonrepair` (existing dependency) |
|---|---|---|
| trailing `// note` | throws | strips it, valid JSON |
| `// note` between keys | throws | strips it |
| `/* note */` | throws | strips it |
| trailing commas | throws | removes them |
| `{"//": "note", ...}` | **parses, key kept** | kept |
| `{"_comment": "note", ...}` | **parses, key kept** | kept |

So: `JSON.parse` forgives nothing, ever. Comments are a JSONC-parser feature, and `jsonc-parser` is a new dependency we are not adding for a nicety (ruling 7 confirmed strict JSON anyway).

The humane middle, all zero-dependency:

- Real annotations live in `"//"` (and `_comment`) string keys. Legal JSON, schema-allowed at every level, round-trips through our own whole-file writes as plain data, and the config file itself demonstrates the convention in the migration-written initial file. BYOK's `"__comment"` proves the trick.
- Parse failure (user typed a real comment or a trailing comma): error names the path and position, with a **Repair file** button that runs the already-bundled `jsonrepair` and reloads. Explicit repair, never silent, because quietly rewriting a file full of server URLs and tokens is how trust dies.
- Unknown keys still rejected in the envelope and `servers` items, matching the registry's `additionalProperties: false`. `models` items stay as lenient as the runtime is today, on purpose: the migration copies entries verbatim, and inventing stricter-than-runtime validation in the new format would reject the extension's own migrated output. Lenient models, strict envelope, documented, orphan-entry keep-and-warn philosophy inherited.

## 9. Reload semantics (no watcher, per ruling 8)

- Every write goes through configStore, and configStore updates the in-process view (and fires the existing `VllmClient.invalidateConfigFileCaches()`-style invalidation) right after the atomic rename. Same-window correctness needs no watcher.
- `Reload config file` command re-reads and revalidates, for when the user edits by hand and cannot be bothered to reload the window.
- Hand-edits in another window, or outside the extension: applied on next window reload or the reload command. Documented as the known limitation, alongside the observation that the owner already reloads after manual edits anyway.
- If cross-window confusion ever generates actual complaints rather than hypothetical ones, a `FileSystemWatcher` is a drop-in addition to exactly one seam. Not built on speculation.

## 10. Architecture ruling (closed) and remaining confirmations before code (small, one sitting)

- **Ask E, CLOSED as rejected (owner ruling 2026-09-04):** the BYOK topology (`"extensionKind": ["ui"]`, provider always local, one physical config file for every window) was floated after the only-copy-on-Windows grill and killed on direct experience: a ui build was tried long ago and failed on remote windows (commands did not work there). The failure mode is the documented UI-extension limitation, not an implementation fluke: UI extensions "cannot directly access files in the remote workspace, or run scripts/tools installed in that workspace or on the machine", and anything `localhost`-based resolves on the laptop, not the GPU box. Microsoft ate the same dish: the built-in BYOK Ollama provider is deprecated precisely because the local-side chat service cannot reach container/WSL-local Ollama, and the official fix is installing the workspace-running Ollama extension. BYOK only gets away with its topology because its typical targets are cloud APIs reachable from the laptop; our pitch is self-hosted inference that often lives on the workspace host. Spike moot. Consequences of the rejection: the per-host design of section 4 is law, the empty-host migration guard stays, the cross-OS cookbook (`~` default, `/mnt/c` symlink, dotfiles) is the shipped answer to "where is my file", and the pointer-scope spike (Ask A) remains relevant.
- **Ask E addendum (owner ruling, same day): the rejection stays, but the spike is back.** The historical ui failure was never diagnosed, and the documented failure candidates include a mundane one: remote `localhost:8000` URLs tried against laptop-localhost (a config trap, not an architecture verdict). BYOK proves a ui-extension chat provider CAN serve remote windows when the endpoint is reachable from the laptop. Unit 0 of section 11 retests this cheaply before migration code; its result either restores the tombstone permanently or hands the owner a documented trade (one local file everywhere, paid for by making every remote user's `localhost` server URLs laptop-relative, which is breaking and needs its own migration warning).

- **Ask A, pointer scope:** `application` as argued in section 4, gated by spike 11.0. Alternative is `machine` and manual setup per host, which throws away the one portability gift this design gets.
- **Ask B, non-writable UX:** reads continue + writes fail loudly + dashboard error (recommended), or treat it as fatal-config and serve nothing. Recommendation is the loud-continue, matching the orphan-lenient house philosophy.
- **Ask C, annotation keys:** bless `//` and `_comment` as schema-allowed string keys at envelope and item level.
- **Ask D, `${env:VAR}` secret expansion:** implement in milestone 1 or later? The expansion itself is one regex at load plus schema docs, and it is what makes the dotfiles pitch honest. Recommendation: milestone 1, it is not enough code to be worth a second release.
- Everything else in section 0 is decided; do not re-litigate at implementation time without new evidence.

## 11. Implementation units

Each unit ends with `npm run compile`, `npm test`, `npm run rent -- --tsv` and `npm run dep:check` re-run and diffed against the previous snapshot. New files justify placement when proposed.

0. **Topology retest spike (owner ruling 2026-09-04, run before the migration unit; blocks nothing else).** Throwaway branch, `"extensionKind": ["ui"]`, package VSIX, install it inside a WSL or SSH window with a vLLM server on that box. Record four facts: (a) does the provider appear and serve chat in the remote window at all (BYOK theory says yes, RPC-routed to the local host); (b) does `http://localhost:8000/v1` fail exactly as the localhost trap predicts, and does a hostname or forwarded port fix it; (c) does config-file read/write from the remote window land on the laptop's disk (ui's whole point); (d) do dashboard/discovery/auth flows behave. Paste raw errors into this document. If it passes and the owner rules ui: section 4 shrinks to path rules, per-host machinery dies unbuilt, and a server-URL migration warning is added to section 7 for existing remote users whose `localhost` entries become laptop-relative. If it fails: permanent tombstone, no third attempt. The old failure's actual error message, if the owner remembers it, shortens this spike to minutes.

1. **Read-site inventory.** Every read of the two arrays outside `configStore` (expect `VllmClient` cache, discovery, dashboard, provider, commands). Output fixes the read API signature. This is first because the writer is already centralized and the readers are not.
2. **Spikes, throwaway:** application-scope setting update from a WSL/SSH window (gates Ask A); envelope `$ref` validation in VS Code's JSON editor; config file association with the `$schema` key.
3. **Envelope schema** `schemas/vllm-copilot-config.schema.json`: `$ref`s the per-entry model schema, allows `//`/`_comment`, version gate documented; per-entry schema description rewritten; `configurationSchema.test.ts` drift guard flips to the envelope.
4. **File backend module** in `src/state/`: pointer parse and `~` expansion (section 4 rules), strict read, validation, atomic write, writability check, globalStorage backup + restore, optional `${env:}` expansion, no vscode-free purity so no planner split here. Disposable per house rules.
5. **configStore routing:** settings backend when pointer empty, file backend when set, chosen once at activation, callers untouched.
6. **Migration** per section 7: pure planner (unit-testable like `planRegistryMigration`), wrapper owning flag, blocking placement after `serverRegistryMigration`, cleanup prompt + cleanup command.
7. **Manifest and doc sweep** per section 7's debt list, plus the LM tool per section 6, plus deleting several hundred lines of array schemas from package.json.
8. **Tests, tripwires only, named breakage:** migration planner (config loss during upgrade), file write/read integrity (corrupted config file), version gate (old extension vs newer file), cleanup command (settings destruction), read-site gate (the section 11.1 inventory becomes a review assertion: no `get('models'/'servers')` outside the backend). Structure beats seams; tripwires reroute rather than preserve old shapes.

## 12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| File deleted or mangled by the user (dotfiles force push, curious toddler) | globalStorage backup on every load, restore button on the error, atomic writes mean "never half" |
| Two windows write the same file | Last writer wins without corruption (temp + rename); reload command and window reload cover staleness; watcher deferred until proven necessary |
| User edits dead settings arrays after migration, or an AI does | Cleanup default removes the arrays entirely (ruling 1), which is the strongest mitigation: there is nothing left to edit; LM tool rewritten in the same commit; dashboard shows active path |
| WSL/remote confusion ("where did my models go?") | Dashboard and migration toast show resolved absolute path plus host; docs explain per-host resolution as inherited behavior, and the `/mnt/c` trick for sharing |
| Unwritable target (read-only mount, permissions, OneDrive gremlins) | Checked at load, loud error, writes fail explicitly, migration aborts cleanly to the old backend |
| Secrets in a dotfiles repo | Plaintext-in-settings stays accepted policy, but docs warn at migration time; `${env:}` expansion (Ask D) is the real answer and ships small |
| Migrated data contains orphan entries the strict envelope would reject | `models` items stay as lenient as runtime today (section 8); keep-verbatim + warn inherited |
| Activation hangs or dies on the new backend | All backend hops inside try/catch: worst case is zero models plus a diagnostic with buttons, never a dead window |
| Extension too old for a newer file (`version`) | Refuse, keep backup copy, say "upgrade the extension", do not garble |
| Application-scope pointer does not sync/write as expected from remote hosts | Spike 11.0 gates the whole scope decision before any backend code |

## 13. Pros and cons, final shape

For:

- settings.json stops being a database; hundreds of manifest schema lines die; the schema file stops being a decorative mirror of `ModelConfig` and becomes the actual contract.
- Pattern validated twice over: `systemMessageReplacementsFile` in-repo, `chatLanguageModels.json` by Microsoft, who deprecated their own settings-array predecessor for exactly this reason.
- Portability via a short, syncable pointer string plus `~` paths plus dotfiles, replacing config that never synced at all.
- Whole-file diffing, git history of a model zoo, `$schema` autocomplete, `$ref` reuse of the existing per-entry schema.
- The LM tool becomes a signpost instead of a fossil: agents ask where the config is and edit the file, which is what they are good at.
- Cleanup-by-default leaves zero dead arrays to confuse humans, AIs, or future migrations.
- Migration is per-host coherent with existing machine-scope behavior; rollback is deleting one setting.

Against:

- New failure surfaces (missing file, mangled file, unwritable directory, per-host divergence) all mitigated but all still real code.
- Config is per-host physical files. WSL and Windows have separate configs unless the user goes out of their way. This matches today's behavior but makes it visible, and visibility generates questions.
- Manual edits in a second window need a reload until the watcher earns its rent.
- One real feature release: backend module, migration, envelope schema, tool rewrite, doc sweep, test reroutes. Not a weekend patch.
- `${env:}` expansion (if blessed) is the one bit of runtime magic in an otherwise boring format; the docs carry the burden of "headers and URLs may reference env vars".

Net: the for column is structural and permanent; the against column is bounded work with named mitigations and a precedent that ships inside VS Code itself.

## 14. Release shape

Feature release. Version bump only with explicit owner blessing. One terse CHANGELOG entry: config lives in a file now, settings migrate themselves, you choose whether the old entries get cleaned up. Docs section ships same release: where the file lives per OS, WSL behavior, the pointer, annotations, writability, and the dotfiles pitch. No Fixed entries, this is news, not scar tissue.

## 15. Deferred or dead (recorded so nobody re-proposes with sparkling eyes)

- Remote/URL pointers, fork semantics, team-shared live configs: dead by ruling 4. Revisit only with a user story a file cannot serve.
- Overlay/merge of two config sources: dead, dual ownership of config state.
- Workspace-relative pointers: dead, exfiltration chain (section 4).
- `jsonc-parser` / real comments: dead per measurement (section 8); annotation keys serve the need.
- FileSystemWatcher: deferred until cross-window editing produces real complaints.
- Moving diagnostics/logging/poll settings into the file: dead permanently; flags that diagnose a broken config file cannot live inside the broken config file.
- Silent `jsonrepair` on load: dead; repair is an explicit user action.
- Clearing arrays automatically without asking: dead; ruling 1 mandates the prompt.
- WSL adopt-Windows-config offer (detect Windows-side config via `/mnt/c`, create the symlink or set a host-local pointer for the user): deferred convenience. The documented one-liner recipe serves v1; promote to a button only if humans prove they will not type one command.
- Cross-machine config reads (WSL or SSH reaching another machine's file directly): dead on capability and security grounds, section 4.
- BYOK-style ui topology (`extensionKind: ["ui"]`): dead pending unit 0 (see Ask E addendum, section 10; retest spike rules, do not re-litigate from aesthetics before it reports). BYOK's targets are laptop-reachable cloud APIs, ours are workspace-host-local inference servers, so the ui win requires the localhost-trap explanation to be the true story.
