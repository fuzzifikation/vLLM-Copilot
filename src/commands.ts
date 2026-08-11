/**
 * VS Code command registrations for the extension's user-facing commands.
 *
 * Stable public facade (refactor-plan §2.3): the substantive workflows live in
 * `src/commands/*` (testAndRefresh.ts, personality.ts, addServerFlow.ts, …) and
 * are re-exported here; the thin per-command registrations below stay put.
 * `extension.ts` keeps importing from this root facade.
 */

import * as vscode from 'vscode';
import type { VllmChatModelProvider } from './provider.js';
import { getConfig, buildEndpoint, resolveServerConfig, resolveConfigId, normalizeServerUrl } from './config.js';
import type { ModelConfig } from './config.js';
import { promptForServerAuth } from './commands/serverAuth.js';
import { FileLogger } from './logger.js';
import { describeError } from './messageConverter.js';
import { runDiagnostics, formatReport } from './diagnostics.js';
import {
  discoverWorkspaces,
  cleanWorkspace,
  SessionPickedItem,
  WorkspaceEntry,
} from './sessionManager.js';
import { getMetricsEngine } from './vllmMetrics.js';

// Re-export the extracted workflows so extension.ts and tests keep a single
// stable import surface (matches the autoConfig.ts facade pattern).
export { registerTestAndRefreshModelsCommand, serverFingerprint, groupModelsByServer } from './commands/testAndRefresh.js';
export { registerSetModelPersonalityCommand, personalityApplicableTo } from './commands/personality.js';

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
 * Filter out the single model matching (serverUrl, configId) from a config
 * array, where `configId` is the extension `id` (falling back to the vLLM wire
 * id for legacy entries). Never touches sibling models on the same server.
 * Pure helper, exported for testing.
 */
export function removeModelFromConfig(
  existing: ModelConfig[],
  serverUrl: string,
  configId: string,
): { filtered: ModelConfig[]; removed: number } {
  const normalizedUrl = normalizeServerUrl(serverUrl);
  const filtered = existing.filter(
    m => !(m.serverUrl && normalizeServerUrl(m.serverUrl) === normalizedUrl && resolveConfigId(m) === configId)
  );
  return { filtered, removed: existing.length - filtered.length };
}

/**
 * Remove a single model entry from a server.
 * Triggered from the Server Settings webview "Remove Model" button.
 * Removes only the selected (serverUrl, id) entry — never sibling models on the
 * same server. Accepts the extension `id` (preferred) or the vLLM wire id for
 * legacy callers.
 */
export function registerRemoveModelCommand(
  _context: vscode.ExtensionContext,
  _provider: VllmChatModelProvider,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.removeModel', async (arg?: any) => {
    const serverUrl = typeof arg === 'string' ? arg : arg?.serverUrl;
    const configId = typeof arg === 'object' ? (arg?.id ?? arg?.vllmModelId) : undefined;
    const skipConfirm = typeof arg === 'object' && arg?.skipConfirm === true;
    if (!serverUrl || !configId) {
      vscode.window.showErrorMessage('Server URL and model ID are required.');
      return;
    }

    const config = vscode.workspace.getConfiguration('vllm-copilot');
    const existing: ModelConfig[] = config.get<ModelConfig[]>('models') || [];
    const { filtered, removed } = removeModelFromConfig(existing, serverUrl, configId);

    if (removed === 0) {
      vscode.window.showWarningMessage(`No configured model "${configId}" found on ${serverUrl}.`);
      return;
    }

    if (!skipConfirm) {
      const confirm = await vscode.window.showWarningMessage(
        `Remove model "${configId}" from ${serverUrl}?`,
        { modal: true },
        'Remove',
        'Cancel',
      );
      if (confirm !== 'Remove') return;
    }

    await config.update('models', filtered, vscode.ConfigurationTarget.Global);
    _provider.clearCache();
    outputChannel.appendLine(`[INFO] Removed model "${configId}" from ${serverUrl}.`);
    vscode.window.showInformationMessage(`Removed model "${configId}" from ${serverUrl}.`);
  });
}

