/**
 * Copilot entry adapter for request assembly. Converts the vscode-typed
 * request into the neutral {@link AssembleRequestInput} and delegates to the
 * core assembler (core/request/assemble.ts). The core never sees VS Code chat
 * types; this module is where they die.
 */
import * as vscode from 'vscode';
import { convertMessages } from './messageConverter.js';
import { readPickerSelection } from '../state/config.js';
import {
  assembleRequest,
  type AssembleRequestInput,
  type BuildRequestResult,
} from '../core/request/assemble.js';
import type { VllmConfig } from '../core/config/config.js';

/**
 * Assemble the vLLM chat request for one Copilot response call.
 *
 * Collaborators are explicit: the config (for overrides/params) and an output
 * channel for diagnostics. The provider instance is never passed in.
 */
export function buildRequest(
  model: vscode.LanguageModelChatInformation,
  messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions,
  config: VllmConfig,
  output: vscode.OutputChannel,
): BuildRequestResult {
  // The global `fixEmptyToolParameters` setting (see assembleRequest) is read
  // here because this adapter owns the vscode settings source.
  const fixEmptyToolParameters = vscode.workspace
    .getConfiguration('vllm-copilot')
    .get<boolean>('fixEmptyToolParameters', true);

  // Convert VS Code messages to OpenAI format.
  // NOTE: VS Code Copilot injects all user-authored instruction files into the
  // system message — .github/copilot-instructions.md, AGENTS.md, and CLAUDE.md
  // (when their respective settings are enabled). No need to re-read or prepend
  // them here; the system message arrives complete from VS Code.
  // NOTE: System message replacements were applied before this method was called,
  // so the messages parameter already contains transformed system messages.
  const openaiMessages = convertMessages(messages);

  // Mode + output-length pick, read through the same shared reader the provider
  // uses for tracking (single parse, audit P1-1). The pick already outranks
  // mode/defaultParams max_tokens inside resolveMaxTokensForRequest, where the
  // ceiling clamp also lives: a stale cached schema can never push max_tokens
  // above what Copilot was told the model can do.
  const { selectedMode, pickerTokens } = readPickerSelection(options);

  // Copilot carries its stable per-chat identity as private model metadata.
  // Strip it here so the private `_conversationId` key never reaches the core
  // or the wire.
  const runtimeOptions = { ...options.modelOptions };
  const conversationId = runtimeOptions._conversationId;
  delete runtimeOptions._conversationId;

  return assembleRequest(
    {
      modelId: model.id,
      selectedMode,
      pickerTokens,
      openaiMessages,
      runtimeOptions,
      conversationId,
      tools: options.tools,
      toolModeRequired: options.toolMode === vscode.LanguageModelChatToolMode.Required,
      fixEmptyToolParameters,
      advertisedMaxOutputTokens: model.maxOutputTokens,
    },
    config,
    output
  );
}
