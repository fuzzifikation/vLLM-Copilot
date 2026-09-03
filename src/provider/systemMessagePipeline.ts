import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { resolveOverrideForModel, resolveWorkspaceRelativePath, type VllmConfig } from '../config.js';
import { messageToText } from '../messageConverter.js';
import {
  loadPromptReplacements,
  applyPromptReplacements,
  getBundledCommonReplacementsPath,
  type PromptReplacement,
} from '../promptReplacer.js';

/**
 * Capture entry for a single system message, written to .vllm/system-messages.json.
 */
export interface CaptureEntry {
  receivedContent: string;
  deliveredContent: string;
  rulesApplied: string[];
}

/**
 * Shape guard for entries read back from the capture file. The file is
 * user-editable and written by earlier versions, so members must be validated
 * before any `.receivedContent` access — a malformed member (null, {}, partial)
 * would otherwise throw in the merge or silently persist.
 */
function isCaptureEntry(e: unknown): e is CaptureEntry {
  if (typeof e !== 'object' || e === null) return false;
  const entry = e as Record<string, unknown>;
  return (
    typeof entry.receivedContent === 'string' &&
    typeof entry.deliveredContent === 'string' &&
    Array.isArray(entry.rulesApplied) &&
    entry.rulesApplied.every(r => typeof r === 'string')
  );
}

/**
 * Persistence boundary for captured system messages. {@link SystemMessagePipeline}
 * collects capture entries during transformation and hands them to this writer.
 * Production default is the constructor's own disk writer; tests inject
 * a mock to observe the collected entries without touching the file system.
 */
export type CaptureWriter = (entries: CaptureEntry[]) => Promise<void>;

/**
 * Instance-owned system-message pipeline: prompt replacement + capture.
 *
 * The provider owns one pipeline instance. The write queue is instance-owned
 * (not module-global) for two reasons: concurrent writes from one pipeline are
 * serialized, and provider instances never share mutable module state (a
 * module-global queue would couple instances and silently change ownership).
 * The queue serializes writes within a single pipeline only — it does NOT
 * coordinate two pipelines writing the same file (production creates a single
 * provider, so cross-pipeline writes never occur today).
 *
 * Collaborators are explicit: an output channel for logging and a capture
 * writer for persistence. The pipeline never sees the provider.
 */
export class SystemMessagePipeline {
  /** Promise chain that serializes concurrent writes to system-messages.json. Always resolves. */
  #writeQueue: Promise<void> = Promise.resolve();

  private readonly captureWriter: CaptureWriter;

  constructor(
    private readonly output: vscode.OutputChannel,
    captureWriter?: CaptureWriter,
  ) {
    // Default writer: capture entries to .vllm/system-messages.json
    // (fire-and-forget, serialized). `captureEntries` already contains every
    // system message from the turn — the processor records all of them, both
    // replaced and passthrough — so there is no separate passthrough pass
    // here. Deduplication is by `receivedContent`.
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
    try {
      const override = resolveOverrideForModel(config.models || [], model.id);

      // Load replacement rules for the model's override (relative paths resolve
      // against the workspace root). Load failures are swallowed HERE (warn, no
      // replacements) so the capture path stays alive even when the file is broken.
      let replacements: PromptReplacement[] = [];
      if (override?.systemMessageReplacementsFile) {
        try {
          const replacementsFile = resolveWorkspaceRelativePath(override.systemMessageReplacementsFile);
          let fileExists = true;
          try {
            await fs.access(replacementsFile);
          } catch {
            fileExists = false;
            this.output.appendLine(`[WARN] Replacements file not found: ${replacementsFile}`);
          }
          if (fileExists) {
            // Shared boilerplate removals append to EVERY active personality (Default —
            // no replacements file — never reaches this code path, so the vanilla prompt
            // stays untouched). Order is load-bearing: persona rules run FIRST, because
            // persona replace-rules anchor on text that the shared remove-rules delete
            // (e.g. the short/impersonal line also lives inside the safety blocks).
            const personaRules = await loadPromptReplacements(replacementsFile);
            const commonRules = await loadPromptReplacements(getBundledCommonReplacementsPath());
            replacements = [...personaRules, ...commonRules];
            if (replacements.length > 0) {
              this.output.appendLine(
                `[INFO] Loaded ${personaRules.length} personality + ${commonRules.length} shared replacement rule(s) from ${replacementsFile}`
              );
            }
          }
        } catch (err) {
          this.output.appendLine(`[WARN] Failed to load replacements: ${err instanceof Error ? err.message : String(err)}`);
          replacements = [];
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
   * Read existing capture file, merge new entries, write back.
   * Serialized via the promise queue so concurrent writes never race.
   */
  async enqueueWrite(
    targetPath: string,
    newEntries: CaptureEntry[]
  ): Promise<void> {
    // Chain this write after the previous one, then await it so the caller (and
    // tests) observe completion. The queue always resolves — errors are logged.
    const previous = this.#writeQueue;
    this.#writeQueue = previous.then(async () => {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });

      // Read existing entries
      let allEntries: CaptureEntry[] = [];
      try {
        const existing = await fs.readFile(targetPath, 'utf-8');
        const parsed = JSON.parse(existing);
        if (Array.isArray(parsed)) {
          // The file is user-editable and best-effort, so a valid JSON array may
          // still contain malformed members (null, {}, partial objects). Accessing
          // .receivedContent on those would throw (wedging every future write) or
          // silently persist an invalid entry, so shape-validate before merging.
          const valid = parsed.filter(isCaptureEntry);
          if (valid.length !== parsed.length) {
            this.output.appendLine(
              `[WARN] ${targetPath} had ${parsed.length - valid.length} malformed capture entr(y/ies), dropped`
            );
          }
          allEntries = valid;
        } else {
          this.output.appendLine(`[WARN] ${targetPath} is not a JSON array, starting fresh`);
        }
      } catch (err) {
        if (!(err instanceof Error && 'code' in err && (err as any).code === 'ENOENT')) {
          this.output.appendLine(`[WARN] Failed to read ${targetPath}, starting fresh: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // Merge: new entries overwrite existing ones with the same receivedContent.
      const existingIndex = new Map<string, number>();
      allEntries.forEach((e, i) => existingIndex.set(e.receivedContent, i));

      let newCount = 0;
      let updatedCount = 0;
      for (const entry of newEntries) {
        const idx = existingIndex.get(entry.receivedContent);
        if (idx !== undefined) {
          allEntries[idx] = entry;
          updatedCount++;
        } else {
          allEntries.push(entry);
          newCount++;
        }
      }

      // Write atomically: write to a temp file, then rename over the target so a
      // crash or disk failure mid-write can't leave truncated JSON in place. The
      // previous file survives until the rename completes.
      const tmpPath = `${targetPath}.tmp`;
      await fs.writeFile(tmpPath, JSON.stringify(allEntries, null, 2), 'utf-8');
      await fs.rename(tmpPath, targetPath);
      this.output.appendLine(`[DIAG] Captured ${newCount} new, updated ${updatedCount} existing system message(s) → ${targetPath}`);
    }).catch(err => {
      // Swallow errors so the queue always resolves — a write failure shouldn't block future writes
      this.output.appendLine(`[WARN] Failed to write capture file: ${err instanceof Error ? err.message : String(err)}`);
    });
    await this.#writeQueue;
  }
}
