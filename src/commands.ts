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
import { getConfig, buildEndpoint, resolveServerConfig, resolveConfigId, normalizeServerUrl, resolveVllmModelId, sanitizeRequestHeaders, mergeAuthHeaders, sameHeaders } from './config.js';
import type { ModelConfig } from './config.js';
import type { ServerEntry } from './serverRegistry.js';
import { patchModelConfig, readModels, readServers, writeModels, writeServers } from './configStore.js';
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
import { updateMetricsEngineHeaders } from './vllmMetrics.js';
import { updateDeepDiveTitle } from './deepDiveView.js';
import { resetUsage, getServersWithUsage } from './usageStore.js';
import { isOpenRouterUrl } from './openRouter.js';

// Re-export the extracted workflows so extension.ts and tests keep a single
// stable import surface (matches the autoConfig.ts facade pattern).
export { registerTestAndRefreshModelsCommand, groupModelsByServer } from './commands/testAndRefresh.js';
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
      description: resolveServerConfig(m, config.servers)?.serverUrl || 'no server',
      model: m,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      ignoreFocusOut: true,
      placeHolder: 'Select a model to diagnose',
    });
    if (!picked) return;

    // Resolve the model's canonical URL and request headers so the diagnostic
    // tests the same authenticated, normalized request the extension makes —
    // not a bare GET (which would 401 on auth-required servers) and not a raw
    // URL that still carries a redundant `/v1` suffix.
    const resolved = resolveServerConfig(picked.model, config.servers);
    if (!resolved) {
      vscode.window.showWarningMessage(
        `Model "${picked.label}" references server "${picked.model.server}", which is not registered. Add the server first.`
      );
      return;
    }
    const { serverUrl: canonicalUrl, requestHeaders } = resolved;
    const url = buildEndpoint(canonicalUrl, 'v1/models');
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
      ignoreFocusOut: true,
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
 * Header-merge helpers live in config.ts (shared with the Add Server flow, which
 * rotates credentials on a registry entry). Re-exported for the existing
 * command-side tests that import them from this facade.
 */
export { mergeAuthHeaders, sameHeaders };

/**
 * Update auth (API key + request headers) for all models on a server.
 * Triggered from right-click context menu on a server node in the dashboard.
 */
export function registerUpdateServerAuthCommand(
  _context: vscode.ExtensionContext,
  _provider: VllmChatModelProvider,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.updateServerAuth', async (arg?: any, initialHeaders?: Record<string, string>) => {
    // VS Code passes the tree item for context menus; extract the server URL.
    const serverUrl = typeof arg === 'string' ? arg : arg?.serverUrl;
    if (!serverUrl) {
      vscode.window.showErrorMessage('Server URL not provided.');
      return;
    }

    // Auth lives on the server registry ENTRY now, not on models. The command
    // contract is still URL-addressed (tree items, the Add Server flow), and §5
    // keeps that scope URL-wide: every entry on this URL is a write target —
    // usually one, but two credential identities on the same URL both rotate
    // together, exactly as the pre-registry merge hit every model on the URL.
    const servers = readServers();
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const targets = servers.filter(s => normalizeServerUrl(s.serverUrl) === normalizedUrl);
    if (targets.length === 0) {
      vscode.window.showWarningMessage(`No registered server found for ${serverUrl}. Add the server first.`);
      return;
    }

    // Step 1+2: API key + custom headers. If the caller (e.g. the OpenRouter Add
    // flow) already collected credentials, REUSE them — never re-prompt and
    // discard the first key. Otherwise prompt, provider-aware: OpenRouter
    // requires the key (chat bills per account), generic servers keep it optional.
    let combinedHeaders: Record<string, string>;
    if (initialHeaders && Object.keys(initialHeaders).length > 0) {
      combinedHeaders = sanitizeRequestHeaders(initialHeaders);
    } else {
      const collected = await promptForServerAuth({
        apiKeyTitle: `Update Auth for ${serverUrl} (1/2)`,
        apiKeyPrompt: isOpenRouterUrl(serverUrl)
          ? 'OpenRouter API key. Sent as "Authorization: Bearer <key>". Get one at https://openrouter.ai/keys. Required.'
          : '(optional) vLLM API key. Sent as "Authorization: Bearer <key>". Leave empty to keep the current value.',
        apiKeyPlaceholder: isOpenRouterUrl(serverUrl) ? 'sk-or-v1-...' : 'abc123... or leave empty to keep',
        requireApiKey: isOpenRouterUrl(serverUrl),
        headersTitle: `Update Auth for ${serverUrl} (2/2)`,
        headersPrompt: '(optional) Additional request headers (e.g. for proxy). JSON format or "Name": "Value". Leave empty to keep the current value.',
        headersPlaceholder: '{"CF-Access-Client-Id": "...", "CF-Access-Client-Secret": "..."}  or  "X-API-Key": "abc123"',
      });
      if (collected === undefined) {
        outputChannel.appendLine(`[INFO] Update Auth cancelled for ${serverUrl} — no credentials entered.`);
        return; // cancelled
      }
      combinedHeaders = sanitizeRequestHeaders(collected);
    }

    // Re-read AFTER the prompt: a settings edit made while it was open must
    // not be clobbered by a stale snapshot. MERGE the newly entered auth into
    // each target entry's existing requestHeaders — never replace wholesale, so
    // rotating only the key can't wipe custom proxy headers (and vice versa).
    // Fields left empty keep their current value (clearing is settings.json).
    const currentServers = readServers();
    // Re-resolve by URL (not the pre-prompt ids): an entry added while the
    // prompt was open belongs to this server too.
    const targetIdx = currentServers
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => normalizeServerUrl(s.serverUrl) === normalizedUrl);
    if (targetIdx.length === 0) {
      const names = targets.map(t => t.id).join(', ');
      vscode.window.showWarningMessage(`Server "${names}" is no longer registered — nothing updated.`);
      return;
    }
    const updatedServers = currentServers.slice();
    const transitions: Array<{ from: Record<string, string> | undefined; to: Record<string, string> }> = [];
    for (const { i } of targetIdx) {
      const current = currentServers[i];
      // Sanitize BOTH sides. Stored headers come from hand-editable settings and
      // may carry blocked names or a second spelling (`authorization` next to
      // the `Authorization` this prompt produces). Merging raw would persist both
      // spellings and send a doubled auth header. Sanitizing the merge result
      // makes the freshly entered value win the collision (last occurrence wins).
      const existingHeaders = sanitizeRequestHeaders(current.requestHeaders ?? {});
      const merged = mergeAuthHeaders(existingHeaders, combinedHeaders) ?? existingHeaders;
      const nextHeaders = sanitizeRequestHeaders(merged);
      if (!sameHeaders(nextHeaders, existingHeaders)) {
        updatedServers[i] = { ...current, requestHeaders: nextHeaders };
        transitions.push({ from: existingHeaders, to: nextHeaders });
      }
    }
    if (transitions.length === 0) {
      outputChannel.appendLine(`[INFO] Update Auth: no changes for ${serverUrl} — fields left empty keep their current values.`);
      vscode.window.showInformationMessage(`No auth changes for ${serverUrl}. Enter a new key or headers to update.`);
      return;
    }

    await writeServers(updatedServers);
    _provider.clearCache();
    // Push the new headers to the metrics engines so an open deep-dive uses
    // fresh auth. Update-if-present only: Update Auth must not create a
    // zero-subscriber engine (an engine only exists when a dashboard/deep-dive
    // is subscribed). One transition per changed identity — engines are keyed
    // by fingerprint, so each old→new pair re-keys exactly its own engine.
    for (const t of transitions) {
      updateMetricsEngineHeaders(serverUrl, t.from, t.to);
    }
    const ids = targetIdx.map(({ s }) => `"${s.id}"`).join(', ');
    outputChannel.appendLine(`[INFO] Updated auth for server ${serverUrl} (entries ${ids}).`);
    vscode.window.showInformationMessage(`Updated auth for ${serverUrl}.`);
  });
}

/**
 * Apply (or clear) the display name on the server registry entry matching the
 * given server URL. Pure helper, exported for testing.
 *
 * The name labels "the box" — the dashboard tree shows it instead of the bare
 * host. An empty/whitespace `displayName` CLEARS: the entry loses the key
 * entirely (absent means "show the URL again"; persisting `''` would be a bug).
 * An entry whose value already equals the target is left untouched so an
 * unchanged registry produces no write.
 */
export function applyServerDisplayName(
  servers: ServerEntry[],
  serverUrl: string,
  displayName: string,
): { servers: ServerEntry[]; matched: number; changed: number } {
  const normalizedUrl = normalizeServerUrl(serverUrl);
  const trimmed = displayName.trim();
  let matched = 0;
  let changed = 0;
  const nextServers = servers.map(s => {
    if (normalizeServerUrl(s.serverUrl) !== normalizedUrl) return s;
    matched++;
    if ((s.displayName ?? '') === trimmed) return s; // no-op — nothing changed
    changed++;
    const next = { ...s };
    if (trimmed === '') delete next.displayName;
    else next.displayName = trimmed;
    return next;
  });
  return { servers: nextServers, matched, changed };
}

/**
 * Rename a server for display: sets `displayName` on the server registry entry
 * for the given server URL. The Dashboard tree shows that name instead of the
 * bare host; empty input clears it (the URL is shown again).
 * Triggered from right-click context menu on a server node in the dashboard.
 * Not applicable to OpenRouter — openrouter.ai is a fixed managed relay.
 */
export function registerRenameServerCommand(
  _context: vscode.ExtensionContext,
  provider: VllmChatModelProvider,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.renameServer', async (arg?: any) => {
    // VS Code passes the tree item for context menus; extract the server URL.
    const serverUrl = typeof arg === 'string' ? arg : arg?.serverUrl;
    if (!serverUrl) {
      vscode.window.showErrorMessage('Server URL not provided.');
      return;
    }

    // The registry entry owns the name. A command arg identifies a SERVER, so
    // reject when no entry matches — never silently rename nothing.
    const servers = readServers();
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const entry = servers.find(s => normalizeServerUrl(s.serverUrl) === normalizedUrl);
    if (!entry) {
      vscode.window.showWarningMessage(`No registered server found for ${serverUrl}.`);
      return;
    }
    // Never rename OpenRouter: the relay label is fixed. Check the entry's
    // declared type (a non-openrouter.ai relay URL counts too) — the URL check
    // alone would miss custom OpenRouter-compatible endpoints.
    if (isOpenRouterUrl(serverUrl) || entry.serverType === 'openrouter') {
      vscode.window.showInformationMessage(
        'Rename Server does not apply to OpenRouter — openrouter.ai is a fixed managed relay.'
      );
      return;
    }

    // Pre-prompt read serves ONLY the input prefill — the authoritative read
    // happens after the await below, so a settings edit made while the prompt
    // is open is never clobbered by a stale snapshot (same pattern as Update
    // Auth, which also reads after its prompts).
    const current = entry.displayName?.trim() ?? '';

    const name = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: 'Rename Server',
      prompt: `Display name for ${serverUrl} in the vLLM Dashboard. Empty clears the name.`,
      placeHolder: 'e.g. IT Server for GLM5.2',
      value: current,
    });
    if (name === undefined) {
      outputChannel.appendLine(`[INFO] Rename Server cancelled for ${serverUrl}.`);
      return; // cancelled
    }

    // Re-read AFTER the prompt: the registry may have changed while it was open.
    const existingServers = readServers();
    const { servers: nextServers, matched, changed } = applyServerDisplayName(existingServers, serverUrl, name);
    if (matched === 0) {
      // Distinct from no-op: the entry vanished mid-prompt — a stale tree item
      // or a programmatic call with a wrong URL should fail loudly.
      vscode.window.showWarningMessage(`No registered server found for ${serverUrl}.`);
      return;
    }
    if (changed === 0) {
      vscode.window.showInformationMessage(`No changes for ${serverUrl}.`);
      return;
    }

    await writeServers(nextServers);
    provider.clearCache();
    const trimmed = name.trim();
    // Retitle any open Deep-Dive panels for this server immediately — without
    // this they keep the old label until closed and reopened.
    updateDeepDiveTitle(serverUrl, trimmed || undefined);
    if (trimmed) {
      outputChannel.appendLine(`[INFO] Renamed server ${serverUrl} to "${trimmed}" (id "${entry.id}").`);
      vscode.window.showInformationMessage(`Server renamed to "${trimmed}".`);
    } else {
      outputChannel.appendLine(`[INFO] Cleared display name for ${serverUrl} (id "${entry.id}").`);
      vscode.window.showInformationMessage(`Display name cleared — showing the URL again.`);
    }
  });
}

/**
 * Remove a server registry entry.
 * Triggered from right-click context menu on a server node in the dashboard.
 *
 * REFUSES while any model still references the server id — removing the entry
 * would strand those models on a dangling reference. The user removes the
 * models first (Remove Model), then the server.
 */
export function registerRemoveServerCommand(
  _context: vscode.ExtensionContext,
  _provider: VllmChatModelProvider,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.removeServer', async (arg?: any) => {
    // VS Code passes the tree item for context menus; extract the server URL.
    const serverUrl = typeof arg === 'string' ? arg : arg?.serverUrl;
    const skipConfirm = typeof arg === 'object' && arg?.skipConfirm === true;
    if (!serverUrl) {
      vscode.window.showErrorMessage('Server URL not provided.');
      return;
    }

    const servers = readServers();
    const normalizedUrl = normalizeServerUrl(serverUrl);
    const entries = servers.filter(s => normalizeServerUrl(s.serverUrl) === normalizedUrl);
    if (entries.length === 0) {
      vscode.window.showWarningMessage(`No registered server found for ${serverUrl}.`);
      return;
    }

    // Refuse while referenced: models point at entries BY ID, so dropping an
    // entry would break every one of them at once. The command is URL-scoped
    // (§5), so every entry on the URL is in play — one referenced entry
    // refuses the whole removal, and the dialog names the concrete targets.
    const allModels = readModels();
    const entryIds = new Set(entries.map(e => e.id));
    const referencing = allModels.filter(m => entryIds.has(m.server));
    if (referencing.length > 0) {
      const names = referencing.map(m => m.displayName || m.id).join(', ');
      outputChannel.appendLine(
        `[WARN] Remove Server refused for ${serverUrl} (ids ${[...entryIds].map(id => `"${id}"`).join(', ')}) — still referenced by ${referencing.length} model(s): ${names}.`
      );
      vscode.window.showWarningMessage(
        `Server "${entries[0].displayName?.trim() || serverUrl}" is still used by ${referencing.length} model(s): ${names}. Remove those models first (Remove Model), then remove the server.`
      );
      return;
    }

    if (!skipConfirm) {
      const confirm = await vscode.window.showWarningMessage(
        `Remove server ${serverUrl}? No models reference it${entries.length > 1 ? ` (${entries.length} registry entries on this URL)` : ''}.`,
        { modal: true },
        'Remove',
        'Cancel',
      );
      if (confirm !== 'Remove') return;
    }

    // Re-read for the write: the registry may have changed while the confirm
    // dialog was open. Match by id set (not stale indexes) so a concurrent
    // edit can't drop the wrong entries.
    const currentServers = readServers();
    const stillThere = currentServers.filter(s => entryIds.has(s.id));
    if (stillThere.length === 0) {
      vscode.window.showInformationMessage(`Server ${serverUrl} was already removed.`);
      return;
    }
    // References re-checked too: a concurrent Add flow may have pointed a model
    // at one of these entries while the confirm dialog was open.
    const nowReferencing = readModels().filter(m => entryIds.has(m.server));
    if (nowReferencing.length > 0) {
      const names = nowReferencing.map(m => m.displayName || m.id).join(', ');
      outputChannel.appendLine(
        `[WARN] Remove Server aborted for ${serverUrl} — now referenced by ${nowReferencing.length} model(s): ${names}.`
      );
      vscode.window.showWarningMessage(
        `Server ${serverUrl} is now used by ${nowReferencing.length} model(s): ${names}. Removal cancelled — remove those models first.`
      );
      return;
    }
    await writeServers(currentServers.filter(s => !entryIds.has(s.id)));
    _provider.clearCache();
    outputChannel.appendLine(`[INFO] Removed server ${serverUrl} (${stillThere.map(s => `id "${s.id}"`).join(', ')}).`);
    vscode.window.showInformationMessage(`Removed server ${serverUrl}.`);
  });
}

/**
 * Filter out the single model matching (server entry id, configId) from a
 * config array. `configId` is the extension `id` (falling back to the vLLM
 * wire id for legacy entries). Never touches sibling models on the same
 * server. Pure helper, exported for testing.
 */
export function removeModelFromConfig(
  existing: ModelConfig[],
  server: string,
  configId: string,
): { filtered: ModelConfig[]; removed: number } {
  const filtered = existing.filter(
    m => !(m.server === server && resolveConfigId(m) === configId)
  );
  return { filtered, removed: existing.length - filtered.length };
}

/**
 * Remove a single model entry from a server.
 * Triggered from the Server Settings webview "Remove Model" button — the only
 * caller. The webview confirms the removal with the user before posting, so
 * there is no command-side modal. Removes only the selected (entry, id)
 * model — never sibling models on the same server. Accepts the extension
 * `id` (preferred) or the vLLM wire id for legacy entries.
 */
export function registerRemoveModelCommand(
  _context: vscode.ExtensionContext,
  _provider: VllmChatModelProvider,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.removeModel', async (arg?: { server?: string; id?: string }) => {
    const server = arg?.server;
    const configId = arg?.id;
    if (!server || !configId) {
      vscode.window.showErrorMessage('Server and model ID are required.');
      return;
    }

    const existing = readModels();
    const { filtered, removed } = removeModelFromConfig(existing, server, configId);

    if (removed === 0) {
      vscode.window.showWarningMessage(`No configured model "${configId}" found on server "${server}".`);
      return;
    }

    await writeModels(filtered);
    _provider.clearCache();
    outputChannel.appendLine(`[INFO] Removed model "${configId}" from server "${server}".`);
    vscode.window.showInformationMessage(`Removed model "${configId}" from server "${server}".`);
  });
}

/**
 * Reset accumulated usage counters.
 *
 * Triggered from the "Token Usage and Cost" node's context menu (arg =
 * `{ serverUrl }`) or from the command palette (no arg → QuickPick scope).
 * Clears all-time and daily totals for the chosen scope. The Last Request
 * node is NOT cleared — it remains the useful last prompt.
 */
export function registerResetUsageCommand(outputChannel: vscode.OutputChannel): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.resetUsage', async (arg?: any) => {
    const serverUrl = typeof arg === 'object' && arg ? arg.serverUrl : undefined;
    if (serverUrl) {
      const confirm = await vscode.window.showWarningMessage(
        `Reset all accumulated usage for ${serverUrl}? This clears all-time and daily totals for every model on this server.`,
        { modal: true },
        'Reset',
        'Cancel',
      );
      if (confirm !== 'Reset') return;
      resetUsage({ serverUrl: normalizeServerUrl(serverUrl) });
      outputChannel.appendLine(`[INFO] Reset usage for ${serverUrl}.`);
      vscode.window.showInformationMessage(`Usage reset for ${serverUrl}.`);
      return;
    }

    // Palette path: pick a scope.
    const servers = getServersWithUsage();
    const items = [
      { label: 'All servers', description: 'Reset usage for every configured server', scope: 'all' as const },
      ...servers.map(s => ({ label: s, description: 'Reset usage for this server', scope: { serverUrl: s } as const })),
    ];
    if (items.length === 1) {
      vscode.window.showInformationMessage('No usage recorded yet.');
      return;
    }
    const picked = await vscode.window.showQuickPick(items, { ignoreFocusOut: true, placeHolder: 'Reset usage for…' });
    if (!picked) return;
    const confirm = await vscode.window.showWarningMessage(
      `Reset usage for ${picked.label}?`,
      { modal: true },
      'Reset',
      'Cancel',
    );
    if (confirm !== 'Reset') return;
    resetUsage(picked.scope);
    outputChannel.appendLine(`[INFO] Reset usage for ${picked.label}.`);
    vscode.window.showInformationMessage(`Usage reset for ${picked.label}.`);
  });
}

/**
 * Configure per-model cost rates for the dashboard Token Usage tracker.
 *
 * Triggered from the Token Usage node's context menu ("Set Cost…", arg =
 * `{ serverUrl }`). Guides the user through: model quickpick → three per-1M
 * rate inputs (input / output / cachedInput, prefilled from any existing
 * `cost`) → currency label quickpick (USD / AI Credits / custom). Writes the
 * `cost` block via {@link patchModelConfig}, so the settings change fires the
 * dashboard's config-change handler and the cost appears without a reload.
 *
 * Cost is per MODEL — the user sums costs manually (see usageStore docs).
 */
export function registerConfigureCostCommand(
  _context: vscode.ExtensionContext,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.configureCost', async (arg?: any) => {
    const serverUrl = typeof arg === 'object' && arg ? arg.serverUrl : undefined;
    if (!serverUrl) {
      vscode.window.showErrorMessage('Server URL not provided.');
      return;
    }
    const normalized = normalizeServerUrl(serverUrl);
    const models = readModels();
    const servers = readServers();
    // The usage node is URL-keyed but may span several credential identities —
    // offer every model on any entry of this URL (§5: URL-wide scope).
    const serverIds = new Set(servers.filter(s => normalizeServerUrl(s.serverUrl) === normalized).map(s => s.id));
    const serverModels = models.filter(m => serverIds.has(m.server));
    if (serverModels.length === 0) {
      vscode.window.showWarningMessage(`No configured models found on ${serverUrl}.`);
      return;
    }

    const picked = await vscode.window.showQuickPick(
      serverModels.map(m => ({
        label: m.displayName || m.id || resolveVllmModelId(m) || '(unnamed)',
        description: resolveVllmModelId(m),
        model: m,
      })),
      { ignoreFocusOut: true, placeHolder: 'Select a model to set per-1M cost rates' },
    );
    if (!picked) return;

    const model = picked.model;
    const configId = resolveConfigId(model);
    if (!configId) {
      vscode.window.showWarningMessage(`Model "${picked.label}" has no config id; cannot set cost.`);
      return;
    }
    const existing = model.cost ?? {};
    const currencyNow = existing.currency ?? 'USD';

    // Rate inputs, prefilled from the existing cost block. Blank/0 = unpriced.
    const numOrZero = (v: string | undefined): number => {
      const n = Number(v);
      return !isNaN(n) && n >= 0 ? n : 0;
    };
    const askRate = async (value: number | undefined, prompt: string): Promise<string | undefined> => {
      return vscode.window.showInputBox({
        prompt,
        ignoreFocusOut: true,
        value: value !== undefined && value > 0 ? String(value) : '',
        placeHolder: '0 = unpriced',
        validateInput: v => (v === '' || (!isNaN(Number(v)) && Number(v) >= 0) ? undefined : 'Enter a non-negative number'),
      });
    };

    const input = await askRate(existing.input, `Input cost per 1M tokens (${currencyNow}) — fresh, uncached input.`);
    if (input === undefined) return;
    const output = await askRate(existing.output, `Output cost per 1M tokens (${currencyNow}) — includes reasoning tokens.`);
    if (output === undefined) return;
    const cachedInput = await askRate(existing.cachedInput, `Cache-read input cost per 1M tokens (${currencyNow}).`);
    if (cachedInput === undefined) return;

    let currency = currencyNow;
    const curPick = await vscode.window.showQuickPick(
      ['USD', 'AI Credits', 'Other…'].map(label => ({ label })),
      { ignoreFocusOut: true, placeHolder: `Currency label (currently ${currencyNow})` },
    );
    if (curPick === undefined) return;
    if (curPick.label === 'Other…') {
      const custom = await vscode.window.showInputBox({ ignoreFocusOut: true, prompt: 'Currency label (display only)', value: currencyNow });
      if (custom === undefined) return;
      if (custom.trim()) currency = custom.trim();
    } else {
      currency = curPick.label;
    }

    const cost = {
      input: numOrZero(input),
      output: numOrZero(output),
      cachedInput: numOrZero(cachedInput),
      currency,
    };
    await patchModelConfig({ id: configId, server: model.server }, { cost });
    outputChannel.appendLine(`[INFO] Set cost for ${picked.label} (${currency}): in ${cost.input}, out ${cost.output}, cached-in ${cost.cachedInput} per 1M.`);
    vscode.window.showInformationMessage(`Cost set for ${picked.label}.`);
  });
}

