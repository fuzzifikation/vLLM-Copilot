import * as vscode from 'vscode';

/**
 * The "DeepSeek Harness" sidebar section: an advertisement for the companion
 * extension while it is missing, and a launcher for its commands once it is
 * installed.
 *
 * The command list is read from the installed extension's own manifest
 * (`Extension.packageJSON`, public API) instead of being mirrored here, so a
 * command the bridge adds or renames appears in this sidebar without a release
 * of vLLM-Copilot. Clicking a row while the bridge is still dormant is fine:
 * VS Code activates the extension that declared the command.
 */

/** Published id of the companion extension (publisher.name, as on disk). */
const BRIDGE_ID = 'System-Sciences.dsh-bridge';

/** Where to send the user if VS Code's in-app extension page is unavailable. */
const BRIDGE_MARKETPLACE_URL = `https://marketplace.visualstudio.com/items?itemName=${BRIDGE_ID}`;

/** Alpha feedback lands on the issue tracker, not on a separate repository. */
const DSH_ISSUES_URL = 'https://github.com/fuzzifikation/vLLM-Copilot/issues';

/** Our own row inside the bridge's list: this command id opens the issue tracker. */
const FEEDBACK_COMMAND = 'vllm-copilot.dshFeedback';

/**
 * Row order, most-reached-for first - the bridge's manifest order is its
 * author's bookkeeping, not the user's. **Open Harness** leads because it is the
 * whole session in one row: the bridge starts a stopped harness and installs a
 * missing one before it opens the view. Lifecycle follows, then the update
 * command, then diagnosis, with settings above the one destructive row.
 * Commands a later bridge adds are not in this list and land just above
 * **Open Bridge Settings**, so the section can never lose or bury a command.
 */
const ROW_ORDER = [
  'vllm-copilot.harness.open',
  'vllm-copilot.harness.openNewView',
  'vllm-copilot.harness.start',
  'vllm-copilot.harness.stop',
  'vllm-copilot.harness.restart',
  'vllm-copilot.harness.installOrUpdate',
  'vllm-copilot.harness.showLogs',
  'vllm-copilot.harness.report',
  FEEDBACK_COMMAND,
  'vllm-copilot.harness.sweepStaleTabs',
  'vllm-copilot.harness.openSettings',
  'vllm-copilot.harness.uninstall',
];

/** Tree decoration per bridge command; the manifest's icons are tuned for menus, not rows. */
const BRIDGE_ICONS: Record<string, string> = {
  'vllm-copilot.harness.installOrUpdate': 'cloud-download',
  'vllm-copilot.harness.uninstall': 'trash',
  'vllm-copilot.harness.start': 'play',
  'vllm-copilot.harness.stop': 'debug-stop',
  'vllm-copilot.harness.restart': 'restart',
  'vllm-copilot.harness.open': 'link-external',
  'vllm-copilot.harness.openNewView': 'plus',
  'vllm-copilot.harness.showLogs': 'output',
  'vllm-copilot.harness.report': 'report',
  'vllm-copilot.harness.sweepStaleTabs': 'close-all',
  'vllm-copilot.harness.openSettings': 'gear',
};

const PITCH = [
  'Copilot keeps taking controls away, so we stopped waiting.',
  "The DeepSeek Harness (DSH) is our replacement for Copilot's agent. It runs inside VS Code, with your own vLLM model doing the thinking.",
  'Your models, modes, parameters and personalities come along, and its usage lands in the same tracker.',
].join('\n\n');

const OPEN_BRIDGE: vscode.Command = {
  command: 'vllm-copilot.tryDeepSeekHarness',
  title: 'Try the DeepSeek Harness',
};

/** Auto-registered focus command for this section: reveals it when hidden. */
const FOCUS_SECTION = 'vllm-copilot.harness.focus';

/**
 * Opens the bridge's extension page inside VS Code (`extension.open`, the same
 * command VS Code's own reporters use) and falls back to the Marketplace in the
 * browser if the workbench refuses it.
 */
export function registerTryDeepSeekHarnessCommand(): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.tryDeepSeekHarness', async () => {
    try {
      await vscode.commands.executeCommand('extension.open', BRIDGE_ID);
    } catch {
      await vscode.env.openExternal(vscode.Uri.parse(BRIDGE_MARKETPLACE_URL));
    }
  });
}

export class HarnessTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  /** Whether the bridge was there the last time the extension list moved. */
  private bridgeWasInstalled: boolean;

  constructor() {
    this.bridgeWasInstalled = Boolean(vscode.extensions.getExtension(BRIDGE_ID));
    // The feedback row sits inside the bridge's list but the command is ours:
    // an external link needs env.openExternal, and no shipped workbench command
    // promises that for an http URI. Not contributed to the palette on purpose -
    // the sidebar row is the only entry point it needs.
    // Installing or uninstalling the bridge re-renders the section on the spot:
    // no polling, no reload window. The same event carries the handoff: pressing
    // Install on the bridge's page leaves the user in the editor area with
    // nothing in front of them, so the section - which at that instant becomes
    // the bridge's control panel, led by "Open Harness" - opens itself once. It
    // reveals the section only. Launching the harness is not ours to do: the
    // bridge starts it when the user asks, and calling vllm-copilot.harness.open here would
    // install a runtime and open a port unsolicited.
    this.subscriptions.push(
      vscode.commands.registerCommand(FEEDBACK_COMMAND, () => {
        void vscode.env.openExternal(vscode.Uri.parse(DSH_ISSUES_URL));
      }),
      vscode.extensions.onDidChange(() => {
        const installed = Boolean(vscode.extensions.getExtension(BRIDGE_ID));
        if (installed && !this.bridgeWasInstalled) {
          void vscode.commands.executeCommand(FOCUS_SECTION);
        }
        this.bridgeWasInstalled = installed;
        this.changed.fire(undefined);
      })
    );
  }

  dispose(): void {
    for (const d of this.subscriptions) {
      d.dispose();
    }
    this.changed.dispose();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    // The section is a flat list of actions; nothing here expands.
    if (element) {
      return [];
    }

    const bridge = vscode.extensions.getExtension(BRIDGE_ID);
    if (!bridge) {
      const pitch = new vscode.TreeItem(
        'Run it on your own models',
        vscode.TreeItemCollapsibleState.None
      );
      pitch.iconPath = new vscode.ThemeIcon('rocket');
      pitch.tooltip = new vscode.MarkdownString(PITCH);
      pitch.command = OPEN_BRIDGE;

      const install = new vscode.TreeItem(
        'Install the DeepSeek Harness',
        vscode.TreeItemCollapsibleState.None
      );
      install.iconPath = new vscode.ThemeIcon('cloud-download');
      install.tooltip = new vscode.MarkdownString(
        "Opens the extension's page in VS Code - press **Install** there. The DeepSeek Harness is what runs the agent on the servers you configured here."
      );
      install.command = OPEN_BRIDGE;
      return [pitch, install];
    }

    const head = new vscode.TreeItem('DeepSeek Harness', vscode.TreeItemCollapsibleState.None);
    const version = bridge.packageJSON?.version;
    head.description = typeof version === 'string' ? `v${version}` : 'installed';
    head.iconPath = new vscode.ThemeIcon('extensions');
    head.tooltip = new vscode.MarkdownString(
      `Installed companion extension \`${BRIDGE_ID}\`. Click to open its page.`
    );
    head.command = OPEN_BRIDGE;

    // The bridge's manifest order is its author's bookkeeping, so the rows get
    // ROW_ORDER instead. A command this file has never heard of ranks a half-step
    // under stale-tab cleanup: above **Open Bridge Settings** whatever its
    // manifest position is, and never between two rows whose order we chose.
    const rank = (id: string) => {
      const at = ROW_ORDER.indexOf(id);
      return at >= 0 ? at : ROW_ORDER.indexOf('vllm-copilot.harness.sweepStaleTabs') + 0.5;
    };
    const contributed: { id: string; title: string }[] = [];
    const manifest: unknown[] = Array.isArray(bridge.packageJSON?.contributes?.commands)
      ? bridge.packageJSON.contributes.commands
      : [];
    for (const entry of manifest) {
      const id = (entry as { command?: unknown })?.command;
      if (typeof id !== 'string' || !id) {
        continue;
      }
      // Titles are plain strings or l10n objects, depending on how the other
      // manifest was packaged.
      const rawTitle = (entry as { title?: unknown })?.title;
      const title = typeof rawTitle === 'string'
        ? rawTitle
        : typeof (rawTitle as { value?: unknown })?.value === 'string'
          ? (rawTitle as { value: string }).value
          : id;
      contributed.push({ id, title });
    }
    // The alpha's feedback row belongs in that order too, wherever the bridge's
    // own commands end up - so it joins the list and sorts with it.
    contributed.push({ id: FEEDBACK_COMMAND, title: 'Report an Issue' });

    const rows: vscode.TreeItem[] = [head];
    for (const entry of contributed.sort((a, b) => rank(a.id) - rank(b.id))) {
      const ours = entry.id === FEEDBACK_COMMAND;
      const row = new vscode.TreeItem(entry.title, vscode.TreeItemCollapsibleState.None);
      row.iconPath = new vscode.ThemeIcon(ours ? 'comment-discussion' : BRIDGE_ICONS[entry.id] ?? 'run');
      row.tooltip = new vscode.MarkdownString(
        ours
          ? `Opens \`${DSH_ISSUES_URL}\` - bugs, wishes and half-formed grumbles are what an alpha runs on.`
          : `${entry.title}\n\n\`${entry.id}\``
      );
      row.command = { command: entry.id, title: entry.title };
      rows.push(row);
    }
    return rows;
  }
}
