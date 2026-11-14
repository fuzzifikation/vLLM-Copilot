# Merging the DeepSeek Harness bridge into vLLM-Copilot

vLLM-Copilot absorbs the DeepSeek Harness Bridge. The result is one extension, `System-Sciences.vllm-copilot`, that serves your models to GitHub Copilot and, when the user asks, installs and runs the DeepSeek Harness (dsh) on the same models. Editors without Copilot, such as VSCodium, get a working agent through the harness.

Status: plan, 2026-11-14. Nothing is implemented. Sources read: vLLM-Copilot `586ef87`, dsh-bridge `b5f862f`.

The merger is a move, not a redesign. The bridge's harness code works and is tested, so it moves into this repository mostly unchanged. The real work is deleting what existed only because there were two extensions, keeping the harness dormant until a user asks for it, and testing in VSCodium.

## Owner decisions (2026-11-14)

| Topic | Decision |
|---|---|
| Product | One extension and one repository: vLLM-Copilot. The owner deletes the bridge repository and Marketplace listing later. |
| Existing bridge users | No compatibility layer and no data migration. Alpha users uninstall the bridge and install the harness again inside vLLM-Copilot. Old sessions stay in the bridge's storage folder until the user removes them. |
| Names | Settings `dsh-bridge.*` and commands `dshBridge.*` become `vllm-copilot.harness.*`. No settings migration. |
| History and license | The bridge code is copied without its git history and is covered by this repository's license like every other file. |
| Harness | Optional. vLLM-Copilot never installs Node.js, npm or pnpm; the user does. dsh stays an unmodified upstream program in its own process. |

`engines.vscode` rises from `^1.128.0` to the bridge's `^1.140.0`. That follows from this repository's rule to support only current editor versions, not from a new decision.

## What the merger changes

### Kept as it is

The harness internals move without redesign: runtime install, prerequisite check, start lock and window adoption, supervisor, embed proxy and chromeless panel, editor tools over MCP, snapshot and overlay composition, the dsh adapter plugin, and the usage outbox. The core, the Copilot provider, the dashboard and the Model Settings view stay untouched. No file is split or merged during the move.

The process boundary stays because it is real. dsh runs in its own Node process and loads the adapter plugin, which uses a copy of the compiled core that the extension stages into the harness home. The adapter writes completed requests to the outbox; the extension folds them into the usage ledger.

### Deleted, because there is only one extension

| Bridge code | Replacement |
|---|---|
| `extensionDependencies`, `mainExtension()`, the "vLLM-Copilot is not installed" paths, the `dshBridge.ownerAvailable` context key | Nothing. Core staging copies this extension's own `out/core`. |
| `api.ts` (`asLedgerPort`, the `apiVersion` check), the `dshBridge` export returned by `activate()`, `EXTERNAL_USAGE_API_VERSION` | The ingest pass calls `recordExternalRequests` from `src/vscode/state/externalUsage.ts` directly. Outbox record validation stays, because the records come from another process. |
| `core-catalog.ts` (dynamic import of the staged core) and the fallbacks for cores without `resolveServedModels` or `buildDisplayKeys` | Direct imports of both functions from `src/core`. |
| The registry mirror in `settings.ts` (`readMainRegistry`, `RegistryModel`, `RegistryServer`) | `getConfig()` and the core types `ModelConfig` and `ServerEntry`. |
| Personality lookup by an absolute `systemMessageReplacementsFile` only | `resolveModelReplacements()`. This fixes a shipped bug: vLLM-Copilot stores built-in personalities by name (`personality`), so the bridge never passes them to the harness. |
| Retirement of `dsh-home-<version>` folders left by bridge 0.0.3 and older | Nothing. Such folders cannot exist in vLLM-Copilot's storage. |
| The sidebar advertisement for the bridge and the command list read from the bridge's manifest (`src/vscode/ui/harnessView.ts`) | Static rows for the harness commands, in the existing row order. |
| The bridge's setup notification and its "registry has no models" notification at activation | The sidebar section is the entry point. Otherwise every vLLM-Copilot user would see harness prompts. |
| `scripts/e2e-stand-in.mjs` and the cross-extension ledger test `test/e2e/bridge.e2e.ts` | Nothing. The handoff is now a function call, covered by the existing ingest and external-usage unit tests. |
| The git clone, `--ref` and `--dir` modes of `scripts/stage-core.mjs` | Staging from this repository's compiled `out/core`. |

### Changed, because the harness now ships to every vLLM-Copilot user

1. **Dormant until installed.** Until the harness runtime exists, the harness code registers its commands, the sidebar section and the panel serializer, and nothing else: no folders, no status-bar pill, no ingest timer, no prerequisite probes, no notifications. After installation it behaves as the bridge does today. The bridge creates its folders and arms a 10-second ingest timer at every activation; that suits an opt-in extension, not one with about 2,000 installs.
2. **Activation events.** Add `onStartupFinished` and `onWebviewPanel:<harness panel type>`. Today vLLM-Copilot activates on `languageModel_chatVendor:vllm-copilot`, which needs a chat client that asks for models; in an editor without Copilot, nothing may ask. Contributed views and commands activate the extension anyway, but the status-bar pill and restored harness panels need it at startup. The serializer API names the `onWebviewPanel` event as the requirement for panel revival.
3. **Old bridge still installed.** If `System-Sciences.dsh-bridge` is present, show one message ("The DeepSeek Harness is now part of vLLM-Copilot. Uninstall the DeepSeek Harness Bridge.") and do not start the harness from vLLM-Copilot. This prevents two harnesses running side by side. It is one check, not a compatibility layer; remove it in a later release.
4. **Harness failures stay contained.** `src/extension.ts` calls the harness setup after the common setup, inside its own `try`/`catch` that logs the error. A harness failure must not report vLLM-Copilot itself as failed.

### Copilot independence: test first

The code shows nothing that needs restructuring. Provider and tool registration use `vscode.lm`, which belongs to the editor's own extension API that VSCodium builds from the same source. The Copilot-specific settings writes (`chat.byokUtilityModelDefault` and the Agent Host settings) already skip editors that do not register those settings. Session cleanup runs only as a command.

So the first step installs the current release in VSCodium without Copilot and records what fails. Only failures found there get fixed. Restructuring activation without an observed failure would be guesswork.

## Repository layout

| Bridge | vLLM-Copilot |
|---|---|
| `src/extension.ts` (harness editor glue) | `src/vscode/harness/harness.ts`, exporting `activateHarness(context)` |
| `src/bridge/*.ts` | `src/vscode/harness/` |
| `plugin/` | `dsh/plugin/` |
| `shared/overlay.mjs`, `shared/core-staging.mjs` | `dsh/shared/` |
| `config/dsh.json` | `dsh/dsh.json` |
| `resources/dsh-bridge-icons.woff2` | `resources/` |
| `test/*.test.js` | `test/harness/` |
| `test/e2e/stale-tab.e2e.ts`, `test/e2e/embedded.e2e.ts` | `test/e2e/` |
| `scripts/*` except `e2e-stand-in.mjs` | `scripts/harness/` |
| `docs/` | see [Documentation](#documentation) |
| `spike/`, `temp/`, `out-e2e/`, built `.vsix` files | not copied |

`src/vscode/` holds everything that runs in the extension host, and the supervisor does. Its Node-only modules keep their rule of no `vscode` import, which keeps them testable without an editor. `dsh/` holds what composes the dsh runtime: the plugin dsh loads, the helpers that write its configuration, and the certified version pin. Root-level `plugin/`, `shared/` and `config/` would be ambiguous next to `model-configs/`.

Add one dependency-cruiser rule: `src/vscode/copilot/` and `src/vscode/harness/` never import each other. Both build on `src/core` and `src/vscode/state`. The existing `core-no-host` rule already keeps the core free of both.

## Build and tests

- Compile the moved TypeScript with this repository's `tsconfig.json` and its pinned TypeScript 6. The bridge used TypeScript 7, which breaks this repository's rails. Fix what `noUnusedLocals` and `noUnusedParameters` report. If the code needs ES2023 library types, raise `lib` and `target` to ES2023 and run the full `npm run build`, as the gauntlet rule requires for compiler changes.
- Run the bridge unit tests in this repository's Vitest against source, not compiled `out/`. Change their imports from `../out/bridge/*.js` to the `.ts` sources and alias `vllm-copilot-core` to `src/core/index.ts`. `npm test` then covers them without a separate compile or staging step.
- Add `@deepseek-ai/dsh-llm` as a development dependency (the plugin tests import it) and raise `@types/vscode` to `^1.140.0`.
- Port the real-harness rails (`step2-boot-check`, `step3-bridge-check`, `live-harness`) as `npm run harness:*` scripts. They download dsh, so they stay out of `npm run build`, as in the bridge.
- Merge the e2e suites into the one `.vscode-test.mjs`.
- `npm run build` stays green, including `dep:check` and `rent --fail-on=dead` over the moved code.
- `.vscodeignore` ships `dsh/` and the pill font and excludes `scripts/harness/`. Extend `test/packageStaging.test.ts` to assert that `dsh/plugin`, `dsh/shared`, `dsh/dsh.json` and the font are in the `vsce ls` payload, like its existing update-page check.

## Steps

Each step leaves `npm run build` green and lands as one coherent commit.

1. **Baseline.** Install vLLM-Copilot 1.39.0 in VSCodium without Copilot and record whether it activates, shows the dashboard, and adds and edits a model. Run the bridge's tests and rails once in its own repository, so later failures are attributable.
2. **Fix VSCodium findings,** if step 1 found any. This can ship on its own.
3. **Move.** Copy the files per the layout table and fix paths, compile errors and test imports. Behaviour stays unchanged apart from file locations; the bridge's `activate()` becomes `activateHarness(context)`.
4. **Delete the two-extension seams** listed above and add the dependency rule.
5. **Make the harness a feature of vLLM-Copilot:** dormancy, activation events, renames, the old-bridge check, sidebar rows, the merged `package.json` contributions (commands, a "DeepSeek Harness" settings section, menus, icons, the panel type) and packaging.
6. **Documentation** (below).
7. **Verify the packaged VSIX** (below).
8. **Publish** the same VSIX to the Marketplace and Open VSX; Open VSX still serves 1.36.16. The owner then retires the bridge listing and repository.

## Verification

Run on the packaged VSIX, in clean editor profiles:

| Setup | Expected |
|---|---|
| VS Code with Copilot, no Node.js | Provider, model picker, dashboard and settings behave as in 1.39.0. The harness section offers installation. No harness folders, processes, timers, pill or notifications. |
| VSCodium without Copilot | Install the VSIX, add a model, install the harness from the sidebar, complete an agent turn with a tool call and a follow-up. The usage appears on the dashboard. |
| Built-in personality on the default model | The harness applies it. |
| Node.js, npm or pnpm missing | The install action names the missing tool before any download. The rest of the extension keeps working. |
| Harness behaviour | Panel restore after reload, restart after a model edit, two windows sharing one harness, and stop with requests in flight behave as in bridge 0.1.6. |
| Old bridge installed | The message appears; vLLM-Copilot starts no second harness. |
| WSL and SSH | The harness installs and runs on the remote host; the panel opens through port forwarding. |
| Agents window | The extension loads there as before; the dormant harness adds nothing. |

After publishing, install once from each gallery, including VSCodium from Open VSX.

## Documentation

- **`.github/copilot-instructions.md`:** replace the Copilot-only scope law with the merged product. Carry over the bridge's standing rulings: dsh stays upstream and unforked; the harness owns the conversation and vLLM-Copilot owns the request; the core reaches dsh only by staging; no dependency on other dsh extensions; no hostnames or prompts in fixtures and logs. Add the harness folders to the architecture table and the `harness:*` scripts to Build & Test.
- **README and gallery text:** one product with two optional interfaces, a harness quick start with its prerequisites, and the harness FAQ from the bridge README (extra providers inside the harness, whose traffic does not reach the usage totals). Add the keywords `deepseek`, `dsh`, `harness` and `vscodium`: discovery was the reason for the separate listing, and keywords now carry it.
- **`docs/manual.md` and `docs/configuration-reference.md`:** the harness commands and the `vllm-copilot.harness.*` settings.
- **Bridge docs:** the live architecture and owner rulings of `dsh-bridge-plan.md` become `docs/harness.md`, `ui-ux.md` becomes `docs/harness-ui.md`, and `upstream-issues.md` becomes `docs/harness-upstream-issues.md`. Copy the decision journal `plan.md` unchanged as `docs/harness-journal.md`; without git history it is the only record of rejected alternatives. Drop `vllm-copilot-integration.md` (the two-extension API wishlist) and `licenses.md`.
- **CHANGELOG and `resources/update.md`:** the harness is built in; bridge users uninstall the bridge and install the harness from the sidebar (one download of 2-3 minutes); old sessions are not carried over; the renamed settings.
- Delete this plan once the merger ships.

## Not part of the merger

Redesigning harness internals, new harness features, a dsh version change, settings or session migration, and changes to the Copilot provider, the core, the gateway or the config-file plan.

Effort: about 4 to 6 focused days. The code changes are mostly moves and deletions; most of the time goes into VSCodium, remote and packaging verification and the documentation.
