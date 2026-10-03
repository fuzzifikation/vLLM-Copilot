/**
 * Instance-owned system-message pipeline: prompt replacement + capture —
 * the Copilot host half. The rule loading/resolution lives in
 * `core/persona`, and the capture merge/atomic-write queue lives in
 * `core/persona/capture`. This class owns only what speaks Copilot's
 * vocabulary: reading the `systemMessageCapture` setting, extracting text
 * from `LanguageModelChatRequestMessage`s, wrapping transformed text back
 * into new editor message objects, and resolving the capture file path from
 * the workspace root.
 *
 * The provider owns one pipeline instance. Collaborators are explicit: an
 * output channel for logging and a capture writer for persistence. The
 * pipeline never sees the provider.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { resolveOverrideForModel, type VllmConfig } from '../core/config/config.js';
import { messageToText } from './messageConverter.js';
import {
  loadPromptReplacements,
  applyPromptReplacements,
  type PromptReplacement,
} from '../core/persona/promptReplacer.js';
import {
  CaptureQueue,
  type CaptureEntry,
  type CaptureWriter,
} from '../core/persona/capture.js';
import { resolveModelReplacements } from '../persona/personalityStore.js';
import { resolveWorkspaceRelativePath } from '../state/config.js';

export type { CaptureEntry, CaptureWriter } from '../core/persona/capture.js';

export class SystemMessagePipeline {
  private readonly captureWriter: CaptureWriter;

  /** Core merge/atomic-write queue (instance-owned, serialized). */
  private readonly captureQueue = new CaptureQueue();

  constructor(
    private readonly output: vscode.OutputChannel,
    captureWriter?: CaptureWriter,
    /** Extension context for portable personality resolution (this machine's
     *  seeded preset copies). Optional: tests and headless callers keep the
     *  plain path semantics. */
    private readonly context?: vscode.ExtensionContext,
  ) {
    // Default writer: capture entries to .vllm/system-messages.json
    // (fire-and-forget, serialized). `captureEntries` already contains every
    // NON-EMPTY system message from the turn — replaced and passthrough
    // alike; empty-text system messages pass through uncaptured (see the
    // `!receivedContent` branch in processSystemMessages) — so there is no
    // separate passthrough pass here. Deduplication is by `receivedContent`.
    this.captureWriter = captureWriter ?? (async (captureEntries: CaptureEntry[]) => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders?.length || captureEntries.length === 0) return;

      const targetPath = path.join(folders[0].uri.fsPath, '.vllm', 'system-messages.json');

      // Deduplicate within this request (shouldn't happen, but guard against it)
      const uniqueEntries = Array.from(
        new Map(captureEntries.map(e => [e.receivedContent, e])).values()
      );

      await this.enqueueWrite(targetPath, uniqueEntries);
    });
  }

  /**
   * Apply prompt replacements, capture to disk, return processed messages.
   *
   * Replacements are applied to a clone — VS Code's original messages are never mutated
   * (prevents cross-turn corruption). Capture is opt-in via `systemMessageCapture` setting.
   *
   * Flow: read original text → apply rules → create new message objects → capture → return.
   */
  async processSystemMessages(
    model: vscode.LanguageModelChatInformation,
    originalMessages: readonly vscode.LanguageModelChatRequestMessage[],
    config: VllmConfig
  ): Promise<vscode.LanguageModelChatRequestMessage[]> {
    // Self-catching by contract (streamOrchestrator relies on it): a failure
    // here must degrade to the ORIGINAL messages — chat continues without
    // personality — instead of erroring the whole turn. The rule loaders are
    // individually guarded; the outer catch covers `getConfiguration` and the
    // message-iteration surface, pinned by "falls back to the original
    // messages when the pipeline itself throws".
    try {
      const override = resolveOverrideForModel(config.models, model.id);

      // Load replacement rules for the model's override (relative paths resolve
      // against the workspace root). Load failures are swallowed HERE (warn, no
      // replacements) so the capture path stays alive even when the file is broken.
      let replacements: PromptReplacement[] = [];
      if (override && (override.personality || override.systemMessageReplacementsFile)) {
        // ONE resolver for chat and Model Settings (personalityStore) — a
        // name reference resolves to this machine's seeded preset, and a path
        // stored on another OS whose basename names a shipped preset remaps to
        // the local copy instead of silently running vanilla.
        const resolved = await resolveModelReplacements(
          this.context, override, (msg) => this.output.appendLine(`[INFO] ${msg}`),
        );
        if (resolved) {
          // One load, includes already spliced at their positions: rule order
          // (persona first, then the shared-removals include) is data inside
          // the file, not code. The loader degrades a broken,
          // missing, or cyclic include to skip-with-warning — one bad reference
          // never discards the file's own rules, and Default (no file) still
          // gets zero replacements, so the vanilla prompt stays untouched.
          try {
            replacements = await loadPromptReplacements(resolved.sourcePath, (msg) =>
              this.output.appendLine(`[WARN] ${msg}`));
          } catch (err) {
            this.output.appendLine(`[WARN] Personality replacements failed to load, continuing without it: ${err instanceof Error ? err.message : String(err)}`);
          }
          if (replacements.length > 0) {
            this.output.appendLine(
              `[INFO] Loaded ${replacements.length} replacement rule(s) from ${resolved.sourcePath}`
            );
          }
        } else if ((override.systemMessageReplacementsFile || '').trim()) {
          this.output.appendLine(
            `[WARN] Replacements file not found: ${resolveWorkspaceRelativePath(override.systemMessageReplacementsFile!)}`
          );
        }
      }

      const cfg = vscode.workspace.getConfiguration('vllm-copilot');
      const captureEnabled = cfg.get<boolean>('systemMessageCapture', false);
      if (!replacements.length && !captureEnabled) return [...originalMessages];

      // Build new message array. Replaced system messages get NEW objects;
      // non-system messages pass through by reference (they're never mutated).
      const replacedMessages: vscode.LanguageModelChatRequestMessage[] = [];
      const captureEntries: CaptureEntry[] = [];

      for (const msg of originalMessages) {
        if (msg.role === vscode.LanguageModelChatMessageRole.User ||
            msg.role === vscode.LanguageModelChatMessageRole.Assistant) {
          replacedMessages.push(msg);
          continue;
        }

        const receivedContent = messageToText(msg);
        if (!receivedContent) {
          replacedMessages.push(msg);
          continue;
        }

        if (!replacements.length) {
          replacedMessages.push(msg);
          captureEntries.push({
            receivedContent,
            deliveredContent: receivedContent,
            rulesApplied: [],
          });
          continue;
        }

        const applied = applyPromptReplacements(receivedContent, replacements);

        // Create a NEW message object — VS Code's original stays pristine
        replacedMessages.push({
          role: msg.role,
          content: [new vscode.LanguageModelTextPart(applied.result)],
          name: (msg as any).name,
        } as vscode.LanguageModelChatRequestMessage);

        captureEntries.push({
          receivedContent,
          deliveredContent: applied.result,
          rulesApplied: applied.matchedRuleNames,
        });
      }

      // Capture to disk (opt-in, fire-and-forget)
      if (captureEnabled && captureEntries.length > 0) {
        this.captureWriter(captureEntries).catch(err => {
          this.output.appendLine(`[WARN] System message capture failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      }

      return replacedMessages;
    } catch (err) {
      this.output.appendLine(`[WARN] System message pipeline failed: ${err instanceof Error ? err.message : String(err)}`);
      return [...originalMessages];
    }
  }

  /**
   * Read existing capture file, merge new entries, write back — core
   * {@link CaptureQueue} semantics over the caller's explicit target path.
   * Serialized via the promise queue so concurrent writes never race.
   */
  async enqueueWrite(
    targetPath: string,
    newEntries: CaptureEntry[]
  ): Promise<void> {
    await this.captureQueue.enqueueWrite(targetPath, newEntries, this.output);
  }
}
