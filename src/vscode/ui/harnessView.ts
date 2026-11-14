import * as vscode from 'vscode';

/**
 * The "DeepSeek Harness" sidebar section: the entry point to the harness that
 * ships inside vLLM-Copilot.
 *
 * Not installed, the section is exactly two rows - what the feature is, and how
 * to get it. Installed, it is the harness's control panel: every
 * `vllm-copilot.harness.*` command this extension contributes, in one deliberate
 * order.
 *
 * The row list is read from this extension's own manifest
 * (`Extension.packageJSON`, public API) instead of being mirrored here, so a
 * command added to `package.json` appears in this section without a second edit
 * somewhere else. `refresh()` re-renders it when the installed state changes;
 * nothing polls and nothing watches the extension list, because the harness is
 * this extension's own code and only its own commands can flip that state.
 */

/** Alpha feedback lands on the issue tracker, not on a separate repository. */
const DSH_ISSUES_URL = 'https://github.com/fuzzifikation/vLLM-Copilot/issues';

/** Our own row inside the harness list: this command id opens the issue tracker. */
const FEEDBACK_COMMAND = 'vllm-copilot.dshFeedback';

/** Every harness command this extension contributes carries this prefix. */
const COMMAND_PREFIX = 'vllm-copilot.harness.';

/**
 * Row order, most-reached-for first - the manifest order is the author's
 * bookkeeping, not the user's. **Open Harness** leads because it is the whole
 * session in one row: the command starts a stopped harness and installs a
 * missing one before it opens the view. Lifecycle follows, then the update
 * command, then diagnosis, with settings above the one destructive row.
 * A command a later release adds is not in this list and lands just above
 * **Open Harness Settings**, so the section can never lose or bury a command.
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

/** Tree decoration per command; the manifest's icons are tuned for menus, not rows. */
const HARNESS_ICONS: Record<string, string> = {
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
  'The DeepSeek Harness is an agent that works in its own window tab - inside VS Code or VSCodium - on the models you configured here.',
  'Your modes, parameters and personalities come along, and its usage lands in the same dashboard totals.',
  'It needs no Copilot. Your own servers do the thinking.',
].join('\n\n');

/** What the install row is actually promising: a probe, then one download. */
const INSTALL_TOOLTIP =
  'Checks Node.js 22 or newer, npm and pnpm are available, then downloads the DeepSeek Harness once into vLLM-Copilot\u2019s own directory. A few minutes the first time; later starts take seconds.';

export class HarnessTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  /**
   * @param extension this extension: its manifest is the row list.
   * @param isInstalled whether the harness runtime is on disk; the section is
   * the pitch until it is, the control panel after.
   */
  constructor(
    private readonly extension: vscode.Extension<unknown>,
    private readonly isInstalled: () => boolean,
  ) {
    // The feedback row sits among the harness rows, but an external link needs
    // env.openExternal and no shipped workbench command promises that for an
    // http URI. Not contributed to the palette on purpose - the sidebar row is
    // the only entry point it needs.
    this.subscriptions.push(
      vscode.commands.registerCommand(FEEDBACK_COMMAND, () => {
        void vscode.env.openExternal(vscode.Uri.parse(DSH_ISSUES_URL));
      })
    );
  }

  /** Re-render the section: the installed state moved, or a start landed. */
  refresh(): void {
    this.changed.fire(undefined);
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

    if (!this.isInstalled()) {
      const pitch = new vscode.TreeItem(
        'Run an agent on your own models',
        vscode.TreeItemCollapsibleState.None
      );
      pitch.iconPath = new vscode.ThemeIcon('rocket');
      pitch.tooltip = new vscode.MarkdownString(PITCH);

      const install = new vscode.TreeItem(
        'Install DeepSeek Harness\u2026',
        vscode.TreeItemCollapsibleState.None
      );
      install.iconPath = new vscode.ThemeIcon('cloud-download');
      install.tooltip = new vscode.MarkdownString(INSTALL_TOOLTIP);
      install.command = { command: 'vllm-copilot.harness.installOrUpdate', title: 'Install or Update Harness\u2026' };
      return [pitch, install];
    }

    // This extension's manifest order is its author's bookkeeping, so the rows
    // get ROW_ORDER instead. A command this file has never heard of ranks a
    // half-step under stale-tab cleanup: above **Open Harness Settings** whatever
    // its manifest position is, and never between two rows whose order we chose.
    const rank = (id: string) => {
      const at = ROW_ORDER.indexOf(id);
      return at >= 0 ? at : ROW_ORDER.indexOf('vllm-copilot.harness.sweepStaleTabs') + 0.5;
    };
    const contributed: { id: string; title: string }[] = [];
    const manifest: unknown[] = Array.isArray(this.extension.packageJSON?.contributes?.commands)
      ? this.extension.packageJSON.contributes.commands
      : [];
    for (const entry of manifest) {
      const id = (entry as { command?: unknown })?.command;
      if (typeof id !== 'string' || !id.startsWith(COMMAND_PREFIX)) {
        continue;
      }
      // Titles are plain strings or l10n objects, depending on how the manifest
      // was packaged.
      const rawTitle = (entry as { title?: unknown })?.title;
      const title = typeof rawTitle === 'string'
        ? rawTitle
        : typeof (rawTitle as { value?: unknown })?.value === 'string'
          ? (rawTitle as { value: string }).value
          : id;
      contributed.push({ id, title });
    }
    // The alpha's feedback row belongs in that order too, wherever the harness's
    // own commands end up - so it joins the list and sorts with it.
    contributed.push({ id: FEEDBACK_COMMAND, title: 'Report an Issue' });

    const rows: vscode.TreeItem[] = [];
    for (const entry of contributed.sort((a, b) => rank(a.id) - rank(b.id))) {
      const ours = entry.id === FEEDBACK_COMMAND;
      const row = new vscode.TreeItem(entry.title, vscode.TreeItemCollapsibleState.None);
      row.iconPath = new vscode.ThemeIcon(ours ? 'comment-discussion' : HARNESS_ICONS[entry.id] ?? 'run');
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
