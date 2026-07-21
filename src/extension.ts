import * as vscode from 'vscode';
import { VllmChatModelProvider } from './provider.js';
import { getConfig, validateConfig } from './config.js';
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
  registerConfigureServerCommand,
} from './commands.js';
import { setExtensionVersion } from './diagnostics.js';
import { DashboardViewProvider } from './dashboard.js';

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
      registerAddServerModelCommand(context, outputChannel),
      registerAutoConfigureModelCommand(context, outputChannel),
      registerConfigureUtilityModelCommand(outputChannel),
      registerOpenLogFileCommand(fileLogger),
      registerClearLogFilesCommand(fileLogger),
      registerCleanSessionsCommand(outputChannel, context.extension.extensionKind),
      registerSetModelPersonalityCommand(context, activeProvider, outputChannel),
      registerConfigureServerCommand(context, outputChannel),
    );

    // Register dashboard webview
    const dashboardProvider = new DashboardViewProvider(context, outputChannel);
    context.subscriptions.push(dashboardProvider);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('vllm-copilot.dashboard', dashboardProvider)
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
      `vLLM-Copilot failed to activate: ${detail}.\n\nCheck Output → vLLM-Copilot for details.`,
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
