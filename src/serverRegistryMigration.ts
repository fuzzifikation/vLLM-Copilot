/**
 * Forced server-registry migration on activation (docs/server-registry.md §6).
 *
 * Moves the server facts (serverUrl/requestHeaders/serverType/serverDisplayName)
 * off every `vllm-copilot.models` entry and into the `vllm-copilot.servers`
 * registry, rewriting models to `{ server: <id> }` refs. Runs once per install,
 * silently — the planning itself is the pure `planRegistryMigration()`; this
 * module owns only the vscode-side contract: the globalState marker, the
 * pre-write snapshot, and the servers-before-models write order.
 *
 * Must run *before* `maybeOfferOutputLengthMigration` in activate(): that one
 * identifies models by `{ id, serverUrl }`, which the rewrite removes.
 */

import * as vscode from 'vscode';
import type { ModelConfig } from './config.js';
import { readModels, readServers, writeModels, writeServers } from './configStore.js';
import { planRegistryMigration, type LegacyModelConfig } from './registryMigration.js';
import type { ServerEntry } from './serverRegistry.js';

const MIGRATION_FLAG = 'vllmCopilot.serverRegistryMigration.v1';
const SNAPSHOT_KEY = 'vllmCopilot.serverRegistryMigration.snapshot.v1';
const BTN_SHOW = 'Show servers';

/** Pre-migration state of both arrays; kept as a forensic backup, not a user feature. */
interface RegistrySnapshot {
  models: LegacyModelConfig[];
  servers: ServerEntry[];
}

/**
 * Activation entry point. Never throws — activation awaits it, and a failure
 * must not take the whole extension down. Leaves the marker unset on any write
 * failure so the next activation retries the (idempotent) plan from scratch.
 */
export async function maybeRunServerRegistryMigration(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<void> {
  try {
    const decided = context.globalState.get<string>(MIGRATION_FLAG);
    if (decided === 'done') return;

    // Read the raw settings as the LEGACY shape — the migration exists precisely
    // because the stored models predate the registry and still carry inline
    // server facts. Cast from readModels(): the stored array is not yet the new
    // ModelConfig shape, and treating it as such would defeat the migration.
    const models = readModels() as unknown as LegacyModelConfig[];
    if (models.length === 0) {
      // Fresh install: models will be created in the new shape from the start.
      await context.globalState.update(MIGRATION_FLAG, 'done');
      return;
    }

    const existingServers = readServers();
    // Passing the existing registry keeps a retry (servers written, models
    // write failed) converging: matching fingerprints are reused, not duplicated.
    const plan = planRegistryMigration(models, existingServers);

    // Forensic backup of the pre-write state, stored before any write touches
    // settings.json. There is deliberately NO user-facing Undo: restoring the
    // legacy shape would leave settings this version cannot use. The snapshot
    // stays as a recovery reference should a migration bug ever be reported.
    // It contains requestHeaders; same machine, same (accepted) threat model
    // as plaintext settings.
    const snapshot: RegistrySnapshot = { models, servers: existingServers };
    await context.globalState.update(SNAPSHOT_KEY, snapshot);

    for (const s of plan.skipped) {
      output.appendLine(
        `[WARN] Server registry migration: model "${s.id}" has no serverUrl — kept in settings, unreachable until it references a server.`
      );
    }

    if (plan.servers.length === 0 && plan.skipped.length === models.length) {
      // No model had a usable serverUrl — nothing to adopt, nothing to rewrite.
      await context.globalState.update(MIGRATION_FLAG, 'done');
      output.appendLine('[INFO] Server registry migration: no serverUrl on any model — nothing adopted.');
      return;
    }

    const nextServers = [...existingServers, ...plan.servers];
    output.appendLine(`[INFO] Server registry migration — before:\n${JSON.stringify({ servers: existingServers, models }, null, 2)}`);
    output.appendLine(`[INFO] Server registry migration — after:\n${JSON.stringify({ servers: nextServers, models: plan.models }, null, 2)}`);

    try {
      // Servers first: an interrupted migration must never leave models
      // pointing at entries that do not exist yet. There is no multi-key
      // transaction in config.update(); order is all we get. A retry that
      // reused every entry has nothing to add — don't rewrite the servers key.
      if (plan.servers.length > 0) {
        await writeServers(nextServers);
      }
      // plan.models is the NEW shape for migrated entries plus verbatim-kept
      // legacy orphans. writeModels is typed for the new ModelConfig; the union
      // (with legacy orphans) is the honest representation of what we persist,
      // so cast at this single write boundary — the stored array is exactly the
      // migration output by construction.
      await writeModels(plan.models as unknown as ModelConfig[]);
    } catch (err) {
      // Settings write blocked (e.g. invalid settings.json) — no marker, so
      // the next activation retries. The snapshot above is harmless.
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`vLLM-Copilot: could not adopt your servers into settings — will retry next start. ${msg}`);
      output.appendLine(`[WARN] Server registry migration write failed: ${msg}`);
      return;
    }

    await context.globalState.update(MIGRATION_FLAG, 'done');
    const adopted = plan.servers.length;
    const summary = adopted > 0
      ? `adopted ${adopted} server${adopted === 1 ? '' : 's'} from your model settings into the new server registry`
      : 'rewrote your model settings to reference the server registry';
    output.appendLine(`[INFO] Server registry migration: ${summary}.`);
    void vscode.window
      .showInformationMessage(
        `vLLM-Copilot: ${summary}.`,
        BTN_SHOW
      )
      .then(choice => {
        if (choice === BTN_SHOW) {
          void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:System-Sciences.vllm-copilot servers');
        }
      });
  } catch (err) {
    output.appendLine(`[WARN] Server registry migration check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
