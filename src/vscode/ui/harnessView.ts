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

/** Tree decoration per bridge command; the manifest's icons are tuned for menus, not rows. */
const BRIDGE_ICONS: Record<string, string> = {
  'dshBridge.installOrUpdate': 'cloud-download',
  'dshBridge.uninstall': 'trash',
  'dshBridge.start': 'play',
  'dshBridge.stop': 'debug-stop',
  'dshBridge.restart': 'restart',
  'dshBridge.open': 'link-external',
  'dshBridge.openNewView': 'plus',
  'dshBridge.showLogs': 'output',
  'dshBridge.report': 'report',
  'dshBridge.sweepStaleTabs': 'close-all',
  'dshBridge.openSettings': 'gear',
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

  constructor() {
    // Installing or uninstalling the bridge re-renders the section on the spot:
    // no polling, no reload window.
    this.subscriptions.push(vscode.extensions.onDidChange(() => this.changed.fire(undefined)));
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
        'Alpha - run it on your own models',
        vscode.TreeItemCollapsibleState.None
      );
      pitch.iconPath = new vscode.ThemeIcon('rocket');
      pitch.tooltip = new vscode.MarkdownString(PITCH);
      pitch.command = OPEN_BRIDGE;

      const install = new vscode.TreeItem(
        'Install DeepSeek Harness Bridge',
        vscode.TreeItemCollapsibleState.None
      );
      install.iconPath = new vscode.ThemeIcon('cloud-download');
      install.tooltip = new vscode.MarkdownString(
        "Opens the bridge's extension page in VS Code - press **Install** there. The bridge is what runs the harness on the servers you configured here."
      );
      install.command = OPEN_BRIDGE;
      return [pitch, install];
    }

    const head = new vscode.TreeItem('DeepSeek Harness Bridge', vscode.TreeItemCollapsibleState.None);
    const version = bridge.packageJSON?.version;
    head.description = typeof version === 'string' ? `v${version}` : 'installed';
    head.iconPath = new vscode.ThemeIcon('extensions');
    head.tooltip = new vscode.MarkdownString(
      `Installed companion extension \`${BRIDGE_ID}\`. Click to open its page.`
    );
    head.command = OPEN_BRIDGE;

    // Manifest order is the bridge author's own prioritisation, so rows keep it.
    const contributed: unknown[] = Array.isArray(bridge.packageJSON?.contributes?.commands)
      ? bridge.packageJSON.contributes.commands
      : [];
    const rows: vscode.TreeItem[] = [head];
    for (const entry of contributed) {
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
      const row = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);
      row.iconPath = new vscode.ThemeIcon(BRIDGE_ICONS[id] ?? 'run');
      row.tooltip = new vscode.MarkdownString(`${title}\n\n\`${id}\``);
      row.command = { command: id, title };
      rows.push(row);
    }
    return rows;
  }
}
