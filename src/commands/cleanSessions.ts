/**
 * "Clean Copilot Sessions": the janitor command UI. Owns the workspace
 * picker, the optional memory picks, the confirmation dialog, and the
 * post-wipe report; the destructive engine (discovery, catalog wipe,
 * compaction) lives in `shared/sessionManager.ts`. Extracted whole out of
 * `commands.ts` (Round 10 P C-1) so the wipe UI has one home and the
 * registration file stays thin.
 *
 * Security cleanup, not a disk cleaner: it removes the conversation text in
 * the Copilot catalog (`session-store.db`) and its full-text index, not just
 * the session lists. See `shared/sessionManager.js` for the storage map and
 * for why the compaction result is reported instead of assumed.
 */

import * as vscode from 'vscode';
import {
  clean,
  discoverWorkspaces,
  maintainAgentStore,
  ALL_ID,
  GLOBAL_ID,
  type WorkspaceEntry,
} from '../shared/sessionManager.js';

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
