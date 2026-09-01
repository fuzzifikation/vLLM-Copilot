import * as vscode from 'vscode';
import { VllmChatModelProvider } from './provider.js';
import { getConfig, validateConfig, normalizeServerUrl } from './config.js';
import { FileLogger } from './logger.js';
import { registerAddServerModelCommand, registerConfigureUtilityModelCommand, registerAutoConfigureModelCommand, ensureByokUtilityDefault, ensureAgentHostModelsEnabled } from './autoConfig.js';
import { setSessionManagerOutput } from './sessionManager.js';
import { syncBundledPersonalities } from './personalityStore.js';
import { readServers } from './configStore.js';
import { resolveServer } from './serverRegistry.js';
import {
  registerTestAndRefreshModelsCommand,
  registerDiagnoseConnectionCommand,
  registerOpenLogFileCommand,
  registerClearLogFilesCommand,
  registerCleanSessionsCommand,
  registerSetModelPersonalityCommand,
  registerUpdateServerAuthCommand,
  registerRenameServerCommand,
  registerRemoveServerCommand,
  registerRemoveModelCommand,
  registerResetUsageCommand,
  registerConfigureCostCommand,
} from './commands.js';
import { setExtensionVersion } from './diagnostics.js';
import { initUsageStore } from './usageStore.js';
import { maybeOfferOutputLengthMigration } from './outputLengthMigration.js';
import { maybeRunServerRegistryMigration, registerUndoServerRegistryMigration } from './serverRegistryMigration.js';
import { DashboardTreeProvider } from './dashboard.js';
import { ServerSettingsViewProvider } from './serverSettingsView.js';
import { openDeepDive } from './deepDiveView.js';
import { registerConfigSchemaTool } from './configSchemaTool.js';

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

    // Running locally while connected to a remote — notify user and offer to install on the remote host.
    if (vscode.env.remoteName && context.extension.extensionKind === vscode.ExtensionKind.UI) {
      const remoteHost = vscode.env.remoteName;
      outputChannel.appendLine(`[WARN] Extension is running locally while connected to ${remoteHost} remote — it must be installed on the remote to function.`);
      const helpAction = `Show Me`;
      vscode.window.showWarningMessage(
        `vLLM-Copilot is not installed on the ${remoteHost} remote. Chat features will not work until installed.`,
        helpAction,
        'Dismiss'
      ).then((choice) => {
        if (choice === helpAction) {
          outputChannel.appendLine(`[INFO] User triggered install flow for ${remoteHost} remote.`);
          // Open Extensions view with our extension pre-searched so the user sees
          // the "Install on {remote}" button. We can't install remotely from a local
          // UI extension — VS Code API always installs to the current host.
          vscode.commands.executeCommand('workbench.extensions.search', 'System-Sciences.vllm-copilot');
          // After installing, the user needs to reload. We can't detect when the
          // remote install completes, so they'll see the same popup again on reload
          // if they dismiss it.
          vscode.window.showInformationMessage(
            `After installing on ${remoteHost}, reload the window to activate vLLM-Copilot. Enable \`extensions.autoUpdate\` in settings to get automatic updates.`,
            'Dismiss'
          );
        }
      });
    }

    // publisher/name changes.
    setExtensionVersion(context.extension.packageJSON.version);

    // Wire output channel to sessionManager for logging
    setSessionManagerOutput(outputChannel, context.globalStorageUri.fsPath);

    // Initialize usage store (last request + cumulative token/cost tracking).
    // Must run before any request can complete so the persisted counters load
    // and the change event is live for the dashboard.
    context.subscriptions.push(initUsageStore(context, outputChannel));

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
        if (e.affectsConfiguration('vllm-copilot.logBodyLimit')) {
          // The logger reads logBodyLimit at write time; apply a mid-session
          // change in place without rotating the active log file.
          const limit = vscode.workspace.getConfiguration('vllm-copilot').get<number>('logBodyLimit');
          fileLogger.setLogBodyLimit(typeof limit === 'number' ? limit : 4000);
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

    // One-time, silent server registry migration: moves per-model server facts
    // into vllm-copilot.servers and rewrites models to { server } refs. Must
    // complete before the output-length offer below, which identifies models by
    // { id, serverUrl } — that key no longer exists after the rewrite.
    context.subscriptions.push(registerUndoServerRegistryMigration(context, outputChannel));
    await maybeRunServerRegistryMigration(context, outputChannel);

    // One-time activation summary
    const fullConfig = await getConfig(context);
    outputChannel.appendLine(`[INFO] vLLM-Copilot activated (${fullConfig.models.length} model(s) configured)`);

    // Validate config values
    const warnings = validateConfig(fullConfig);
    for (const w of warnings) {
      outputChannel.appendLine(`[WARN] Config: ${w}`);
    }

    // Heal stale global copies of bundled presets. Personalities are copied to
    // global storage when applied and referenced by absolute path from there;
    // without this sync, models kept the rules from whenever the personality
    // was last re-applied, so preset updates (e.g. Agents-window rules) never
    // reached existing users until manual re-selection.
    try {
      const { updated } = await syncBundledPersonalities(context);
      if (updated.length > 0) {
        outputChannel.appendLine(
          `[INFO] Refreshed ${updated.length} out-of-date personality preset(s) in global storage: ${updated.join(', ')}`
        );
      }
    } catch (err) {
      outputChannel.appendLine(
        `[WARN] Personality preset sync failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Ensure BYOK utility model default is set so MCP servers + agent mode work
    // with vLLM models. This is idempotent — does nothing if already configured.
    if (fullConfig.models.length > 0) {
      ensureByokUtilityDefault().catch(err => {
        outputChannel.appendLine(`[WARN] Failed to set BYOK utility model default: ${err}`);
      });
      // Opt our models into Agent Host sessions (the 1.135 "Open in Agents"
      // window): chat.agentHost.byokModels.enabled + our own
      // extensions.supportAgentsWindow entry. Idempotent, respects explicit
      // user values, silently skipped on VS Code builds without these
      // settings. Takes effect after the agent host process restarts.
      ensureAgentHostModelsEnabled().catch(err => {
        outputChannel.appendLine(`[WARN] Failed to enable Agent Host model access: ${err}`);
      });
    }

    provider = new VllmChatModelProvider(context, outputChannel, fileLogger);
    const activeProvider = provider;
    context.subscriptions.push(activeProvider);
    context.subscriptions.push(
      vscode.lm.registerLanguageModelChatProvider(VENDOR_ID, activeProvider)
    );

    // One-time offer: give pre-1.35 model entries an Output length menu
    // (offline — preset match + the user's own max_tokens values only).
    // Fire-and-forget like the BYOK ensure above; failures land in the Output channel.
    maybeOfferOutputLengthMigration(context, outputChannel).catch(err => {
      outputChannel.appendLine(`[WARN] Output length migration offer failed: ${err}`);
    });

    // Expose the model-entry schema to Copilot Chat as an on-demand LM tool so
    // the user's AI can build valid vllm-copilot.models entries (server, params,
    // modelModes) instead of guessing. Served from the bundled schema file —
    // no workspace scaffolding required.
    context.subscriptions.push(
      registerConfigSchemaTool(context.extensionUri, outputChannel)
    );

    // Register all user-facing commands. Each returns a Disposable (see commands.ts
    // and the commands/ flow modules). Test & Refresh is the central workflow; Add Server &
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
      registerRenameServerCommand(context, activeProvider, outputChannel),
      registerRemoveServerCommand(context, activeProvider, outputChannel),
      registerRemoveModelCommand(context, activeProvider, outputChannel),
      registerResetUsageCommand(outputChannel),
      registerConfigureCostCommand(context, outputChannel),
    );

    // Deep-Dive: open editor-area webview for a single server
    context.subscriptions.push(
      vscode.commands.registerCommand('vllm-copilot.openDeepDive', async (arg?: any) => {
        const servers = readServers();
        // Resolve the target server entry: from a tree item's server id, or by
        // matching a URL argument against the registry.
        const argUrl = typeof arg === 'string' ? arg : arg?.serverUrl;
        const argId = typeof arg === 'object' ? arg?.server : undefined;
        const entry = argId
          ? servers.find(s => s.id === argId)
          : argUrl
            ? servers.find(s => normalizeServerUrl(s.serverUrl) === normalizeServerUrl(argUrl))
            : undefined;
        if (!entry) {
          vscode.window.showErrorMessage(argUrl ? `No registered server matches "${argUrl}".` : 'Server not provided.');
          return;
        }
        const serverType = entry.serverType ?? 'vllm';
        // Deep-Dive is a vLLM metrics view — non-vLLM backends don't expose
        // /metrics, so the panel would be all empty rows. Guard even though the
        // context menu already hides it for non-vLLM servers (defense in depth).
        if (serverType !== 'vllm') {
          vscode.window.showInformationMessage(
            `Deep-Dive is a vLLM-only view. ${serverType} servers don't expose vLLM metrics (KV cache, throughput, TTFT).`
          );
          return;
        }
        const resolved = resolveServer(entry.id, servers);
        if (!resolved) {
          vscode.window.showErrorMessage(`Server "${entry.id}" could not be resolved.`);
          return;
        }
        const displayName = entry.serverType === 'openrouter' ? undefined : entry.displayName?.trim() || undefined;
        openDeepDive(resolved.serverUrl, resolved.requestHeaders, serverType, context, outputChannel, displayName);
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
          ignoreFocusOut: true,
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
