/**
 * Forced server-registry migration on activation.
 *
 * Moves the server facts (serverUrl/requestHeaders/serverType/serverDisplayName)
 * off every `vllm-copilot.models` entry and into the `vllm-copilot.servers`
 * registry, rewriting models to `{ server: <id> }` refs. Runs once per install,
 * silently — the planning itself is the pure `planRegistryMigration()`; this
 * module owns only the vscode-side contract: the globalState marker and the
 * servers-before-models write order.
 *
 * Must run *before* `maybeOfferOutputLengthMigration` in activate(): that one
 * patches models addressed by `{ id, server }`, a ref that only exists once the
 * rewrite has landed.
 */

import * as vscode from 'vscode';
import type { ModelConfig } from '../state/config.js';
import { readModels, readServers, writeModels, writeServers } from '../state/configStore.js';
import { planRegistryMigration, type LegacyModelConfig } from './registryMigration.js';

const MIGRATION_FLAG = 'vllmCopilot.serverRegistryMigration.v1';
const BTN_SHOW = 'Show servers';

/**
 * Replace every header VALUE with a marker, keeping the header names. The
 * before/after dumps are debug aids for a one-shot migration; a dump that
 * carries a live `Authorization` value into the user-visible Output channel
 * (and into whatever the user pastes of it) leaks the key. Names are not
 * secret, values are.
 */
function redactHeaders<T extends object>(items: T[]): T[] {
  return items.map(item => {
    const headers = (item as { requestHeaders?: Record<string, string> }).requestHeaders;
    return headers
      ? {
          ...item,
          requestHeaders: Object.fromEntries(Object.keys(headers).map(name => [name, '<redacted>'])),
        }
      : item;
  });
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
      // Nothing to migrate right now — but do NOT set the marker. When
      // settings.json is malformed, VS Code serves NO user values, so an
      // empty read here is indistinguishable from "the user's legacy models
      // exist but are temporarily unreadable". Marking done then would orphan
      // those models forever once the file is repaired (the marker is the
      // only thing this check consults next activation). Deferring costs a
      // trivial empty re-check per activation on fresh installs, and a repair
      // gets adopted on the next activation — which is the whole point.
      return;
    }

    const existingServers = readServers();
    // Passing the existing registry keeps a retry (servers written, models
    // write failed) converging: an existing entry on the same connection (URL +
    // auth) is reused, not duplicated.
    const plan = planRegistryMigration(models, existingServers);

    // No pre-write snapshot and no Undo: the migration is verifiably additive
    // (servers are adopted, never deleted; models keep every non-server field),
    // VS Code keeps its own settings history, and restoring the legacy shape
    // would only produce settings this version cannot use.

    for (const s of plan.skipped) {
      output.appendLine(
        `[WARN] Server registry migration: model "${s.id}" (${s.reason}) - kept in settings, unreachable until it references a server.`
      );
    }

    for (const c of plan.conflicts) {
      output.appendLine(
        `[WARN] Server registry migration: models ${c.modelIds.map(id => `"${id}"`).join(', ')} share ${c.serverUrl} but declare different backends (${c.protocols.join(', ')}). Entry "${c.serverId}" now decides the protocol for all of them - fix any model that speaks a different one.`
      );
    }

    if (plan.servers.length === 0 && plan.skipped.length === models.length) {
      // Two all-skipped states look identical here (CR-58):
      // - NOTHING REPAIRABLE: no model carries a serverUrl value at all, or a
      //   retry found every model already migrated (they carry `server` refs)
      //   → legitimately done.
      // - REPAIRABLE: a skipped model still carries a legacy `serverUrl` VALUE
      //   that was rejected (blank/host-less garbage a hand-edit can fix).
      //   Marking done would lock out exactly the state the user CAN repair —
      //   the same policy the empty-read branch above follows. Leave the
      //   marker off and let the next activation re-check.
      const repairable = models.some(m =>
        typeof m.serverUrl === 'string' && m.serverUrl.trim() !== ''
      );
      if (!repairable) {
        await context.globalState.update(MIGRATION_FLAG, 'done');
        output.appendLine('[INFO] Server registry migration: no serverUrl on any model - nothing adopted.');
      } else {
        output.appendLine('[WARN] Server registry migration: every model was skipped - fix the "serverUrl" values in settings.json; the next start will adopt them (marker NOT set, this migration stays armed).');
      }
      return;
    }

    const nextServers = [...existingServers, ...plan.servers];
    // Header values are redacted in both dumps — the Output channel is
    // user-visible and routinely pasted into bug reports (see redactHeaders).
    output.appendLine(`[INFO] Server registry migration - before:\n${JSON.stringify({ servers: redactHeaders(existingServers), models: redactHeaders(models) }, null, 2)}`);
    output.appendLine(`[INFO] Server registry migration - after:\n${JSON.stringify({ servers: redactHeaders(nextServers), models: redactHeaders(plan.models) }, null, 2)}`);

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
      // the next activation retries the idempotent plan from scratch.
      const msg = err instanceof Error ? err.message : String(err);
      // Fresh VSIX installs can activate before VS Code's configuration
      // registry knows the new `vllm-copilot.servers` key; the write then
      // throws "not a registered configuration" (same registration race
      // byok.ts guards against). A VS Code restart re-reads the setting and
      // the retry succeeds — the raw VS Code error alone gives the user no
      // action, so name the fix. Other write failures (invalid
      // settings.json) keep the raw message; a restart would not help there.
      const restartNeeded = msg.toLowerCase().includes('registered configuration');
      const toast = restartNeeded
        ? 'vLLM-Copilot: could not adopt your servers into the new server registry. Restart VS Code to finish - servers are adopted automatically on next start.'
        : `vLLM-Copilot: could not adopt your servers into settings, will retry next start. ${msg}`;
      void vscode.window.showErrorMessage(toast);
      output.appendLine(`[WARN] Server registry migration write failed: ${msg}${restartNeeded ? ' - restart VS Code to register the new servers setting; the migration retries on next start.' : ''}`);
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
