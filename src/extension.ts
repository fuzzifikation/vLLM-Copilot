import * as vscode from 'vscode';
import { VllmChatModelProvider } from './provider.js';
import { getConfig, validateConfig, resolveServerConfig } from './config.js';
import { FileLogger } from './logger.js';
import { registerAddServerModelCommand, registerConfigureUtilityModelCommand, registerAutoConfigureModelCommand, ensureByokUtilityDefault } from './autoConfig.js';
import { migrateToPerModelServer, migrateToCompositeIds } from './migration.js';
import { setSessionManagerOutput } from './sessionManager.js';
import {
  registerTestAndRefreshModelsCommand,
  registerDiagnoseConnectionCommand,
  registerOpenLogFileCommand,
  registerClearLogFilesCommand,
  registerCleanSessionsCommand,
  registerSetModelPersonalityCommand,
  registerUpdateServerAuthCommand,
  registerRemoveServerCommand,
} from './commands.js';
import { setExtensionVersion } from './diagnostics.js';
import { DashboardTreeProvider } from './dashboard.js';
import { ServerSettingsViewProvider } from './serverSettingsView.js';
import { openDeepDive } from './deepDiveView.js';

const VENDOR_ID = 'vllm-copilot';
let provider: VllmChatModelProvider | undefined;

// Output channel for extension logging
let outputChannel: vscode.OutputChannel;

// File logger for request/response logging
let fileLogger: FileLogger;

export async function activate(context: vscode.ExtensionContext) {
  try {
    outputChannel = vscode.window.createOutputChannel('vLLM-Copilot');
    context.subscriptions.push(outputChannel);

    // Always log remote detection state for debugging
    const extKindLabel = context.extension.extensionKind === vscode.ExtensionKind.UI ? 'UI' : 'Workspace';
    outputChannel.appendLine(`[INFO] Remote detection: remoteName="${vscode.env.remoteName ?? 'none'}", extensionKind=${extKindLabel}`);

    // Running locally while connected to a remote — auto-install on the remote host.
    if (vscode.env.remoteName && context.extension.extensionKind === vscode.ExtensionKind.UI) {
      outputChannel.appendLine(`[WARN] Extension is not installed on the ${vscode.env.remoteName} remote — triggering auto-install from Marketplace.`);
      void vscode.commands.executeCommand(
        'workbench.extensions.installExtension',
        'System-Sciences.vllm-copilot'
      ).then(
        () => outputChannel.appendLine(`[INFO] Auto-install on ${vscode.env.remoteName} remote triggered.`),
        (err) => outputChannel.appendLine(`[WARN] Auto-install on ${vscode.env.remoteName} remote failed: ${err instanceof Error ? err.message : String(err)}`)
      );
    }

    // publisher/name changes.
    setExtensionVersion(context.extension.packageJSON.version);

    // Wire output channel to sessionManager for logging
    setSessionManagerOutput(outputChannel);

    // One-time migration: move legacy global server/sampling settings into per-model config.
    try {
      await migrateToPerModelServer(context, outputChannel);
      // Then rewrite ids to the composite "<model> on <host>" form (runs after the
      // per-model migration so every model already has its serverUrl).
      await migrateToCompositeIds(context, outputChannel);
    } catch (err) {
      outputChannel.appendLine(`[WARN] Per-model migration failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Initialize file logger
    fileLogger = new FileLogger(context, outputChannel);
    context.subscriptions.push(fileLogger);

    // Enable file logging if setting is on
    const cfg = vscode.workspace.getConfiguration('vllm-copilot');
    const enableLogging = cfg.get<boolean>('enableFileLogging') ?? false;
    if (enableLogging) {
      fileLogger.init();
    }

    // React to setting changes at runtime (toggle logging without reload)
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('vllm-copilot.enableFileLogging')) {
          const enabled = vscode.workspace.getConfiguration('vllm-copilot').get<boolean>('enableFileLogging') ?? false;
          if (enabled && !fileLogger.isActive()) {
            fileLogger.init();
          } else if (!enabled && fileLogger.isActive()) {
            fileLogger.close().catch(() => { /* best-effort flush */ });
          }
        }
        // Auto-invalidate cached config on any vllm-copilot settings change
        if (e.affectsConfiguration('vllm-copilot')) {
          try {
            provider?.clearCache();
          } catch (err) {
            outputChannel.appendLine(`[ERROR] Config change handler: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      })
    );

    // One-time activation summary
    const fullConfig = await getConfig(context);
    outputChannel.appendLine(`[INFO] vLLM-Copilot activated (${fullConfig.models.length} model(s) configured)`);

    // Validate config values
    const warnings = validateConfig(fullConfig);
    for (const w of warnings) {
      outputChannel.appendLine(`[WARN] Config: ${w}`);
    }

    // Ensure BYOK utility model default is set so MCP servers + agent mode work
    // with vLLM models. This is idempotent — does nothing if already configured.
    if (fullConfig.models.length > 0) {
      ensureByokUtilityDefault().catch(err => {
        outputChannel.appendLine(`[WARN] Failed to set BYOK utility model default: ${err}`);
      });
    }

    provider = new VllmChatModelProvider(context, outputChannel, fileLogger);
    const activeProvider = provider;
    context.subscriptions.push(activeProvider);
    context.subscriptions.push(
      vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, activeProvider)
    );

    // Register all user-facing commands. Each returns a Disposable (see commands.ts
    // and autoConfig.ts). Test & Refresh is the central workflow; Add Server &
    // Model is the entry-point wizard; the rest are utility/maintenance commands.
    context.subscriptions.push(
      registerTestAndRefreshModelsCommand(context, activeProvider, outputChannel),
      registerDiagnoseConnectionCommand(context, outputChannel),
      registerAddServerModelCommand(context, activeProvider, outputChannel),
      registerAutoConfigureModelCommand(context, activeProvider, outputChannel),
      registerConfigureUtilityModelCommand(outputChannel),
      registerOpenLogFileCommand(fileLogger),
      registerClearLogFilesCommand(fileLogger),
      registerCleanSessionsCommand(outputChannel, context.extension.extensionKind),
      registerSetModelPersonalityCommand(context, activeProvider, outputChannel),
      registerUpdateServerAuthCommand(context, activeProvider, outputChannel),
      registerRemoveServerCommand(context, activeProvider, outputChannel),
    );

    // Deep-Dive: open editor-area webview for a single server
    context.subscriptions.push(
      vscode.commands.registerCommand('vllm-copilot.openDeepDive', async (arg?: any) => {
        const serverUrl = typeof arg === 'string' ? arg : arg?.serverUrl;
        if (!serverUrl) {
          vscode.window.showErrorMessage('Server URL not provided.');
          return;
        }
        // Resolve requestHeaders from first model config pointing at this server
        const config = vscode.workspace.getConfiguration('vllm-copilot');
        const models = config.get<any[]>('models') || [];
        const firstModel = models.find(m => m.serverUrl === serverUrl);
        const headers = firstModel ? (resolveServerConfig(firstModel).requestHeaders ?? {}) : {};
        openDeepDive(serverUrl, headers, context, outputChannel);
      }),
    );

    // Register dashboard tree view (native sidebar UI)
    const dashboardTree = new DashboardTreeProvider(context, outputChannel);
    context.subscriptions.push(dashboardTree);
    const dashboardView = vscode.window.createTreeView('vllm-copilot.dashboard', { treeDataProvider: dashboardTree });
    context.subscriptions.push(dashboardView);

    // Only poll when the sidebar is actually visible
    context.subscriptions.push(
      dashboardView.onDidChangeVisibility(e => {
        dashboardTree.setVisible(e.visible);
      }),
    );

    // Register server settings webview (collapsible section below dashboard)
    const serverSettingsView = new ServerSettingsViewProvider(context, outputChannel, () => activeProvider.clearCache());
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('vllm-copilot.serverSettings', serverSettingsView)
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('vllm-copilot.setPollInterval', async () => {
        const current = vscode.workspace.getConfiguration('vllm-copilot.dashboard').get<number>('pollIntervalMs', 15000);
        const input = await vscode.window.showInputBox({
          prompt: 'Set polling interval (e.g. 15s, 30s, 1m)',
          value: `${current / 1000}s`,
          validateInput: (val: string) => {
            const s = val.replace(/s$/, '');
            const m = val.replace(/m$/, '');
            if (!isNaN(Number(s)) && Number(s) > 0) return null;
            if (!isNaN(Number(m)) && Number(m) > 0) return null;
            return 'Enter a valid interval (e.g. 15s, 30s, 1m)';
          },
        });
        if (!input) return;
        let ms: number;
        if (input.endsWith('m')) {
          ms = Number(input.slice(0, -1)) * 60 * 1000;
        } else {
          ms = Number(input.replace(/s$/, '')) * 1000;
        }
        if (ms < 1000) {
          vscode.window.showErrorMessage('Polling interval must be at least 1s');
          return;
        }
        await vscode.workspace.getConfiguration('vllm-copilot.dashboard').update('pollIntervalMs', ms, vscode.ConfigurationTarget.Global);
      }),
    );

    // Refresh dashboard command
    context.subscriptions.push(
      vscode.commands.registerCommand('vllm-copilot.refreshDashboard', async () => {
        await dashboardTree.refresh();
      })
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const reason = err instanceof Error && err.stack ? err.stack : detail;
    if (outputChannel) {
      outputChannel.appendLine(`[ERROR] Extension activation failed:\n${reason}`);
    } else {
      console.error(`[ERROR] Extension activation failed:\n${reason}`);
    }
    vscode.window.showErrorMessage(
      `vLLM-Copilot failed to activate: ${detail}. If you are connected through Remote-SSH or WSL, install vLLM-Copilot in the remote extension host as well.\n\nCheck Output → vLLM-Copilot for details.`,
      'Open Output'
    ).then(selection => {
      if (selection === 'Open Output') outputChannel.show();
    });
  }
}

export async function deactivate() {
  // Await so the write stream finishes flushing buffered log lines before VS Code
  // tears down the extension host. Fire-and-forget would drop the tail of the log.
  // Optional-chain: activation may have thrown before fileLogger was assigned.
  await fileLogger?.close();
}
