import * as vscode from 'vscode';

/**
 * VS Code setting key for BYOK utility model default (introduced in 1.128).
 * Full path: chat.byokUtilityModelDefault
 * Section-scoped key (for use with getConfiguration('chat')): byokUtilityModelDefault
 */
const BYOK_UTILITY_MODEL_DEFAULT_SECTION_KEY = 'byokUtilityModelDefault';

/**
 * When set to 'mainAgent', VS Code will use the currently selected BYOK model
 * for both main chat and utility tasks (titles, commit messages, etc.).
 */
const MAIN_AGENT_BYOK_UTILITY_MODEL_DEFAULT = 'mainAgent';

/**
 * Ensure that `chat.byokUtilityModelDefault` is set to `'mainAgent'` so that
 * VS Code uses the selected BYOK model for utility flows (titles, commit
 * messages, intent detection). Without this, agent mode with MCP servers
 * (which triggers utility model resolution) fails with:
 * "No utility model is configured for 'copilot-utility-small' while the
 * selected main agent model is BYOK."
 *
 * This is idempotent — if already set, it does nothing.
 * @internal Exported for testing.
 */
export async function ensureByokUtilityDefault(): Promise<void> {
  const chatConfig = vscode.workspace.getConfiguration('chat');
  const inspected = chatConfig.inspect(BYOK_UTILITY_MODEL_DEFAULT_SECTION_KEY);
  // The setting was introduced in VS Code 1.128. On older versions it is not a
  // registered configuration, so writing it throws "not a registered
  // configuration". A registered setting always reports a defaultValue; its
  // absence means this VS Code build doesn't know the setting — bail out.
  if (inspected?.defaultValue === undefined) return;
  // Only set if the user hasn't explicitly written it to settings.json.
  const hasExplicitValue =
    inspected.globalValue !== undefined ||
    inspected.workspaceValue !== undefined;
  if (!hasExplicitValue) {
    try {
      await chatConfig.update(
        BYOK_UTILITY_MODEL_DEFAULT_SECTION_KEY,
        MAIN_AGENT_BYOK_UTILITY_MODEL_DEFAULT,
        vscode.ConfigurationTarget.Global
      );
    } catch {
      // Not writable on this VS Code build — ignore (older versions).
    }
  }
}

/**
 * VS Code setting keys for the Agent Host (VS Code 1.135+, experimental). The
 * "Open in Agents" window runs Copilot-harness sessions in a separate Agent
 * Host process that does NOT see LanguageModelChatProvider models unless
 * BYOK/extension-provider models are explicitly allowed:
 * - `chat.agentHost.byokModels.enabled` — exposes provider models to agent-host
 *   sessions (docs: "AI language models in VS Code", BYOK note).
 * - `extensions.supportAgentsWindow` — opt-in map deciding which extensions
 *   activate inside the Agents window (docs: "Use the Agents window").
 * Both are gated on registration at runtime (absent on older builds) and take
 * effect only after the agent host process restarts.
 */
const AGENT_HOST_BYOK_MODELS_SECTION_KEY = 'agentHost.byokModels.enabled';
const SUPPORT_AGENTS_WINDOW_SECTION_KEY = 'supportAgentsWindow';
/** Publisher-qualified id — must match package.json (publisher.name). */
const OUR_EXTENSION_ID = 'System-Sciences.vllm-copilot';

/**
 * Enable our models inside Agent Host sessions ("Open in Agents" window).
 *
 * Same rules as {@link ensureByokUtilityDefault}: unregistered setting on this
 * VS Code build → skip; the user has written an explicit value → respect it,
 * including an explicit `false` (that is an opt-out, not an oversight). For
 * `supportAgentsWindow` (a map), only OUR key is considered — other
 * extensions' entries are preserved, and only a missing entry is added.
 *
 * @internal Exported for testing.
 */
export async function ensureAgentHostModelsEnabled(): Promise<void> {
  const chatConfig = vscode.workspace.getConfiguration('chat');
  const byokInspected = chatConfig.inspect(AGENT_HOST_BYOK_MODELS_SECTION_KEY);
  // Absent defaultValue = this VS Code build doesn't know the setting (pre-1.135).
  if (
    byokInspected?.defaultValue !== undefined &&
    byokInspected.globalValue === undefined &&
    byokInspected.workspaceValue === undefined
  ) {
    try {
      await chatConfig.update(
        AGENT_HOST_BYOK_MODELS_SECTION_KEY,
        true,
        vscode.ConfigurationTarget.Global
      );
    } catch {
      // Not writable on this VS Code build — ignore.
    }
  }

  const extConfig = vscode.workspace.getConfiguration('extensions');
  const windowInspected = extConfig.inspect(SUPPORT_AGENTS_WINDOW_SECTION_KEY);
  if (windowInspected?.defaultValue !== undefined) {
    const current =
      extConfig.get<Record<string, boolean>>(SUPPORT_AGENTS_WINDOW_SECTION_KEY) ?? {};
    if (current[OUR_EXTENSION_ID] === undefined) {
      try {
        await extConfig.update(
          SUPPORT_AGENTS_WINDOW_SECTION_KEY,
          { ...current, [OUR_EXTENSION_ID]: true },
          vscode.ConfigurationTarget.Global
        );
      } catch {
        // Not writable on this VS Code build — ignore.
      }
    }
  }
}

/**
 * Register the "Configure Utility Model" command: choose between using the
 * main agent model, GitHub Copilot, or none for utility flows. Manual
 * counterpart to the auto-configuration above.
 */
export function registerConfigureUtilityModelCommand(
  output: vscode.OutputChannel
): vscode.Disposable {
  return vscode.commands.registerCommand('vllm-copilot.configureUtilityModel', async () => {
    const chatConfig = vscode.workspace.getConfiguration('chat');
    const current = chatConfig.get<string>(BYOK_UTILITY_MODEL_DEFAULT_SECTION_KEY);

    const pick = await vscode.window.showQuickPick(
      [
        {
          label: 'Main Agent Model',
          description: `Use the selected BYOK model for utility tasks (recommended)${current === MAIN_AGENT_BYOK_UTILITY_MODEL_DEFAULT ? ' ● Current' : ''}`,
          value: MAIN_AGENT_BYOK_UTILITY_MODEL_DEFAULT,
        },
        {
          label: 'GitHub Copilot',
          description: `Use Copilot's built-in utility models${current === 'copilot' ? ' ● Current' : ''}`,
          value: 'copilot',
        },
        {
          label: 'None',
          description: `No utility model (utility flows will fail with BYOK)${current === 'none' || !current ? ' ● Current' : ''}`,
          value: 'none',
        },
      ],
      {
        ignoreFocusOut: true,
        placeHolder: 'Select utility model behavior for BYOK models',
      }
    );

    if (!pick) return;

    await chatConfig.update(
      BYOK_UTILITY_MODEL_DEFAULT_SECTION_KEY,
      pick.value,
      vscode.ConfigurationTarget.Global
    );

    output.appendLine(`[INFO] BYOK utility model default set to '${pick.value}'`);
    vscode.window.showInformationMessage(
      `Utility model default: ${pick.label}`
    );
  });
}
