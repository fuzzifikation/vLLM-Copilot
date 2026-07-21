/**
 * VS Code command registrations for the extension's user-facing commands.
 *
 * Each `registerXxxCommand` returns a Disposable, matching the convention used by
 * `registerAddServerModelCommand` (autoConfig.ts). `activate()` wires them up; the
 * command bodies live here so the activation function stays a thin, readable
 * sequence.
 */

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { VllmChatModelProvider } from './provider.js';
import { getConfig, buildEndpoint, resolveServerConfig, resolveVllmModelId } from './config.js';
import type { ModelConfig } from './config.js';
import { pickModelFromServer, saveModelConfig } from './autoConfig.js';
import { FileLogger } from './logger.js';
import { describeError } from './messageConverter.js';
import { runDiagnostics, formatReport } from './diagnostics.js';
import {
  discoverWorkspaces,
  cleanWorkspace,
  SessionPickedItem,
  WorkspaceEntry,
} from './sessionManager.js';
import { loadPersonalityMeta } from './promptReplacer.js';

/**
 * Discover personality preset files in prompt-replacements/ directory.
 * Returns presets that have a valid `meta` block with `name` and `description`.
 * Files in legacy array format (no meta) are silently excluded.
 */
async function discoverPersonalityPresets(
  extensionUri: vscode.Uri,
  presetDir: string,
  outputChannel: vscode.OutputChannel,
): Promise<Array<{ name: string; description: string; fileName: string; sourcePath: string }>> {
  const presetDirPath = path.join(extensionUri.fsPath, presetDir);
  const results: Array<{ name: string; description: string; fileName: string; sourcePath: string }> = [];
  outputChannel.appendLine(`[INFO] Personality presets: scanning ${presetDirPath}`);

  try {
    const entries = await fs.readdir(presetDirPath);
    outputChannel.appendLine(`[INFO] Personality presets: found ${entries.length} entries in ${presetDir}`);
    for (const entry of entries) {
      if (!entry.startsWith('prompt-replacements-') || !entry.endsWith('.json')) continue;

      const filePath = path.join(presetDirPath, entry);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;

      const meta = await loadPersonalityMeta(filePath);
      if (meta) {
        const slug = entry.slice('prompt-replacements-'.length, -'.json'.length);
        results.push({
          name: meta.name,
          description: meta.description,
          fileName: slug,
          sourcePath: filePath,
        });
      }
    }
  } catch (err) {
    outputChannel.appendLine(`[ERROR] Personality presets: cannot read ${presetDirPath}: ${describeError(err)}`);
  }

  outputChannel.appendLine(`[INFO] Personality presets: found ${results.length} valid preset(s) in ${presetDir}`);
  return results;
}

interface FetchModel {
  id: string;
  object: string;
  owned_by: string;
  max_model_len?: number;
  root?: string;
  permission?: unknown[];
}

/**
 * One row of Test & Refresh output. `mismatch` is set only when the model's
 * `vllmModelId` is not on its server; the post-check phase uses it to offer
 * a corrective picker (sharing the picker UX with `addServerModel`) and to
 * persist the corrected id in place via `saveModelConfig`.
 */
interface TestResult {
  label: string;
  description: string;
  detail: string;
  mismatch?: {
    model: ModelConfig;
    serverModels: FetchModel[];
    serverUrl: string;
    vllmModelId: string;
  };
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
 * For each model in settings:
 *  - Validates that serverUrl exists
 *  - Calls /v1/models with auth headers
 *  - Reports server status, model found/missing, and context window
 *
 * Results are shown as individual info/warning messages — one per model —
 * so the user gets immediate feedback for each server.
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

    // Check each model in settings against its server — all queries run in parallel.
    const checks = models.map(async (model): Promise<TestResult> => {
      const id = model.displayName || model.id || resolveVllmModelId(model) || '(unnamed)';
      const vllmModelId = resolveVllmModelId(model) || model.id || '';

      if (!model.serverUrl) {
        return {
          label: `✗ ${id}`,
          description: 'no serverUrl',
          detail: 'Add a serverUrl or run "Add vLLM Server & Model"',
        };
      }

      const { serverUrl, requestHeaders } = resolveServerConfig(model);

      try {
        const resp = await fetch(buildEndpoint(serverUrl, 'v1/models'), {
          headers: { ...(requestHeaders ?? {}) },
          signal: AbortSignal.timeout(10000),
        });

        if (resp.status === 401 || resp.status === 403) {
          return {
            label: `✗ ${id}`,
            description: `auth failed (${resp.status})`,
            detail: `${serverUrl} — check requestHeaders`,
          };
        }

        if (!resp.ok) {
          return {
            label: `✗ ${id}`,
            description: `status ${resp.status}`,
            detail: serverUrl,
          };
        }

        const data: any = await resp.json();
        const serverModels = data.data || [];
        const found = serverModels.find((m: FetchModel) => m.id === vllmModelId || m.root === vllmModelId);

        if (!found) {
          // Defer the corrective picker to the sequential post-check phase so
          // concurrent `saveModelConfig` writes cannot race each other. Carry
          // enough info to render the picker + persist the correction.
          return {
            label: `✗ ${id}`,
            description: 'not found on server',
            detail: `${serverUrl} — check vllmModelId`,
            mismatch: { model, serverModels: serverModels as FetchModel[], serverUrl, vllmModelId },
          };
        }

        const ctx = found.max_model_len ? `${found.max_model_len.toLocaleString()} ctx` : '';
        return {
          label: `✓ ${id}`,
          description: ctx,
          detail: `${serverUrl} (${vllmModelId})`,
        };
      } catch (err) {
        // describeError walks err.cause so TLS/proxy/DNS reasons surface
        // (e.g. "fetch failed ← caused by: ... [UNABLE_TO_VERIFY_LEAF_SIGNATURE]")
        // instead of just "fetch failed", which hides the real problem.
        const msg = describeError(err);
        return {
          label: `✗ ${id}`,
          description: msg,
          detail: serverUrl,
        };
      }
    });

    const results = await Promise.all(checks);

    // Offer to correct mismatched `vllmModelId` values. Done sequentially (not
    // in the parallel check) so concurrent `saveModelConfig` writes cannot
    // race — each call re-reads the config array, mutates one entry, and
    // writes it back; running them serially keeps that atomic per entry.
    // The picker UX is shared with `addServerModel` via `pickModelFromServer`;
    // persistence goes through the same `saveModelConfig` path, so dedup,
    // server/headers preservation, and the BYOK utility default all carry over.
    for (const result of results) {
      if (!result.mismatch) continue;
      const { model, serverModels, serverUrl, vllmModelId } = result.mismatch;
      if (serverModels.length === 0) continue; // different problem — leave row as-is

      const pick = await vscode.window.showWarningMessage(
        `"${vllmModelId}" is not on ${serverUrl}. ${serverModels.length} model(s) available — pick the right one?`,
        'Pick Model'
      );
      if (pick !== 'Pick Model') continue;

      const chosen = await pickModelFromServer(serverModels, serverUrl);
      if (!chosen) continue; // cancelled — keep the failure row

      try {
        await saveModelConfig({ ...model, vllmModelId: chosen });
        // No re-verification: the user just confirmed the id; the next Test &
        // Refresh run will report ✓. Update this row so the modal below shows
        // the corrected state instead of the stale ✗.
        result.label = `✓ ${model.displayName || model.id || chosen} (corrected → ${chosen})`;
        result.description = '';
        result.detail = `${serverUrl} (${chosen}) — saved`;
        result.mismatch = undefined;
        vscode.window.showInformationMessage(`Corrected vllmModelId to "${chosen}" and saved.`);
      } catch (saveErr) {
        vscode.window.showErrorMessage(
          `Failed to save corrected vllmModelId: ${describeError(saveErr)}`
        );
      }
    }

    // Intentional UX: show one modal per model (not a single combined list).
    // This gives immediate visual feedback with ✓/✗ color distinction per model,
    // which is preferred over a single dialog with all results crammed together.
    for (const item of results) {
      const msg = `${item.label}\n${item.description}\n\n${item.detail}`;
      if (item.label.startsWith('✗')) {
        vscode.window.showWarningMessage(msg);
      } else {
        vscode.window.showInformationMessage(msg);
      }
    }

    // If any connection failed, proactively check VS Code's network gating settings.
    // These are almost always at defaults; showing the warning only when at least one
    // connection failed avoids noise for healthy setups while helping corporate/intranet
    // users diagnose IT-pushed settings that break all VS Code networking.
    const anyFailed = results.some((r) => r.label.startsWith('✗'));
    if (anyFailed) {
      const networkWarnings = checkNetworkGatingSettings();
      if (networkWarnings.length > 0) {
        const detail = networkWarnings.join('\n');
        const pick = await vscode.window.showWarningMessage(
          `VS Code network settings may be blocking the connection:\n\n${detail}\n\nThese settings gate the patched fetch that handles proxy routing and OS certificates.`,
          'Open Settings'
        );
        if (pick) {
          await vscode.commands.executeCommand('workbench.action.openSettings', 'http.proxy');
        }
      }

      // Offer a deep diagnostic on the first failed server. This compares
      // platform-native fetch (SChannel on Windows, curl on macOS/Linux) vs
      // Node fetch (VS Code patched fetch), checks DNS/TCP, and inspects the
      // cert chain on TLS errors. The report goes to a dedicated Output
      // channel the user can copy-paste when reporting the issue.
      const firstFailed = models.find((m, i) => results[i]?.label.startsWith('✗'));
      if (firstFailed?.serverUrl) {
        const runDiag = await vscode.window.showWarningMessage(
          'One or more models failed to connect. Run a deep diagnostic?',
          'Run Diagnostic'
        );
        if (runDiag === 'Run Diagnostic') {
          const { requestHeaders: failedHeaders } = resolveServerConfig(firstFailed);
          outputChannel.show(true);
          outputChannel.appendLine('[INFO] Running diagnostics…');
          const report = await runDiagnostics(
            buildEndpoint(firstFailed.serverUrl, 'v1/models'),
            failedHeaders,
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

    // Use id directly — no brittle label matching
    for (const item of selected) {
      const result = await cleanWorkspace(item.id);
      totalKeys += result.dbKeysRemoved;
      totalChatDirs += result.chatDirRemoved ? 1 : 0;
      totalChatSessions += result.chatSessionsRemoved ? 1 : 0;
      totalChatEditing += result.chatEditingSessionsRemoved ? 1 : 0;
    }

    vscode.window.showInformationMessage(
      `Cleaned ${totalKeys} key(s), removed ${totalChatDirs} chat dir(s), ${totalChatSessions} chatSessions dir(s), ${totalChatEditing} chatEditingSessions dir(s).\n\nRestart VS Code for changes to take effect.`,
      'OK'
    );
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

      // Step 2: discover and pick the personality from prompt-replacements/ and .vllm/
      const workspaceFolders = vscode.workspace.workspaceFolders;
      const presetDirs: Array<[string, vscode.Uri]> = [['prompt-replacements', context.extensionUri]];
      if (workspaceFolders?.[0]) {
        presetDirs.push(['.vllm', workspaceFolders[0].uri]);
      }

      const presets = (await Promise.all(
        presetDirs.map(async ([dirName, dir]) => discoverPersonalityPresets(dir, dirName, outputChannel))
      )).flat();

      // Deduplicate by name (meta.name), keeping first occurrence (bundled presets win over .vllm/)
      const seen = new Set<string>();
      const uniquePresets = presets.filter((p) => {
        if (seen.has(p.name)) return false;
        seen.add(p.name);
        return true;
      });

      if (uniquePresets.length === 0) {
        vscode.window.showWarningMessage('No personality presets found.');
        return;
      }

      const personalityPick = await vscode.window.showQuickPick(
        uniquePresets.map((p) => ({
          label: p.name,
          description: p.description,
          fileName: p.fileName,
          sourcePath: p.sourcePath,
        })),
        {
          title: 'Set Model Personality (step 2/2)',
          placeHolder: 'Select a personality',
        }
      );
      if (!personalityPick) return;

      const sourcePath = personalityPick.sourcePath;
      const presetFileName = path.basename(sourcePath);
      outputChannel.appendLine(`[INFO] Personality presets: selected ${sourcePath}`);

      // Destination: .vllm/ at the workspace root (first workspace)
      if (!workspaceFolders?.length) {
        vscode.window.showWarningMessage(
          'No workspace folder is open. Open a folder first so the preset file can be saved to .vllm/.'
        );
        return;
      }

      const targetDir = path.join(workspaceFolders[0].uri.fsPath, '.vllm');
      const targetPath = path.join(targetDir, presetFileName);

      // Copy to .vllm/ (skip if source is already the target)
      try {
        await fs.mkdir(targetDir, { recursive: true });
        if (sourcePath !== targetPath) {
          const content = await fs.readFile(sourcePath, 'utf-8');
          await fs.writeFile(targetPath, content, 'utf-8');
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to copy preset file: ${describeError(err)}`
        );
        return;
      }

      // Build the relative path from workspace root → .vllm/prompt-replacements-{slug}.json
      const relativePath = path.join('.vllm', path.basename(targetPath));

      // Update the model's systemMessageReplacementsFile
      try {
        await saveModelConfig({
          ...modelPick.model,
          systemMessageReplacementsFile: relativePath,
        });
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to save model config: ${describeError(err)}`
        );
        return;
      }

      vscode.window.showInformationMessage(
        `Applied "${personalityPick.label}" personality to "${modelPick.label}".\nPreset saved to ${relativePath}`
      );

      // Invalidate the provider's config cache so replacements take effect immediately
      provider.clearCache();
    }
  );
}

/**
 * Configure server settings - opens VS Code settings filtered to show relevant model configs.
 */
export function registerConfigureServerCommand(
  context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.configureServer', async (serverUrl?: string) => {
    try {
      const config = await getConfig(context);

      // Get unique server URLs
      const servers = [...new Set(config.models.map(m => m.serverUrl).filter((s): s is string => !!s))];

      if (servers.length === 0) {
        vscode.window.showInformationMessage('No servers configured. Use "Add vLLM Server & Model" to add one.');
        return;
      }

      // If no server URL provided, let user pick
      const selectedServer = serverUrl ?? (await vscode.window.showQuickPick(
        servers.map(url => ({ label: url, value: url })),
        { placeHolder: 'Select server to configure' }
      ))?.value;

      if (!selectedServer) return;

      // Open settings filtered to show vllm-copilot.models
      await vscode.commands.executeCommand('workbench.action.openSettings', 'vllm-copilot.models');

      outputChannel.appendLine(`[INFO] Opened settings for server: ${selectedServer}`);
    } catch (err) {
      outputChannel.appendLine(`[ERROR] Configure server failed: ${err instanceof Error ? err.message : String(err)}`);
      vscode.window.showErrorMessage('Failed to open settings.');
    }
  });
}
