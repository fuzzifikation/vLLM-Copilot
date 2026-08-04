/**
 * VS Code command registrations for the extension's user-facing commands.
 *
 * Each `registerXxxCommand` returns a Disposable, matching the convention used by
 * `registerAddServerModelCommand` (autoConfig.ts). `activate()` wires them up; the
 * command bodies live here so the activation function stays a thin, readable
 * sequence.
 */

import * as vscode from 'vscode';
import { VllmChatModelProvider } from './provider.js';
import { getConfig, buildEndpoint, resolveServerConfig, resolveVllmModelId, normalizeServerUrl, buildModelId } from './config.js';
import type { ModelConfig } from './config.js';
import type { VllmModel } from './types.js';
import { pickModelFromServer, saveModelConfig, promptForServerAuth, autoConfigureModel } from './autoConfig.js';
import { FileLogger } from './logger.js';
import { describeError } from './messageConverter.js';
import { runDiagnostics, formatReport } from './diagnostics.js';
import {
  discoverWorkspaces,
  cleanWorkspace,
  SessionPickedItem,
  WorkspaceEntry,
} from './sessionManager.js';
import { discoverPersonalities, ensureGlobalPersonality, resolveActivePersonality } from './personalityStore.js';
import { getMetricsEngine } from './vllmMetrics.js';

/**
 * Result of testing a single unique server (grouped by URL + auth).
 * Each unique server is tested once regardless of how many model configs
 * point to it.
 */
export interface ServerTestResult {
  serverUrl: string;
  status: 'ok' | 'error' | 'no-match';
  /** All model configs grouped under this server. */
  modelConfigs: ModelConfig[];
  /** Models whose vllmModelId matched a served model. */
  matched: Array<{ config: ModelConfig; vllmModelId: string; maxModelLen?: number }>;
  /** Models whose vllmModelId was NOT found on the server (parked). */
  parked: Array<{ config: ModelConfig; vllmModelId: string }>;
  errorMessage?: string;
  /** The full model list returned by the server (for picker/diagnostic). */
  serverModelList?: VllmModel[];
}

/**
 * Internal grouping types for server-dedup logic.
 */
interface ServerGroup {
  serverUrl: string;
  requestHeaders: Record<string, string>;
  models: ModelConfig[];
}

/**
 * Build a deterministic fingerprint for a server from its URL and auth headers.
 * Two model configs that point to the same server (same URL + same headers)
 * produce the same fingerprint and are tested together.
 * @internal Exported for testing.
 */
export function serverFingerprint(url: string, headers: Record<string, string>): string {
  const sorted = Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([url, sorted]);
}

/**
 * Group model configs by unique server (URL + auth headers fingerprint).
 * Each unique server appears once in the output; models without a serverUrl
 * each get their own singleton group so they can be reported individually.
 * @internal Exported for testing.
 */
export function groupModelsByServer(
  models: ModelConfig[],
  resolveServer: (m: ModelConfig) => { serverUrl: string; requestHeaders: Record<string, string> },
  resolveId: (m: ModelConfig) => string | undefined,
): ServerGroup[] {
  const groups = new Map<string, ServerGroup>();
  for (const model of models) {
    if (!model.serverUrl) {
      const fp = `__nourl__${model.id ?? resolveId(model) ?? Math.random()}`;
      groups.set(fp, { serverUrl: '', requestHeaders: {}, models: [model] });
      continue;
    }
    const { serverUrl, requestHeaders } = resolveServer(model);
    const fp = serverFingerprint(serverUrl, requestHeaders);
    const existing = groups.get(fp);
    if (existing) {
      existing.models.push(model);
    } else {
      groups.set(fp, { serverUrl, requestHeaders, models: [model] });
    }
  }
  return Array.from(groups.values());
}

/**
 * Check VS Code's network/proxy gating settings. The patched `globalThis.fetch`
 * (which handles proxy routing and OS certificate loading) is gated by three
 * settings. If IT pushed any to off/false via managed policy, all VS Code network
 * features break — not just ours.
 *
 * Returns warning strings for any non-default values. Empty array = all fine.
 */
function checkNetworkGatingSettings(): string[] {
  const config = vscode.workspace.getConfiguration('http');
  const warnings: string[] = [];

  const proxySupport = config.get<string>('proxySupport', 'override');
  if (proxySupport === 'off') {
    warnings.push('http.proxySupport is "off" — proxy patch is disabled');
  }

  const fetchAdditionalSupport = config.get<boolean>('fetchAdditionalSupport', true);
  if (fetchAdditionalSupport === false) {
    warnings.push('http.fetchAdditionalSupport is false — fetch proxy/cert patch is disabled');
  }

  const systemCertificates = config.get<boolean>('systemCertificates', true);
  if (systemCertificates === false) {
    warnings.push('http.systemCertificates is false — OS certificate store not used');
  }

  return warnings;
}

/**
 * Test all configured models and refresh the model list.
 *
 * Models are grouped by unique server (normalized URL + auth headers),
 * so each server is queried exactly once via GET /v1/models. The output
 * is a single consolidated status message — one line per server — rather
 * than one popup per model config.
 *
 * If a server is reachable and at least one configured model matches a
 * served model, that's reported as "OK" and the matching model(s) go into
 * the Copilot model picker. Non-matching models on the same server are
 * silently parked (kept in settings but not in the picker). An error is
 * only shown when a server is unreachable, returns an error, or has no
 * matching model at all — in which case the user is offered to pick or
 * auto-configure a model from the server.
 *
 * Cache is cleared so discovery re-runs.
 */
export function registerTestAndRefreshModelsCommand(
  context: vscode.ExtensionContext,
  provider: VllmChatModelProvider,
  outputChannel: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.testAndRefreshModels', async () => {
    const cfg = await getConfig(context);
    const models = cfg.models || [];

    if (models.length === 0) {
      const pick = await vscode.window.showInformationMessage(
        'No models are configured yet.',
        'Add vLLM Server & Model'
      );
      if (pick) await vscode.commands.executeCommand('vllm-copilot.addServerModel');
      return;
    }

    // ── 1. Group models by unique server fingerprint (URL + auth headers) ──
    // Servers with identical URL and headers share one fetch instead of N.
    const groups = groupModelsByServer(models, resolveServerConfig, resolveVllmModelId);

    // ── 2. Test each unique server once (parallel) ──
    const serverTasks = groups.map(async (group): Promise<ServerTestResult> => {
      if (!group.serverUrl) {
        // Models without a serverUrl — they cannot be tested.
        return {
          serverUrl: '',
          status: 'error',
          modelConfigs: group.models,
          matched: [],
          parked: group.models.map(m => ({
            config: m,
            vllmModelId: resolveVllmModelId(m) || m.id || '(unnamed)',
          })),
          errorMessage: 'No serverUrl configured',
        };
      }

      try {
        const resp = await fetch(buildEndpoint(group.serverUrl, 'v1/models'), {
          headers: group.requestHeaders,
          signal: AbortSignal.timeout(10000),
        });

        if (resp.status === 401 || resp.status === 403) {
          return {
            serverUrl: group.serverUrl,
            status: 'error',
            modelConfigs: group.models,
            matched: [],
            parked: group.models.map(m => ({
              config: m,
              vllmModelId: resolveVllmModelId(m) || m.id || '(unnamed)',
            })),
            errorMessage: `Authentication failed (HTTP ${resp.status})`,
          };
        }

        if (!resp.ok) {
          return {
            serverUrl: group.serverUrl,
            status: 'error',
            modelConfigs: group.models,
            matched: [],
            parked: group.models.map(m => ({
              config: m,
              vllmModelId: resolveVllmModelId(m) || m.id || '(unnamed)',
            })),
            errorMessage: `HTTP ${resp.status}`,
          };
        }

        const data: any = await resp.json();
        const serverModels: VllmModel[] = data.data || [];

        // Match each configured model against the server's loaded models.
        // Matching is strict on m.id (not m.root) to avoid false positives.
        const matched: Array<{ config: ModelConfig; vllmModelId: string; maxModelLen?: number }> = [];
        const parked: Array<{ config: ModelConfig; vllmModelId: string }> = [];

        for (const model of group.models) {
          const vllmModelId = resolveVllmModelId(model) || model.id || '';
          if (!vllmModelId) {
            parked.push({ config: model, vllmModelId: '(unnamed)' });
            continue;
          }
          const found = serverModels.find((m: VllmModel) => m.id === vllmModelId);
          if (found) {
            matched.push({ config: model, vllmModelId, maxModelLen: found.max_model_len });
          } else {
            parked.push({ config: model, vllmModelId });
          }
        }

        if (matched.length > 0) {
          return {
            serverUrl: group.serverUrl,
            status: 'ok',
            modelConfigs: group.models,
            matched,
            parked,
            serverModelList: serverModels,
          };
        } else {
          return {
            serverUrl: group.serverUrl,
            status: 'no-match',
            modelConfigs: group.models,
            matched: [],
            parked,
            errorMessage: 'No configured model matches any served model',
            serverModelList: serverModels,
          };
        }
      } catch (err) {
        return {
          serverUrl: group.serverUrl,
          status: 'error',
          modelConfigs: group.models,
          matched: [],
          parked: group.models.map(m => ({
            config: m,
            vllmModelId: resolveVllmModelId(m) || m.id || '(unnamed)',
          })),
          errorMessage: describeError(err),
        };
      }
    });

    const serverResults = await Promise.all(serverTasks);

    // ── 3. Show one popup per unique server ──
    // Each deduped server gets its own individual info/warning message.
    const anyFailure = serverResults.some(r => r.status === 'error');

    for (const result of serverResults) {
      const { serverUrl, status, matched, errorMessage } = result;

      if (status === 'ok') {
        // One ✓ per server with a working model. Parked models on the same
        // server are silent — kept in settings, not in the model picker,
        // no popup noise.
        const matchNames = matched.map(m => m.vllmModelId).join(', ');
        const ctx = matched[0]?.maxModelLen
          ? ` (${matched[0].maxModelLen.toLocaleString()} ctx)`
          : '';
        vscode.window.showInformationMessage(`✓ ${serverUrl} — ${matchNames}${ctx}`);
      } else if (status === 'no-match') {
        let msg = `✗ ${serverUrl} — reachable but no configured model is hosted there`;
        if (result.serverModelList && result.serverModelList.length > 0) {
          const serverNames = result.serverModelList.map(m => m.id).join(', ');
          msg += `\n  Server hosts: ${serverNames}`;
        }
        vscode.window.showWarningMessage(msg);
      } else {
        // error (includes no-serverUrl)
        if (serverUrl) {
          let msg = `✗ ${serverUrl} — ${errorMessage}`;
          if (result.modelConfigs.length > 1) {
            const modelNames = result.modelConfigs
              .map(m => m.displayName || m.id || resolveVllmModelId(m) || '(unnamed)')
              .join(', ');
            msg += `\n  Models: ${modelNames}`;
          }
          vscode.window.showWarningMessage(msg);
        } else {
          // No-serverUrl case: one popup per config (each is its own "server")
          for (const cfg of result.modelConfigs) {
            const id = cfg.displayName || cfg.id || resolveVllmModelId(cfg) || '(unnamed)';
            vscode.window.showWarningMessage(`✗ ${id} — no serverUrl configured`);
          }
        }
      }
    }

    // ── 4. Post-check corrective actions ──

    // 4a. For 'no-match' servers: offer corrective action per server.
    const noMatchResults = serverResults.filter(
      r => r.status === 'no-match' && r.serverModelList && r.serverModelList.length > 0
    );
    for (const result of noMatchResults) {
      await handleNoMatchServer(result);
    }

    // 4b. For errored servers: network check + diagnostic offer.
    if (anyFailure) {
      const networkWarnings = checkNetworkGatingSettings();
      if (networkWarnings.length > 0) {
        const detail = networkWarnings.join('\n');
        const settingsPick = await vscode.window.showWarningMessage(
          `VS Code network settings may be blocking the connection:\n\n${detail}\n\nThese settings gate the patched fetch that handles proxy routing and OS certificates.`,
          'Open Settings'
        );
        if (settingsPick) {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'http.proxy');
        }
      }

      const firstFailed = serverResults.find(r => r.status === 'error');
      if (firstFailed?.serverUrl) {
        const diagPick = await vscode.window.showWarningMessage(
          'One or more servers failed to connect. Run a deep diagnostic?',
          'Run Diagnostic'
        );
        if (diagPick === 'Run Diagnostic') {
          outputChannel.show(true);
          outputChannel.appendLine('[INFO] Running diagnostics…');
          const report = await runDiagnostics(
            buildEndpoint(firstFailed.serverUrl, 'v1/models'),
            // Use the first model's resolved headers for the diagnostic.
            (() => {
              const firstCfg = firstFailed.modelConfigs[0];
              return firstCfg ? resolveServerConfig(firstCfg).requestHeaders : {};
            })(),
          );
          outputChannel.appendLine(formatReport(report));
          outputChannel.appendLine('');
          outputChannel.appendLine(
            'Copy this report (right-click → Copy) and share it when reporting issues.'
          );
        }
      }
    }

    // Clear cached models so the provider re-fetches on next use.
    provider.clearCache();
  });
}

/**
 * Handle a no-match server: offer to pick a model (or auto-configure)
 * and update an existing config or add a new one.
 */
async function handleNoMatchServer(result: ServerTestResult): Promise<void> {
  // Offer Pick Model or Auto-Configure.
  const method = await vscode.window.showWarningMessage(
    `✗ ${result.serverUrl} — configure a model now?`,
    'Pick Model',
    'Auto-Configure',
    'Skip'
  );
  if (method === 'Skip' || !method) return;

  const serverModels = result.serverModelList!;
  let chosen: string | undefined;
  if (serverModels.length === 1) {
    chosen = serverModels[0].id;
  } else {
    chosen = await pickModelFromServer(
      serverModels,
      result.serverUrl,
      method === 'Auto-Configure' ? 'Select model to auto-configure' : 'Select a model to add'
    );
  }
  if (!chosen) return;

  try {
    const firstCfg = result.modelConfigs[0];
    const { requestHeaders } = firstCfg ? resolveServerConfig(firstCfg) : { requestHeaders: {} };

    const parkedConfigs = result.parked.map(p => p.config);
    let configToUpdate: ModelConfig | undefined;
    if (parkedConfigs.length === 1) {
      configToUpdate = parkedConfigs[0];
    } else if (parkedConfigs.length > 1) {
      const whichConfig = await vscode.window.showQuickPick(
        parkedConfigs.map(c => ({
          label: c.displayName || c.id || resolveVllmModelId(c) || '(unnamed)',
          description: resolveVllmModelId(c) || '(no model ID)',
          config: c,
        })),
        { placeHolder: 'Which existing config should point to the new model?' }
      );
      configToUpdate = whichConfig?.config;
    }

    if (configToUpdate) {
      await updateExistingConfig(
        configToUpdate, chosen, result.serverUrl, requestHeaders, method === 'Auto-Configure'
      );
    } else {
      await addNewConfig(chosen, result.serverUrl, requestHeaders, method === 'Auto-Configure');
    }
  } catch (saveErr) {
    vscode.window.showErrorMessage(
      `Failed to save model config: ${describeError(saveErr)}`
    );
  }
}

/**
 * Update an existing model config's vllmModelId in place.
 * Optionally runs auto-configure (HF metadata) first.
 */
async function updateExistingConfig(
  config: ModelConfig,
  chosen: string,
  serverUrl: string,
  requestHeaders: Record<string, string>,
  autoConfigure: boolean,
): Promise<void> {
  if (autoConfigure) {
    const acResult = await autoConfigureModel(chosen, serverUrl, requestHeaders);
    const merged: ModelConfig = {
      ...acResult.modelConfig,
      id: config.id,
      vllmModelId: chosen,
      serverUrl,
      displayName: config.displayName,
      requestHeaders: Object.keys(requestHeaders).length > 0 ? requestHeaders : config.requestHeaders,
      systemMessageReplacementsFile: config.systemMessageReplacementsFile,
    };
    await saveModelConfig(merged);
    vscode.window.showInformationMessage(
      `Configured "${chosen}" with HF metadata and saved to existing config.`
    );
  } else {
    const updated: ModelConfig = { ...config, vllmModelId: chosen };
    await saveModelConfig(updated);
    vscode.window.showInformationMessage(
      `Updated "${config.displayName || config.id || chosen}" → "${chosen}".`
    );
  }
}

/**
 * Add a new model config from a server (no existing config to update).
 * Optionally runs auto-configure (HF metadata) first.
 */
async function addNewConfig(
  chosen: string,
  serverUrl: string,
  requestHeaders: Record<string, string>,
  autoConfigure: boolean,
): Promise<void> {
  if (autoConfigure) {
    const acResult = await autoConfigureModel(chosen, serverUrl, requestHeaders);
    const merged: ModelConfig = {
      ...acResult.modelConfig,
      serverUrl,
      ...(Object.keys(requestHeaders).length > 0 ? { requestHeaders } : {}),
    };
    await saveModelConfig(merged);
    vscode.window.showInformationMessage(
      `Configured "${chosen}" with HF metadata and saved as new entry.`
    );
  } else {
    const newConfig: ModelConfig = {
      id: buildModelId(serverUrl, chosen),
      vllmModelId: chosen,
      serverUrl,
      ...(Object.keys(requestHeaders).length > 0 ? { requestHeaders } : {}),
    };
    await saveModelConfig(newConfig);
    vscode.window.showInformationMessage(`Added "${chosen}" on ${serverUrl}.`);
  }
}

/**
 * Diagnose connection issues for a single model.
 *
 * Runs a deep diagnostic (SChannel vs Node fetch, DNS, TCP, cert chain) and
 * writes the report to the Output channel. Can also be triggered on-demand —
 * even when Test & Refresh passes — for cases where Copilot chat fails but the
 * basic test succeeds.
 */
export function registerDiagnoseConnectionCommand(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.diagnoseConnection', async () => {
    const config = await getConfig(context);
    const models = config.models || [];

    if (models.length === 0) {
      vscode.window.showInformationMessage(
        'No models are configured yet. Add a model first to diagnose its connection.'
      );
      return;
    }

    // Let the user pick which model's server to diagnose.
    const items = models.map(m => ({
      label: m.displayName || m.id || '(unnamed)',
      description: m.serverUrl || 'no serverUrl',
      model: m,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a model to diagnose',
    });
    if (!picked) return;

    const serverUrl = picked.model.serverUrl;
    if (!serverUrl) {
      vscode.window.showWarningMessage(
        `Model "${picked.label}" has no serverUrl. Add one first.`
      );
      return;
    }

    // Resolve the model's request headers so the diagnostic tests the same
    // authenticated request that the extension makes — not a bare GET that
    // would 401 on any auth-required server.
    const { requestHeaders } = resolveServerConfig(picked.model);
    const url = buildEndpoint(serverUrl, 'v1/models');
    outputChannel.show(true);
    outputChannel.appendLine('[INFO] Running diagnostics…');

    try {
      const report = await runDiagnostics(url, requestHeaders);
      outputChannel.appendLine(formatReport(report));
      outputChannel.appendLine('');
      outputChannel.appendLine(
        'Copy this report (right-click → Copy) and share it when reporting issues.'
      );
    } catch (err) {
      outputChannel.appendLine(`[ERROR] Diagnostics failed unexpectedly: ${describeError(err)}`);
    }
  });
}

/** Open the active log file in an editor. */
export function registerOpenLogFileCommand(fileLogger: FileLogger): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.openLogFile', async () => {
    const logPath = fileLogger.getLogFilePath();
    if (!logPath) {
      vscode.window.showInformationMessage('File logging is not enabled. Set `vllm-copilot.enableFileLogging` to `true` in Settings.');
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(logPath);
      await vscode.window.showTextDocument(doc);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Could not open log file at: ${logPath} — ${reason}`);
    }
  });
}

/** Delete all log files except the currently active one. */
export function registerClearLogFilesCommand(fileLogger: FileLogger): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.clearLogFiles', async () => {
    const answer = await vscode.window.showWarningMessage(
      'This will delete all vLLM-Copilot log files (except the currently active one). Continue?',
      { modal: true },
      'Delete'
    );
    if (answer !== 'Delete') return;

    const deleted = await fileLogger.clearLogFiles();
    if (deleted > 0) {
      vscode.window.showInformationMessage(`Deleted ${deleted} log file(s).`);
    } else {
      vscode.window.showInformationMessage('No log files found to delete.');
    }
  });
}

/** Discover and clean Copilot chat sessions across workspaces. */
export function registerCleanSessionsCommand(
  output: vscode.OutputChannel,
  extensionKind: vscode.ExtensionKind,
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.cleanCopilotSessions', async () => {
    // Copilot session files live on the local machine, not the remote server.
    // When the extension runs in the workspace host (e.g., Remote-SSH, devcontainer),
    // os.homedir() returns the remote path — which has no sessions.
    if (extensionKind === vscode.ExtensionKind.Workspace) {
      vscode.window.showWarningMessage(
        'Clean Copilot Sessions works only when the extension runs locally (UI host).\n\n' +
        'When connected to a remote, the extension runs on the server but Copilot sessions live on your local machine.\n\n' +
        'To fix: Run this command while not connected to any remote (local workspace only).',
        'OK'
      );
      return;
    }

    // Discovery with progress so the user knows something is happening
    const workspaces = await vscode.window.withProgress<WorkspaceEntry[]>(
      { location: vscode.ProgressLocation.Notification, title: 'Scanning for Copilot sessions...' },
      async () => discoverWorkspaces(),
    );
    output.appendLine(`[INFO] Discovery found ${workspaces.length} workspace(s) with sessions.`);
    if (workspaces.length === 0) {
      vscode.window.showInformationMessage('No Copilot sessions found.');
      return;
    }

    const picks: SessionPickedItem[] = workspaces.map(ws => ({
      label: ws.id === '__global__' ? '🌐 All global sessions' : `📁 ${ws.label}`,
      description: `${ws.sessions} total (${ws.dbSessions} db, ${ws.fsSessions} files)`,
      id: ws.id,
    }));

    const selected = await vscode.window.showQuickPick<SessionPickedItem>(picks, {
      canPickMany: true,
      placeHolder: 'Select workspaces to clean (multi-select allowed)',
    });
    if (!selected?.length) return;

    const confirm = await vscode.window.showWarningMessage(
      `Delete ${selected.length} workspace${selected.length === 1 ? '' : 's'}?\n\nRestart VS Code after for changes to take effect.`,
      { modal: true },
      'Delete'
    );
    if (confirm !== 'Delete') return;

    let totalKeys = 0;
    let totalChatDirs = 0;
    let totalChatSessions = 0;
    let totalChatEditing = 0;
    let dbErrors = 0;

    // Use id directly — no brittle label matching
    for (const item of selected) {
      const result = await cleanWorkspace(item.id);
      totalKeys += result.dbKeysRemoved > 0 ? result.dbKeysRemoved : 0;
      totalChatDirs += result.chatDirRemoved ? 1 : 0;
      totalChatSessions += result.chatSessionsRemoved ? 1 : 0;
      totalChatEditing += result.chatEditingSessionsRemoved ? 1 : 0;
      if (result.dbError) dbErrors++;
    }

    const msg = dbErrors > 0
      ? `Cleaned ${totalKeys} key(s), removed ${totalChatDirs} chat dir(s), ${totalChatSessions} chatSessions dir(s), ${totalChatEditing} chatEditingSessions dir(s).\n\n⚠ ${dbErrors} workspace(s) had database errors — key removal may be incomplete. Close all Copilot chat sessions and retry.\n\nRestart VS Code for changes to take effect.`
      : `Cleaned ${totalKeys} key(s), removed ${totalChatDirs} chat dir(s), ${totalChatSessions} chatSessions dir(s), ${totalChatEditing} chatEditingSessions dir(s).\n\nRestart VS Code for changes to take effect.`;

    vscode.window.showInformationMessage(msg, 'OK');
  });
}

/** Apply a bundled personality preset to a model's system message replacements. */
export function registerSetModelPersonalityCommand(
  context: vscode.ExtensionContext,
  provider: VllmChatModelProvider,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand(
    'vllm-copilot.setModelPersonality',
    async () => {
      const cfg = await getConfig(context);
      const models = cfg.models || [];

      if (models.length === 0) {
        vscode.window.showInformationMessage(
          'No models are configured yet. Add a model first.'
        );
        return;
      }

      // Step 1: pick the model
      const modelItems = models.map((m) => ({
        label: m.displayName || m.id || '(unnamed)',
        description: m.serverUrl || 'no serverUrl',
        model: m,
      }));

      const modelPick = await vscode.window.showQuickPick(modelItems, {
        title: 'Set Model Personality (step 1/2)',
        placeHolder: 'Select a model',
      });
      if (!modelPick) return;

      // Step 2: discover and pick the personality (bundled + global + legacy .vllm)
      const presets = await discoverPersonalities(context);

      type PersonalityPick = {
        label: string;
        description?: string;
        clear?: boolean;
        sourcePath?: string;
        kind?: vscode.QuickPickItemKind;
      };

      // Resolve which option is currently active from the model's replacements file.
      // A custom file that isn't a known personality still counts as "not default".
      const hasReplacements = !!(modelPick.model.systemMessageReplacementsFile || '').trim();
      const active = await resolveActivePersonality(context, modelPick.model.systemMessageReplacementsFile, presets);
      const isDefaultActive = !hasReplacements;

      const markCurrent = (label: string, description: string | undefined, active: boolean): Pick<PersonalityPick, 'label' | 'description'> => ({
        label: active ? `$(check) ${label}` : label,
        description: active
          ? (description ? `${description} · current` : 'current')
          : description,
      });

      const pickItems: PersonalityPick[] = [
        {
          ...markCurrent(
            'Default (no personality)',
            "Clear replacements — use Copilot's original system prompt",
            isDefaultActive,
          ),
          clear: true,
        },
      ];

      if (presets.length > 0) {
        pickItems.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        for (const p of presets) {
          const isCurrent = !isDefaultActive && active?.name === p.name;
          pickItems.push({
            ...markCurrent(p.name, p.description, isCurrent),
            sourcePath: p.sourcePath,
          });
        }
      }

      const currentLabel = !hasReplacements
        ? 'Default (no personality)'
        : (active?.name ?? modelPick.model.systemMessageReplacementsFile) || 'Default (no personality)';

      const personalityPick = await vscode.window.showQuickPick(pickItems, {
        title: 'Set Model Personality (step 2/2)',
        placeHolder: `Current: ${currentLabel}`,
      });
      if (!personalityPick || personalityPick.kind === vscode.QuickPickItemKind.Separator) return;

      const clear = personalityPick.clear;
      const sourcePath = personalityPick.sourcePath;
      if (!clear && !sourcePath) {
        vscode.window.showWarningMessage('No personality presets found.');
        return;
      }

      try {
        // Applying always materializes the personality as a user-owned copy in
        // global storage — portable across workspaces and immune to extension upgrades.
        const replacementsFile = clear
          ? ''
          : await ensureGlobalPersonality(context, sourcePath!);
        await saveModelConfig({
          ...modelPick.model,
          // Empty string is the explicit clear signal (undefined would preserve the previous value).
          systemMessageReplacementsFile: replacementsFile,
        });
        outputChannel.appendLine(
          `[INFO] Personality presets: ${clear ? 'cleared' : `applied ${sourcePath}`} for ${modelPick.label}`
        );
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to apply personality: ${describeError(err)}`);
        return;
      }

      // The label may carry the "$(check)" icon prefix when the picked preset is
      // the currently-active one — strip it so the message reads cleanly.
      const plainLabel = personalityPick.label.replace(/^\$\(check\)\s*/, '');
      vscode.window.showInformationMessage(
        clear
          ? `Cleared personality for "${modelPick.label}". Using Copilot's original system prompt.`
          : `Applied "${plainLabel}" personality to "${modelPick.label}".`
      );

      // Invalidate the provider's config cache so replacements take effect immediately
      provider.clearCache();
    }
  );
}

/**
 * Update auth (API key + request headers) for all models on a server.
 * Triggered from right-click context menu on a server node in the dashboard.
 */
export function registerUpdateServerAuthCommand(
  _context: vscode.ExtensionContext,
  _provider: VllmChatModelProvider,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.updateServerAuth', async (arg?: any) => {
    // VS Code passes the tree item for context menus; extract serverUrl.
    const serverUrl = typeof arg === 'string' ? arg : arg?.serverUrl;
    if (!serverUrl) {
      vscode.window.showErrorMessage('Server URL not provided.');
      return;
    }

    // Step 1+2: API key + custom headers
    const combinedHeaders = await promptForServerAuth({
      apiKeyTitle: `Update Auth for ${serverUrl} (1/2)`,
      apiKeyPrompt: '(optional) vLLM API key. Sent as "Authorization: Bearer <key>". Leave empty to clear.',
      apiKeyPlaceholder: 'abc123... or leave empty to clear',
      headersTitle: `Update Auth for ${serverUrl} (2/2)`,
      headersPrompt: '(optional) Additional request headers (e.g. for proxy). JSON format or "Name": "Value". Leave empty to clear.',
      headersPlaceholder: '{"CF-Access-Client-Id": "...", "CF-Access-Client-Secret": "..."}  or  "X-API-Key": "abc123"',
    });
    if (combinedHeaders === undefined) return; // cancelled
    const finalHeaders = Object.keys(combinedHeaders).length > 0 ? combinedHeaders : undefined;

    // Update all models pointing to this server
    const config = vscode.workspace.getConfiguration('vllm-copilot');
    const existing: ModelConfig[] = config.get<ModelConfig[]>('models') || [];
    const normalizedUrl = normalizeServerUrl(serverUrl);
    let updated = 0;
    const updatedModels = existing.map(m => {
      if (m.serverUrl && normalizeServerUrl(m.serverUrl) === normalizedUrl) {
        updated++;
        return { ...m, requestHeaders: finalHeaders };
      }
      return m;
    });

    if (updated === 0) {
      vscode.window.showWarningMessage(`No models found for server ${serverUrl}.`);
      return;
    }

    await config.update('models', updatedModels, vscode.ConfigurationTarget.Global);
    _provider.clearCache();
    // Push new headers to the metrics engine so open deep-dive uses fresh auth
    getMetricsEngine(serverUrl)?.setHeaders(finalHeaders ?? {});
    outputChannel.appendLine(`[INFO] Updated auth for ${updated} model(s) on ${serverUrl}.`);
    vscode.window.showInformationMessage(`Updated auth for ${updated} model(s) on ${serverUrl}.`);
  });
}

/**
 * Remove all models associated with a server.
 * Triggered from right-click context menu on a server node in the dashboard.
 */
export function registerRemoveServerCommand(
  _context: vscode.ExtensionContext,
  _provider: VllmChatModelProvider,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.removeServer', async (arg?: any) => {
    // VS Code passes the tree item for context menus; extract serverUrl.
    const serverUrl = typeof arg === 'string' ? arg : arg?.serverUrl;
    const skipConfirm = typeof arg === 'object' && arg?.skipConfirm === true;
    if (!serverUrl) {
      vscode.window.showErrorMessage('Server URL not provided.');
      return;
    }

    const config = vscode.workspace.getConfiguration('vllm-copilot');
    const existing: ModelConfig[] = config.get<ModelConfig[]>('models') || [];
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const filtered = existing.filter(m => !(m.serverUrl && normalizeServerUrl(m.serverUrl) === normalizedUrl));
    const removed = existing.length - filtered.length;

    if (removed === 0) {
      vscode.window.showWarningMessage(`No models found for server ${serverUrl}.`);
      return;
    }

    if (!skipConfirm) {
      const confirm = await vscode.window.showWarningMessage(
        `Remove ${removed} model(s) from ${serverUrl}?`,
        { modal: true },
        'Remove',
        'Cancel',
      );
      if (confirm !== 'Remove') return;
    }

    await config.update('models', filtered, vscode.ConfigurationTarget.Global);
    _provider.clearCache();
    outputChannel.appendLine(`[INFO] Removed ${removed} model(s) from ${serverUrl}.`);
    vscode.window.showInformationMessage(`Removed ${removed} model(s) from ${serverUrl}.`);
  });
}

/**
 * Filter out the single model matching (serverUrl, vllmModelId) from a config
 * array. Never touches sibling models on the same server. Pure helper, exported
 * for testing.
 */
export function removeModelFromConfig(
  existing: ModelConfig[],
  serverUrl: string,
  vllmModelId: string,
): { filtered: ModelConfig[]; removed: number } {
  const normalizedUrl = normalizeServerUrl(serverUrl);
  const filtered = existing.filter(
    m => !(m.serverUrl && normalizeServerUrl(m.serverUrl) === normalizedUrl && resolveVllmModelId(m) === vllmModelId)
  );
  return { filtered, removed: existing.length - filtered.length };
}

/**
 * Remove a single model entry from a server.
 * Triggered from the Server Settings webview "Remove Model" button.
 * Removes only the selected (serverUrl, vllmModelId) entry — never sibling
 * models on the same server.
 */
export function registerRemoveModelCommand(
  _context: vscode.ExtensionContext,
  _provider: VllmChatModelProvider,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.removeModel', async (arg?: any) => {
    const serverUrl = typeof arg === 'string' ? arg : arg?.serverUrl;
    const vllmModelId = typeof arg === 'object' ? arg?.vllmModelId : undefined;
    const skipConfirm = typeof arg === 'object' && arg?.skipConfirm === true;
    if (!serverUrl || !vllmModelId) {
      vscode.window.showErrorMessage('Server URL and model ID are required.');
      return;
    }

    const config = vscode.workspace.getConfiguration('vllm-copilot');
    const existing: ModelConfig[] = config.get<ModelConfig[]>('models') || [];
    const { filtered, removed } = removeModelFromConfig(existing, serverUrl, vllmModelId);

    if (removed === 0) {
      vscode.window.showWarningMessage(`No configured model "${vllmModelId}" found on ${serverUrl}.`);
      return;
    }

    if (!skipConfirm) {
      const confirm = await vscode.window.showWarningMessage(
        `Remove model "${vllmModelId}" from ${serverUrl}?`,
        { modal: true },
        'Remove',
        'Cancel',
      );
      if (confirm !== 'Remove') return;
    }

    await config.update('models', filtered, vscode.ConfigurationTarget.Global);
    _provider.clearCache();
    outputChannel.appendLine(`[INFO] Removed model "${vllmModelId}" from ${serverUrl}.`);
    vscode.window.showInformationMessage(`Removed model "${vllmModelId}" from ${serverUrl}.`);
  });
}

