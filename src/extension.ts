import * as vscode from 'vscode';
import { VllmChatModelProvider } from './provider/provider.js';
import { getConfig, validateConfig } from './state/config.js';
import { FileLogger } from './shared/logger.js';
import { registerAddServerModelCommand, registerAddServerCommand } from './commands/addServerFlow.js';
import { registerAutoConfigureModelCommand } from './commands/autoConfigureFlow.js';
import {
  registerConfigureUtilityModelCommand,
  ensureByokUtilityDefault,
  ensureAgentHostModelsEnabled,
} from './commands/byok.js';
import { setSessionManagerOutput } from './shared/sessionManager.js';
import { syncBundledPersonalities } from './persona/personalityStore.js';
import { readServers, writeServers } from './state/configStore.js';
import { dedupeServerIds } from './state/serverRegistry.js';
import { resetOpenRouterCaches } from './backends/openRouter.js';
import { registerSetPollIntervalCommand } from './ui/vllmMetrics.js';
import {
  registerDiagnoseConnectionCommand,
  registerOpenLogFileCommand,
  registerClearLogFilesCommand,
  registerCleanSessionsCommand,
  registerUpdateServerAuthCommand,
  registerRenameServerCommand,
  registerRemoveServerCommand,
  registerRemoveModelCommand,
  registerResetUsageCommand,
  registerConfigureCostCommand,
} from './commands/commands.js';
import { registerTestAndRefreshModelsCommand } from './commands/testAndRefresh.js';
import { registerSetModelPersonalityCommand } from './commands/personality.js';
import { setExtensionVersion } from './ui/diagnostics.js';
import { initUsageStore } from './usage/usageStore.js';
import { maybeOfferOutputLengthMigration } from './migrations/outputLengthMigration.js';
import { maybeRunServerRegistryMigration } from './migrations/serverRegistryMigration.js';
import { DashboardTreeProvider } from './ui/dashboard.js';
import { ServerSettingsViewProvider } from './ui/serverSettingsView.js';
import { registerOpenDeepDiveCommand } from './ui/deepDiveView.js';
import { registerConfigSchemaTool } from './shared/configSchemaTool.js';

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
      outputChannel.appendLine(`[WARN] Extension is running locally while connected to ${remoteHost} remote - it must be installed on the remote to function.`);
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
    // and the change event is live for the dashboard. Awaited: the load may
    // read the shared usage.json from disk before the first request records.
    context.subscriptions.push(await initUsageStore(context, outputChannel));

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
        // Provider lists are display data tied to the configured servers and
        // models: flush the shared endpoints cache (values, in-flight dedup,
        // AND failure backoff) when they change, so an auth rotation, a
        // server edit, or a fixed URL serves a fresh provider dropdown on the
        // next view instead of a stale list for up to a 5-minute TTL. Every
        // write path (commands, webview, hand-edited settings.json) fires
        // this event, so this is the one choke point that covers them all.
        if (e.affectsConfiguration('vllm-copilot.servers') || e.affectsConfiguration('vllm-copilot.models')) {
          resetOpenRouterCaches();
        }
      })
    );

    // Duplicate server ids are an extension-owned invariant: the extension
    // mints them (generateServerId), so a hand-edited collision is REPAIRED,
    // not tolerated. The first occurrence keeps its id (exactly what requests
    // already resolve to, so no model changes server); later duplicates get
    // counter suffixes and become visible and addressable instead of shadowed
    // dead config. Runs BEFORE the registry migration, whose connection-reuse
    // could otherwise bind a migrated model to a shadowed id. Models that
    // referenced the duplicate id are deliberately NOT repointed — which
    // entry they "meant" is unresolvable, and their resolution (first entry)
    // is unchanged by the rename. If the write is blocked, the first-wins
    // runtime rule still keeps every request honest until the settings heal.
    {
      const { servers: repairedServers, renames } = dedupeServerIds(readServers());
      if (renames.length > 0) {
        const list = renames.map(r => `"${r.from}" → "${r.to}"`).join(', ');
        outputChannel.appendLine(`[INFO] Server registry: duplicate ids repaired: ${list}.`);
        try {
          await writeServers(repairedServers);
          void vscode.window.showInformationMessage(
            `vLLM-Copilot: duplicate server ids found in settings - renamed so every entry stays usable: ${list}.`
          );
        } catch (err) {
          outputChannel.appendLine(
            `[ERROR] Server registry repair could not write the renamed ids - until settings.json is fixed, requests reach the FIRST entry of each duplicate id. ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }

    // One-time, silent server registry migration: moves per-model server facts
    // into vllm-copilot.servers and rewrites models to { server } refs. Must
    // complete before the output-length offer below, which addresses models by
    // { id, server } — a ref that only exists after the rewrite.
    await maybeRunServerRegistryMigration(context, outputChannel);

    // One-time activation summary
    const fullConfig = await getConfig();
    outputChannel.appendLine(`[INFO] vLLM-Copilot activated (${fullConfig.models.length} model(s) configured)`);

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

    // Config validation runs AFTER provider registration and inside its own
    // try: it is a courtesy report on hand-edited settings, never a gate on
    // the extension's life. Running it before the provider existed meant one
    // thrower here reached activate()'s outer catch and left the session
    // extension-dead over one unquoted setting value.
    try {
      for (const w of validateConfig(fullConfig)) {
        outputChannel.appendLine(`[WARN] Config: ${w}`);
      }
    } catch (err) {
      outputChannel.appendLine(
        `[WARN] Config validation failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`
      );
    }

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
      registerAddServerCommand(outputChannel),
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
      registerOpenDeepDiveCommand(context, outputChannel),
      registerSetPollIntervalCommand(),
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
