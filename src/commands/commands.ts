/**
 * VS Code command registrations for the extension's user-facing commands.
 *
 * Stable public facade: the substantive workflows live in
 * `src/commands/*` (testAndRefresh.ts, personality.ts, addServerFlow.ts, …) and
 * are re-exported here; the thin per-command registrations below stay put.
 * `extension.ts` keeps importing from this root facade.
 */

import * as vscode from 'vscode';
import type { VllmChatModelProvider } from '../provider/provider.js';
import { getConfig, buildEndpoint, resolveServerConfig, resolveConfigId, normalizeServerUrl, resolveVllmModelId, sanitizeRequestHeaders, mergeAuthHeaders, sameHeaders, findModelConfigIndex } from '../state/config.js';
import { firstEntryById } from '../state/serverRegistry.js';
import { patchModelConfig, readModels, readServers, writeModels, writeServers } from '../state/configStore.js';
import { promptForServerAuth } from './serverAuth.js';
import { FileLogger } from '../shared/logger.js';
import { describeError } from '../provider/messageConverter.js';
import { runDiagnostics, formatReport } from '../ui/diagnostics.js';
import {
  clean,
  discoverWorkspaces,
  maintainAgentStore,
  ALL_ID,
  GLOBAL_ID,
  type WorkspaceEntry,
} from '../shared/sessionManager.js';
import { refreshEngineHeaders } from '../ui/vllmMetrics.js';
import { updateDeepDiveTitle } from '../ui/deepDiveView.js';
import { resetUsage, getServersWithUsage } from '../usage/usageStore.js';
import { isOpenRouterUrl } from '../state/config.js';

/**
 * Run a settings write so a rejection never escapes as VS Code's anonymous
 * "command failed" notification (CR-48). The user gets a named error toast and
 * the Output channel gets the `[ERROR]` line — the same honesty vocabulary the
 * Add Server flow wrote for this exact failure (`reportEntryWriteFailure`).
 * `configStore` propagates write errors on purpose; every caller that then
 * reports success must funnel through here. Returns false when the write
 * failed — callers must stop and must NOT report success or clear caches.
 */
async function attemptWrite(
  outputChannel: vscode.OutputChannel,
  label: string,
  write: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    outputChannel.appendLine(`[ERROR] ${label}: settings write failed - ${detail}`);
    void vscode.window.showErrorMessage(
      `vLLM-Copilot: ${label} failed - settings unchanged. ${detail}`
    );
    return false;
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
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.diagnoseConnection', async () => {
    const config = await getConfig();
    const models = config.models;

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
      vscode.window.showErrorMessage(`Could not open log file at: ${logPath} - ${reason}`);
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

// ── Clean Copilot Sessions ──────────────────────────────────────────────────

/** The memory options appended below a separator in the workspace picker. */
const REPO_MEMORY_OPTION = '__repo_memory__';
const USER_MEMORY_OPTION = '__user_memory__';
const UNATTRIBUTED_ID = '__unattributed__';
const CATALOG_MAINTENANCE_ID = '__catalog_maintenance__';

type SessionPick = vscode.QuickPickItem & { id?: string };

/**
 * Discover and wipe Copilot/VS Code session residue for the chosen workspaces.
 *
 * This is a security cleanup, not a disk cleaner: it removes the conversation
 * text in the Copilot catalog (`session-store.db`) and its full-text index, not
 * just the session lists. See `shared/sessionManager.ts` for the storage map and
 * for why the compaction result is reported instead of assumed.
 */
export function registerCleanSessionsCommand(
  output: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.cleanCopilotSessions', async () => {
    // Copilot session files live on the local machine, not the remote server.
    // A remote workspace extension would derive the remote user-data root and
    // find none of the local sessions, so refuse before touching storage.
    if (vscode.env.remoteName !== undefined) {
      vscode.window.showWarningMessage(
        'Clean Copilot Sessions works only in a local window.\n\n' +
        'In a remote window, this extension runs on the workspace host but Copilot sessions live on your local machine.\n\n' +
        'Run this command while not connected to any remote.',
        'OK'
      );
      return;
    }

    let discovery: Awaited<ReturnType<typeof discoverWorkspaces>>;
    try {
      discovery = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Scanning for Copilot sessions...' },
        async () => discoverWorkspaces(),
      );
    } catch (err) {
      output.appendLine(`[ERROR] Cannot scan Copilot sessions: ${err instanceof Error ? err.message : String(err)}`);
      vscode.window.showErrorMessage('Cannot scan Copilot sessions. No data was changed; see the Output channel.');
      return;
    }
    const { workspaces, unattributed, catalogPresent, userMemoryPresent, orphanedRows } = discovery;
    output.appendLine(`[INFO] Discovery found ${workspaces.length} workspace(s) and ${unattributed.conversations} unattributed catalog conversation(s).`);
    const hasSessions = workspaces.some(ws => ws.conversations > 0 || ws.fsSessions > 0) || unattributed.conversations > 0;
    const hasMemory = userMemoryPresent || workspaces.some(ws => ws.id !== GLOBAL_ID && ws.conversations === 0 && ws.fsSessions === 0);
    if (!hasSessions && !hasMemory && !catalogPresent) {
      vscode.window.showInformationMessage('No Copilot sessions found.');
      return;
    }

    const picks: SessionPick[] = workspaces.map(ws => ({
      label: ws.id === GLOBAL_ID ? '🌐 All global sessions' : `📁 ${ws.label}`,
      // Conversations and files are different units and stay separate: adding
      // 650 files to 41 conversations and calling the sum a "total" reads as
      // 691 chats, and this is the list someone decides what to delete from.
      description: ws.conversations + ws.fsSessions === 0
        ? 'Repo memory only'
        : `${ws.conversations} conversation(s)${ws.fsSessions > 0 ? `, ${ws.fsSessions} file(s)` : ''}`,
      id: ws.id,
    }));
    if (unattributed.conversations > 0) {
      picks.push({
        label: '$(question) Unattributed catalog sessions',
        description: `${unattributed.conversations} conversation(s), catalog only; no workspace files`,
        id: UNATTRIBUTED_ID,
      });
    }
    if (catalogPresent) {
      picks.push(
        { kind: vscode.QuickPickItemKind.Separator, label: 'Catalog maintenance' },
        {
          label: '$(database) Maintain Copilot catalog',
          description: 'Rebuild search index and compact database; does not delete conversations',
          id: CATALOG_MAINTENANCE_ID,
        },
      );
    }
    // Memory is opt-in and OFF by default: the base action is already a delete,
    // and silently widening a destructive command is the behaviour being fixed.
    if (hasSessions || hasMemory) picks.push(
      {
        kind: vscode.QuickPickItemKind.Separator,
        label: 'Also delete Copilot memory (optional)',
      },
      {
        label: `$(trash) Repo memory for the selected workspace(s)`,
        description: 'Copilot notes for the selected workspace(s)',
        id: REPO_MEMORY_OPTION,
      },
      {
        label: `$(globe) Global Copilot user memory`,
        description: 'Machine-wide — affects EVERY workspace, not just the selection',
        id: USER_MEMORY_OPTION,
      },
    );
    if (hasSessions || orphanedRows > 0) picks.push(
      {
        kind: vscode.QuickPickItemKind.Separator,
        label: 'Nuke everything (careful)',
      },
      {
        label: `$(warning) EVERY conversation on this machine`,
        description: orphanedRows > 0
          ? `The whole catalog, including ${orphanedRows} orphaned row(s) — cannot be undone`
          : 'The whole Copilot catalog, every project — cannot be undone',
        id: ALL_ID,
      },
    );

    const selected = await vscode.window.showQuickPick<SessionPick>(picks, {
      canPickMany: true,
      ignoreFocusOut: true,
      placeHolder: 'Select workspaces to clean (multi-select allowed)',
    });
    if (!selected?.length) return;

    const chosen = selected.filter((s): s is SessionPick & { id: string } => !!s.id);
    if (chosen.some(s => s.id === CATALOG_MAINTENANCE_ID)) {
      if (chosen.length !== 1) {
        vscode.window.showWarningMessage('Select catalog maintenance on its own; nothing was changed.', 'OK');
        return;
      }
      const maintenance = await maintainAgentStore();
      const message = maintenance.compacted
        ? 'Catalog maintenance completed: search index rebuilt, database compacted, and WAL checkpointed. No conversations were deleted.'
        : maintenance.indexRebuilt
          ? 'Catalog search index rebuilt, but VACUUM or the WAL checkpoint failed. Deleted text bytes may remain; retry catalog maintenance after closing other readers. No conversations were deleted.'
          : 'Catalog maintenance failed before compaction. See the Output channel and retry; no conversations were deleted.';
      vscode.window.showInformationMessage(message, 'OK');
      return;
    }
    const targets = chosen.filter((s) => !isMemoryOption(s.id));
    const repoMemory = chosen.some((s) => s.id === REPO_MEMORY_OPTION);
    const userMemory = chosen.some((s) => s.id === USER_MEMORY_OPTION);
    const all = chosen.some((s) => s.id === ALL_ID);
    if (targets.length === 0 && !repoMemory && !userMemory) return;

    // Resolve the selection ONCE, before the confirm. The nuke entry is a claim
    // about the whole machine, so it has to act on the whole machine, and the
    // confirm dialog has to describe the same set the wipe will touch. Deriving
    // the two separately is how a confirmation ends up promising less than the
    // run delivers: feeding the wipe only the ticked rows left every other
    // project's index and transcripts under a summary announcing a
    // machine-wide wipe, and re-deriving the set for the dialog then described
    // zero workspaces while the code cleaned all of them.
    const workspaceTargets = all
      ? workspaces.filter(ws => ws.id !== GLOBAL_ID)
      : workspaces.filter(ws => ws.id !== GLOBAL_ID && targets.some(t => t.id === ws.id));

    if (repoMemory && workspaceTargets.length === 0) {
      vscode.window.showWarningMessage(
        'Repo memory applies only to workspace entries. Select a workspace or deselect repo memory before cleaning.',
        'OK'
      );
      return;
    }

    if (!(await confirmClean(output, targets, workspaceTargets, unattributed.conversations, orphanedRows, repoMemory, userMemory, all))) return;

    const outcome = await clean({
      global: all || targets.some(t => t.id === GLOBAL_ID),
      all,
      // GLOBAL_ID is excluded here for a second reason, and it is the dangerous
      // one: the global store's REPO-memory path (`GitHub.copilot-chat/...`)
      // collides case-insensitively with the global USER-memory path
      // (`github.copilot-chat/...`) on Windows and macOS. Handing the global id
      // to the repo-memory list therefore deletes global user memory while the
      // summary reports it as kept. The global store is reached through
      // `global` instead, which is what it is for.
      workspaces: workspaceTargets
        .map(ws => ({ id: ws.id, folders: ws.folders, unresolvedFolders: ws.unresolvedFolders })),
      unattributedCwds: !all && targets.some(t => t.id === UNATTRIBUTED_ID) ? unattributed.cwds : [],
      repoMemory,
      userMemory,
    });

    reportClean(repoMemory, userMemory, outcome);
  });
}

function isMemoryOption(id: string): boolean {
  return id === REPO_MEMORY_OPTION || id === USER_MEMORY_OPTION;
}

/**
 * The confirm dialog states exactly what will be removed, because the options
 * reach outside the selection: global user memory wipes memory for workspaces
 * that are not on screen, and the nuke entry wipes every project's catalog.
 *
 * `wipeTargets` is the SAME list the run will be given, resolved by the caller.
 * It is not re-derived from the selection here, because a dialog that describes
 * a different set than the one being deleted is worse than no dialog: every
 * memory line below counts from this list, and a stale count turns a
 * confirmation into a lie.
 */
async function confirmClean(
  output: vscode.OutputChannel,
  targets: SessionPick[],
  wipeTargets: WorkspaceEntry[],
  unattributedCount: number,
  orphanedCount: number,
  repoMemory: boolean,
  userMemory: boolean,
  nuke: boolean,
): Promise<boolean> {
  const lines: string[] = [];
  if (nuke) {
    lines.push('EVERY Copilot conversation on this machine - all projects, all workspaces');
    if (orphanedCount > 0) lines.push(`${orphanedCount} orphaned catalog row(s) with no known workspace`);
  } else {
    const sessionTargets = wipeTargets.filter(ws => ws.conversations > 0 || ws.fsSessions > 0);
    if (sessionTargets.length > 0) {
      lines.push(
        `Session history for ${sessionTargets.length} workspace(s): ${sessionTargets.map(f => f.label).join(', ')}`,
      );
    }
    if (targets.some(t => t.id === GLOBAL_ID)) {
      lines.push('Global sessions (the global session list, empty-window chats, and history with no folder)');
    }
    if (targets.some(t => t.id === UNATTRIBUTED_ID)) {
      lines.push(`Unattributed catalog history (${unattributedCount} conversation(s); no workspace files or repo memory)`);
    }
  }
  // Counted from the resolved list, so the nuke entry reports every workspace
  // it is about to touch instead of the handful that happened to be ticked.
  if (repoMemory) lines.push(`Copilot repo memory for ${wipeTargets.length} workspace(s)`);
  if (userMemory) lines.push('Copilot GLOBAL user memory - affects EVERY workspace on this machine');
  const incompleteNote = !nuke && wipeTargets.some(ws => ws.unresolvedFolders || ws.folders.length === 0)
    ? '\n\nSome selected workspace folders could not be resolved; their catalog history may remain.'
    : '';

  const confirm = await vscode.window.showWarningMessage(
    `This permanently deletes:\n\n${lines.map(l => `  - ${l}`).join('\n')}${incompleteNote}\n\nCannot be undone. Restart VS Code afterwards.`,
    { modal: true },
    'Delete'
  );
  output.appendLine(`[INFO] Clean confirmed: ${confirm === 'Delete' ? 'approved' : 'cancelled'}.`);
  return confirm === 'Delete';
}

/**
 * Report completed deletion and compaction separately; row removal does not
 * imply that old bytes have left the database file or its WAL.
 */
function reportClean(
  repoMemory: boolean,
  userMemory: boolean,
  outcome: Awaited<ReturnType<typeof clean>>,
): void {
  const removed: string[] = [];
  if (outcome.removedAgentSessions > 0) removed.push(`${outcome.removedAgentSessions} conversation(s)`);
  if (outcome.removedOrphanRows > 0) removed.push(`${outcome.removedOrphanRows} orphaned catalog row(s)`);
  if (outcome.removedDirs > 0) removed.push(`${outcome.removedDirs} session director(ies)`);
  if (outcome.removedKeys > 0) removed.push(`${outcome.removedKeys} session index key(s)`);
  if (outcome.repoMemoryRemoved) removed.push(outcome.repoMemoryError ? 'repo memory in some workspace(s)' : 'repo memory');
  if (outcome.userMemoryRemoved) removed.push('global user memory');

  const warnings: string[] = [];
  // "Removed 0 conversations" on its own reads like a successful run that found
  // nothing to do. An explicit nothing-found line is the honest version, and it
  // is the one case where the user most needs to know the wipe did not happen.
  if (removed.length === 0 && !outcome.dbError && !outcome.dirError && !outcome.agentStoreError &&
      !outcome.repoMemoryError && !outcome.userMemoryError && outcome.unresolvedWorkspaces.length === 0 &&
      outcome.orphanedRowsRemaining === 0) {
    warnings.push('Nothing was found to delete for this selection - the storage has already been cleaned.');
  }
  if (outcome.dbError) warnings.push('Some session index databases could not be written - see the Output channel.');
  if (outcome.dirError) warnings.push('Some session directories could not be removed - see the Output channel and retry.');
  if (outcome.agentStoreError) {
    warnings.push(outcome.unhandledTables.length > 0
      ? `BLOCKED: unknown session-keyed catalog table(s) hold selected data: ${outcome.unhandledTables.join(', ')}. No selected catalog rows, workspace session files or memory were removed. See the Output channel and retry after updating catalog support.`
      : 'Copilot catalog deletion did not commit; workspace session files and memory were not removed. Resolve the error shown in the Output channel, then retry.');
  }
  if (outcome.unresolvedWorkspaces.length > 0) {
    warnings.push(
      `INCOMPLETE: ${outcome.unresolvedWorkspaces.length} selected workspace(s) had unresolved folder(s), so some catalog conversations could not be attributed. See the Output channel.`,
    );
  }
  if (outcome.orphanedRowsRemaining > 0) {
    warnings.push(
      `INCOMPLETE: ${outcome.orphanedRowsRemaining} orphaned catalog row(s) have no surviving session and cannot be assigned to a workspace. ` +
      'They were not deleted; select "EVERY conversation on this machine" to wipe the entire catalog, including other projects.',
    );
  }
  // Gated on rows this run actually removed. A memory-only or scoped run can
  // open the catalog and attempt compaction while deleting nothing, and
  // "deleted text bytes may remain" is a lie about a run that deleted no text.
  // A failed compaction from an EARLIER run is still reachable: the maintenance
  // entry is offered whenever the catalog file exists, independent of this toast.
  if (
    outcome.compactionAttempted && !outcome.compacted &&
    (outcome.removedAgentSessions > 0 || outcome.removedOrphanRows > 0)
  ) {
    warnings.push(
      'Catalog VACUUM or WAL checkpoint did not finish; deleted text bytes may remain in the database or WAL. ' +
      'Retry with "Maintain Copilot catalog" after other readers release the database, even if no sessions remain.',
    );
  }
  if (!repoMemory && !userMemory) {
    warnings.push(
      'Copilot memory was NOT deleted. It keeps notes it wrote from these sessions, ' +
      'plus machine-wide user preferences. To remove them run "Clear All Memory Files" ' +
      '- but that deletes user memory for every workspace, and repo memory only for the ' +
      'workspace you run it in.',
    );
  }

  // Rendered from the OUTCOME, never from the selection. Ticking a box is a
  // request; the line below is a claim about the disk, and the two are not the
  // same thing. `clean()` already distinguishes "asked and failed" from "had no
  // target at all", so the report can just read what happened.
  const memoryState = (asked: boolean, removedMemory: boolean, failed: boolean, mayBePartial: boolean, scope: string) =>
    !asked ? 'kept'
      : outcome.agentStoreError ? 'NOT attempted - catalog deletion failed'
      : mayBePartial ? 'INCOMPLETE - removal failed; some notes may have been removed - see the Output channel'
      : failed ? removedMemory ? `PARTIALLY deleted (${scope}) - see the Output channel` : 'NOT deleted - see the Output channel'
        : removedMemory ? `DELETED (${scope})` : 'already absent';
  const memory = [
    `Repo memory: ${memoryState(repoMemory, outcome.repoMemoryRemoved, outcome.repoMemoryError, outcome.repoMemoryMayBePartial, 'where present in selected workspace(s)')}.`,
    `Global user memory: ${memoryState(userMemory, outcome.userMemoryRemoved, outcome.userMemoryError, outcome.userMemoryMayBePartial, 'every workspace')}.`,
  ].join(' ');
  const removalSummary = removed.length > 0
    ? `Removed ${removed.join(', ')}.`
    : outcome.dirError || outcome.repoMemoryMayBePartial || outcome.userMemoryMayBePartial
      ? 'No complete removals confirmed.'
      : 'Nothing removed.';

  vscode.window.showInformationMessage(
    `${removalSummary}\n\n${memory}${warnings.length ? '\n\n' + warnings.join('\n\n') : ''}`,
    'OK'
  );
}

/**
 * Update auth (API key + request headers) for a server URL: every registry
 * ENTRY on that URL rotates together (ratified §5 scope - auth lives on the
 * registry entry, not on models; see the body comment).
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
        outputChannel.appendLine(`[INFO] Update Auth cancelled for ${serverUrl} - no credentials entered.`);
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
      vscode.window.showWarningMessage(`Server "${names}" is no longer registered. Nothing updated.`);
      return;
    }
    const updatedServers = currentServers.slice();
    const transitions: Array<{ id: string; to: Record<string, string> }> = [];
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
        transitions.push({ id: current.id, to: nextHeaders });
      }
    }
    if (transitions.length === 0) {
      outputChannel.appendLine(`[INFO] Update Auth: no changes for ${serverUrl} - fields left empty keep their current values.`);
      vscode.window.showInformationMessage(`No auth changes for ${serverUrl}. Enter a new key or headers to update.`);
      return;
    }

    if (!(await attemptWrite(outputChannel, 'Update Auth', () => writeServers(updatedServers)))) return;
    _provider.clearCache();
    // Push the new headers to the metrics engines so an open deep-dive uses
    // fresh auth. Update-if-present only: Update Auth must not create a
    // zero-subscriber engine (an engine only exists when a dashboard/deep-dive
    // is subscribed). Engines are keyed by entry id, so a header rotation can
    // never orphan a poller — the engine keeps its key and just gets new headers.
    for (const t of transitions) {
      refreshEngineHeaders(t.id, t.to);
    }
    const ids = targetIdx.map(({ s }) => `"${s.id}"`).join(', ');
    outputChannel.appendLine(`[INFO] Updated auth for server ${serverUrl} (entries ${ids}).`);
    vscode.window.showInformationMessage(`Updated auth for ${serverUrl}.`);
  });
}

/**
 * Rename a server for display: writes `displayName` on exactly ONE registry
 * entry — the one the user addressed. Entry id is the identity everywhere
 * else (Dashboard node, Deep-Dive, Remove Server, backend dropdown) and
 * rename is no exception: two entries sharing a URL (two OpenRouter keys,
 * two gateway tenants) each carry their own label. Every backend is
 * renamable, relays included — one rule for every entry, no special cases.
 * Triggered from the context menu on a server node; tree items carry
 * `serverId`. Bare-URL programmatic calls address the first entry on that
 * URL (and the log names the entry). Empty input clears the name (the URL
 * is shown again).
 */
export function registerRenameServerCommand(
  _context: vscode.ExtensionContext,
  provider: VllmChatModelProvider,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.renameServer', async (arg?: any) => {
    // VS Code passes the tree item for context menus. The entry id it carries
    // is the address; a bare URL string (programmatic call) falls back to the
    // first entry on that normalized URL.
    const serverUrl = typeof arg === 'string' ? arg : arg?.serverUrl;
    const serverId =
      typeof arg === 'object' && typeof arg?.serverId === 'string' ? arg.serverId : undefined;
    if (!serverUrl && !serverId) {
      vscode.window.showErrorMessage('Server URL not provided.');
      return;
    }

    const servers = readServers();
    const addressed = serverId
      ? servers.find(s => s.id === serverId)
      : servers.find(s => normalizeServerUrl(s.serverUrl) === normalizeServerUrl(serverUrl ?? ''));
    if (!addressed) {
      // Stale tree item / programmatic call with a wrong address: fail loudly,
      // never silently rename nothing.
      vscode.window.showWarningMessage(`No registered server found for ${serverId ?? serverUrl}.`);
      return;
    }
    const targetUrl = normalizeServerUrl(addressed.serverUrl);

    // Pre-prompt read serves ONLY the input prefill — the authoritative read
    // happens after the await below, so a settings edit made while the prompt
    // is open is never clobbered by a stale snapshot (same pattern as Update
    // Auth, which also reads after its prompts).
    const current = addressed.displayName?.trim() ?? '';

    const name = await vscode.window.showInputBox({
      ignoreFocusOut: true,
      title: 'Rename Server',
      prompt: `Display name for server "${addressed.id}" (${targetUrl}) in the vLLM Dashboard. Empty clears the name.`,
      placeHolder: 'e.g. IT Server for GLM5.2',
      value: current,
    });
    if (name === undefined) {
      outputChannel.appendLine(`[INFO] Rename Server cancelled for "${addressed.id}".`);
      return; // cancelled
    }

    // Re-read AFTER the prompt: the registry may have changed while it was
    // open; only the addressed entry is written. Empty/whitespace CLEARS by
    // deleting the key — this write path bypasses entry sanitization, so
    // persisting '' would be a bug. Untouched entries keep their object
    // identity (an unchanged registry produces no churn).
    const existingServers = readServers();
    const index = existingServers.findIndex(s => s.id === addressed.id);
    if (index === -1) {
      // Distinct from no-op: the entry vanished mid-prompt — a stale tree
      // item must not look like a successful rename.
      vscode.window.showWarningMessage(`No registered server found for "${addressed.id}".`);
      return;
    }
    const trimmedName = name.trim();
    const entry = existingServers[index];
    if ((entry.displayName ?? '') === trimmedName) {
      vscode.window.showInformationMessage(`No changes for server "${addressed.id}".`);
      return;
    }
    const next = { ...entry };
    if (trimmedName === '') delete next.displayName;
    else next.displayName = trimmedName;
    const nextServers = existingServers.map((s, i) => (i === index ? next : s));

    if (!(await attemptWrite(outputChannel, 'Rename Server', () => writeServers(nextServers)))) return;
    provider.clearCache();
    // Retitle this entry's open Deep-Dive panel immediately — without this it
    // keeps the old label until closed and reopened.
    updateDeepDiveTitle(addressed.id, trimmedName || undefined);
    if (trimmedName) {
      outputChannel.appendLine(`[INFO] Renamed server "${addressed.id}" (${targetUrl}) to "${trimmedName}".`);
      vscode.window.showInformationMessage(`Server "${addressed.id}" renamed to "${trimmedName}".`);
    } else {
      outputChannel.appendLine(`[INFO] Cleared display name for server "${addressed.id}" (${targetUrl}).`);
      vscode.window.showInformationMessage(`Display name cleared, showing the URL again.`);
    }
  });
}

/**
 * Reorder a server registry entry inside the `servers` array. No new property
 * is born: the array order IS the display order — the Dashboard and Server
 * Settings iterate `servers[]` in settings order (first-entry-wins per id,
 * same rule as the runtime resolver), so reordering the array moves the rows.
 * Called by the Dashboard's drag-and-drop controller with the dragged entry id
 * and the id of the row it was dropped on (`undefined` = empty tree space =
 * move to the bottom). The dragged entry lands ON the row it was dropped on:
 * splice at the target's ORIGINAL index — after removing the dragged entry
 * that inserts below the target on a downward drag and above it on an upward
 * one, which is exactly "the row under the cursor". The tree repaints itself
 * via `onDidChangeConfiguration`, no manual refresh needed.
 */
export function registerMoveServerCommand(
  _context: vscode.ExtensionContext,
  provider: VllmChatModelProvider,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.moveServer', async (draggedId: string, targetId?: string) => {
    // No argument type-guarding: the command is suppressed from the Command
    // Palette (`commandPalette: when:false`), has no menu, and its only
    // invoker is the dashboard drop handler, which already requires a
    // non-empty string id and passes `ServerTreeItem.serverId` (string) as
    // the target. The source/target EXISTENCE checks below stay - those are
    // live races (another window edited the registry), not type paranoia.
    // Fresh read at drop time; both ids address the FIRST entry with that id,
    // the same first-entry-wins rule the resolver and the dashboard use.
    const servers = readServers();
    const sourceIdx = servers.findIndex(s => s.id === draggedId);
    if (sourceIdx === -1) {
      vscode.window.showWarningMessage(`No registered server with id "${draggedId}".`);
      return;
    }
    const targetIdx = targetId === undefined
      ? servers.length - 1
      : servers.findIndex(s => s.id === targetId);
    if (targetIdx === -1) {
      // Stale tree node under the cursor (another window edited the registry):
      // fail loudly, never silently reorder nothing.
      vscode.window.showWarningMessage(`No registered server with id "${targetId}".`);
      return;
    }
    if (sourceIdx === targetIdx) return; // dropped on its own row - a no-op, not a write

    const next = servers.slice();
    const [entry] = next.splice(sourceIdx, 1);
    next.splice(targetIdx, 0, entry);

    if (!(await attemptWrite(outputChannel, 'Move Server', () => writeServers(next)))) return;
    provider.clearCache();
    outputChannel.appendLine(`[INFO] Moved server "${draggedId}" to position ${targetIdx + 1}.`);
  });
}

/**
 * One-step server reordering for the Dashboard's inline hover buttons
 * (▲▼ per server row). Same law as {@link registerMoveServerCommand}: the
 * `servers[]` array order IS the display order, so a neighbour swap in the
 * array moves the row, and the config-change listener repaints both UIs.
 *
 * TWO separate argument-free commands, deliberately: menu contribution
 * `arguments` never reach tree-item commands (the tree forwards its own
 * context argument and drops the contribution's - the defect that made the
 * first Move Up/Down menu a silent no-op), so the direction is baked into
 * the command identity instead of smuggled through an argument.
 */
export function registerMoveServerStepCommands(
  _context: vscode.ExtensionContext,
  provider: VllmChatModelProvider,
  outputChannel: vscode.OutputChannel,
): vscode.Disposable {
  const step = async (arg: any, delta: 1 | -1): Promise<void> => {
    // VS Code forwards the tree item (context) as the first argument; every
    // server node carries its registry `serverId`.
    const serverId = typeof arg === 'object' ? arg?.serverId : undefined;
    if (typeof serverId !== 'string' || !serverId) {
      vscode.window.showErrorMessage('Server id not provided.');
      return;
    }
    // Fresh read at click time; addresses the FIRST entry with this id, the
    // same first-entry-wins rule the resolver and the dashboard use.
    const servers = readServers();
    const index = servers.findIndex(s => s.id === serverId);
    if (index === -1) {
      vscode.window.showWarningMessage(`No registered server with id "${serverId}".`);
      return;
    }
    const target = index + delta;
    if (target < 0 || target >= servers.length) {
      vscode.window.showInformationMessage(
        `Server "${servers[index].displayName?.trim() || serverId}" is already at the ${delta < 0 ? 'top' : 'bottom'} of the list.`
      );
      return;
    }
    const next = servers.slice();
    [next[index], next[target]] = [next[target], next[index]];

    if (!(await attemptWrite(outputChannel, 'Move Server', () => writeServers(next)))) return;
    provider.clearCache();
    outputChannel.appendLine(`[INFO] Moved server "${serverId}" ${delta < 0 ? 'up' : 'down'}.`);
  };
  return vscode.Disposable.from(
    vscode.commands.registerCommand('vllm-copilot.moveServerUp', (arg?: any) => step(arg, -1)),
    vscode.commands.registerCommand('vllm-copilot.moveServerDown', (arg?: any) => step(arg, 1)),
  );
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
    // VS Code passes the tree item for context menus; every server-ish node
    // (plain, relay account, relay model) carries its registry `serverId`.
    // The command addresses EXACTLY that entry — entry id is the identity,
    // and a destructive node command must never sweep sibling entries that
    // merely share a URL.
    const serverId = typeof arg === 'object' ? arg?.serverId : undefined;
    const skipConfirm = typeof arg === 'object' && arg?.skipConfirm === true;
    if (typeof serverId !== 'string' || !serverId) {
      vscode.window.showErrorMessage('Server id not provided.');
      return;
    }

    const servers = readServers();
    // First entry wins per id, exactly like the runtime resolver: removing a
    // shadowed duplicate by id would address an entry no request ever reaches,
    // so the visible entry IS the removal target. `validateConfig` reports the
    // duplicate id itself.
    const entry = firstEntryById(servers).get(serverId);
    if (!entry) {
      vscode.window.showWarningMessage(`No registered server with id "${serverId}".`);
      return;
    }
    const label = entry.displayName?.trim() || normalizeServerUrl(entry.serverUrl);

    // Refuse while referenced: models point at entries BY ID, so dropping the
    // entry would break every one of them at once.
    const allModels = readModels();
    const referencing = allModels.filter(m => m.server === serverId);
    if (referencing.length > 0) {
      const names = referencing.map(m => m.displayName || m.id).join(', ');
      outputChannel.appendLine(
        `[WARN] Remove Server refused for "${serverId}" (${label}) - still referenced by ${referencing.length} model(s): ${names}.`
      );
      vscode.window.showWarningMessage(
        `Server "${label}" is still used by ${referencing.length} model(s): ${names}. Remove those models first (Remove Model), then remove the server.`
      );
      return;
    }

    if (!skipConfirm) {
      const confirm = await vscode.window.showWarningMessage(
        `Remove server "${label}" (id "${serverId}")? No models reference it.`,
        { modal: true },
        'Remove',
        'Cancel',
      );
      if (confirm !== 'Remove') return;
    }

    // Re-read for the write: the registry may have changed while the confirm
    // dialog was open. Match by id (not a stale index) so a concurrent edit
    // can't drop the wrong entry — and can only ever drop this one.
    const currentServers = readServers();
    if (!currentServers.some(s => s.id === serverId)) {
      vscode.window.showInformationMessage(`Server "${label}" was already removed.`);
      return;
    }
    // References re-checked too: a concurrent Add flow may have pointed a model
    // at this entry while the confirm dialog was open.
    const nowReferencing = readModels().filter(m => m.server === serverId);
    if (nowReferencing.length > 0) {
      const names = nowReferencing.map(m => m.displayName || m.id).join(', ');
      outputChannel.appendLine(
        `[WARN] Remove Server aborted for "${serverId}" - now referenced by ${nowReferencing.length} model(s): ${names}.`
      );
      vscode.window.showWarningMessage(
        `Server "${label}" is now used by ${nowReferencing.length} model(s): ${names}. Removal cancelled - remove those models first.`
      );
      return;
    }
    if (!(await attemptWrite(outputChannel, 'Remove Server', () => writeServers(currentServers.filter(s => s.id !== serverId))))) return;
    _provider.clearCache();
    outputChannel.appendLine(`[INFO] Removed server "${serverId}" (${label}).`);
    vscode.window.showInformationMessage(`Removed server "${label}".`);
  });
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

    // Match on (server entry id, resolveConfigId) — extension id preferred,
    // vLLM wire id fallback for legacy entries. Sibling models on the same
    // server are never touched.
    const existing = readModels();
    const filtered = existing.filter(
      m => !(m.server === server && resolveConfigId(m) === configId)
    );

    if (existing.length === filtered.length) {
      vscode.window.showWarningMessage(`No configured model "${configId}" found on server "${server}".`);
      return;
    }

    if (!(await attemptWrite(outputChannel, 'Remove Model', () => writeModels(filtered)))) return;
    _provider.clearCache();
    outputChannel.appendLine(`[INFO] Removed model "${configId}" from server "${server}".`);
    vscode.window.showInformationMessage(`Removed model "${configId}" from server "${server}".`);
  });
}

/**
 * Open a dashboard row's web page in the external browser.
 *
 * The row carries its own target (`webUrl`): the OpenRouter relay row opens
 * the site root, a relay model row opens its model page, the Account row
 * opens the profile settings. Context menu / inline button only - the URL
 * exists solely on tree items, so the palette can offer nothing useful.
 */
export function registerOpenDashboardWebCommand(): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.openDashboardWeb', (arg?: any) => {
    const url = typeof arg === 'object' ? arg?.webUrl : undefined;
    if (typeof url !== 'string' || !url) {
      vscode.window.showWarningMessage('vLLM-Copilot: this dashboard row has no web page to open.');
      return;
    }
    void vscode.env.openExternal(vscode.Uri.parse(url));
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
 * `cost`) → USD-only rate inputs (input / output / cachedInput, prefilled
 * from any existing `cost`). Writes the `cost` block via
 * {@link patchModelConfig}, so the settings change fires the dashboard's
 * config-change handler and the cost appears without a reload.
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

    const input = await askRate(existing.input, `Input cost per 1M tokens (USD) - fresh, uncached input.`);
    if (input === undefined) return;
    const output = await askRate(existing.output, `Output cost per 1M tokens (USD) - includes reasoning tokens.`);
    if (output === undefined) return;
    const cachedInput = await askRate(existing.cachedInput, `Cache-read input cost per 1M tokens (USD).`);
    if (cachedInput === undefined) return;

    // USD only. This product has no second currency: every rate is
    // denominated in dollars, and the former "AI Credits" option existed only
    // to let a model be priced in the same unit as the Copilot picker. That
    // is a Microsoft unit with a 1:100 relation to the dollar, not a currency
    // anyone else bills in, and the comparison it enabled is arithmetic the
    // user can do. The quickpick is gone entirely — a dialog with one option
    // is a dialog with no decision in it.
    const currency = 'USD';

    const cost = {
      input: numOrZero(input),
      output: numOrZero(output),
      cachedInput: numOrZero(cachedInput),
      currency,
    };
    // Existence re-check at write time (the personality.ts doctrine, CR-47):
    // every dialog above runs with ignoreFocusOut while the Model Settings
    // webview stays live, so the model may have been deleted mid-flow.
    // patchModelConfig APPENDS on no match — writing now would resurrect the
    // entry as a zombie, with the composite config id smuggled in as its wire
    // id: unsendable, parked forever, rendered in every cost list.
    if (findModelConfigIndex(readModels(), configId, model.server) < 0) {
      outputChannel.appendLine(
        `[WARN] Set Cost aborted: model "${configId}" no longer exists on server "${model.server}".`
      );
      vscode.window.showWarningMessage(
        `Model "${picked.label}" was removed while this dialog was open - cost not set.`
      );
      return;
    }
    if (!(await attemptWrite(outputChannel, 'Set Cost', () => patchModelConfig({ id: configId, server: model.server }, { cost })))) return;
    outputChannel.appendLine(`[INFO] Set cost for ${picked.label} (${currency}): in ${cost.input}, out ${cost.output}, cached-in ${cost.cachedInput} per 1M.`);
    vscode.window.showInformationMessage(`Cost set for ${picked.label}.`);
  });
}

