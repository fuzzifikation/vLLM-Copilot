/**
 * The harness's own settings (`vllm-copilot.harness.*`). The model registry is NOT mirrored here: it lives in
 * `vllm-copilot.servers` / `vllm-copilot.models`, and this extension owns both
 * sides, so the registry readers are `state/config.ts` and the core types.
 * Duplicating the registry under a second key would only create a second truth
 * to fall out of sync.
 */
import * as vscode from 'vscode'
import { isSafeVersionSpec } from './runtime.js'

export interface AuxChoice {
  modelId?: string
  maxTokens?: number
}

export interface BridgeSettings {
  dshVersion: string
  defaultModelId: string
  title: AuxChoice
  compaction: AuxChoice
  /** Grace for in-flight harness requests before a config-restart lands. */
  drainTimeoutSeconds: number
  /** Seconds between outbox ingestion passes. */
  ingestIntervalSeconds: number
  /**
   * Harness personality: a find/replace rules file applied to every system
   * message the harness sends, SESSION-wide (dsh applies one personality per
   * session). Empty = Default = the upstream dsh prompt untouched. This is
   * the harness's OWN choice - Copilot's per-model personality /
   * systemMessageReplacementsFile never flow here, and vice versa.
   */
  personalityFile: string
  /**
   * Harness voice preset NAME (bundled, portable): one of the shipped voices
   * in the extension's own `harness-personalities/` dir, resolved to this
   * install's file at every load. Empty = no preset. When both this and
   * personalityFile are set, the preset name wins; Default clears both.
   * Copilot's per-model `personality` is a DIFFERENT setting and never read here.
   */
  personality: string
  /** Harness system-prompt recording. The live switch is the on-disk consent
   *  marker; this setting is its persistent truth, seeded into the marker at
   *  prepare and written to the marker immediately on change. */
  captureSystemMessages: boolean
}

function seconds(value: unknown, fallback: number, min: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback
}

/**
 * The version spec ends up inside an `npm install` command line, so a stray
 * quote or semicolon in the setting must degrade to the bundled version instead
 * of becoming shell syntax.
 */
function safeVersionSpec(value: unknown): string {
  const spec = typeof value === 'string' ? value.trim() : ''
  return spec && isSafeVersionSpec(spec) ? spec : ''
}

function auxChoice(modelId: unknown, maxTokens: unknown): AuxChoice {
  const choice: AuxChoice = {}
  if (typeof modelId === 'string' && modelId.trim()) choice.modelId = modelId.trim()
  // Floor of 1, matching buildSnapshot: a sub-1 budget must never become 0.
  if (typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0) choice.maxTokens = Math.max(1, Math.floor(maxTokens))
  return choice
}

export function readBridgeSettings(cfg = vscode.workspace.getConfiguration('vllm-copilot.harness')): BridgeSettings {
  return {
    dshVersion: safeVersionSpec(cfg.get<string>('dshVersion')),
    defaultModelId: cfg.get<string>('defaultModelId')?.trim() ?? '',
    title: auxChoice(cfg.get('titleModel'), cfg.get('titleMaxTokens')),
    compaction: auxChoice(cfg.get('compactionModel'), cfg.get('compactionMaxTokens')),
    drainTimeoutSeconds: seconds(cfg.get('drainTimeoutSeconds'), 120, 0),
    ingestIntervalSeconds: seconds(cfg.get('ingestIntervalSeconds'), 10, 2),
    personalityFile: cfg.get<string>('personalityFile')?.trim() ?? '',
    personality: cfg.get<string>('personality')?.trim() ?? '',
    captureSystemMessages: cfg.get<boolean>('captureSystemMessages') === true,
  }
}
