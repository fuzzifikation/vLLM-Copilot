/**
 * The bridge's own settings, plus the read-only view of vLLM-Copilot's
 * registry. The registry is NOT copied into our settings: it lives in
 * `vllm-copilot.servers` / `vllm-copilot.models`, and the settings API is both
 * the read path and the change notification (affectsConfiguration), which is
 * how the main extension's own dashboard sees edits too. Reading it through a
 * second config key would create a second truth to fall out of sync.
 */
import * as vscode from 'vscode'
import { isSafeVersionSpec } from './runtime.js'

const MAIN_EXT_ID = 'System-Sciences.vllm-copilot'
const MAIN_PREFIX = 'vllm-copilot'

/** Mirrors `ModelConfig` / `ServerEntry` from the main extension's core, the
 *  subset the snapshot needs. Structural, because we never import their code
 *  here: the settings value IS the contract across the extension boundary. */
export interface RegistryServer {
  /** The real registry entries carry far more than the snapshot needs, so the
   *  extra fields pass through rather than being filtered away. */
  [key: string]: unknown
  id: string
  displayName?: string
  serverType?: string
  serverUrl: string
  requestHeaders?: Record<string, string>
}

export interface RegistryModel {
  [key: string]: unknown
  id: string
  vllmModelId?: string
  displayName?: string
  server: string
  /** Capability flags as the vLLM-Copilot config declares them. The adapter
   *  reads `imageInput` for two decisions: what dsh's picker advertises as
   *  input modalities, and whether image blocks are resolved to bytes at all.
   *  Declared here so the pass-through is a named contract, not an accident;
   *  the round trip through the snapshot is tripwired in bridge.test.js. */
  capabilities?: { toolCalling?: boolean; imageInput?: boolean }
  maxOutputTokens?: number | number[]
  contextWindow?: number
  defaultParams?: Record<string, unknown>
  modelModes?: Record<string, Record<string, unknown>>
  defaultMode?: string
  systemMessageReplacementsFile?: string
  personality?: string
}

export interface RegistrySnapshot {
  servers: RegistryServer[]
  models: RegistryModel[]
}

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

export function readBridgeSettings(cfg = vscode.workspace.getConfiguration('dsh-bridge')): BridgeSettings {
  return {
    dshVersion: safeVersionSpec(cfg.get<string>('dshVersion')),
    defaultModelId: cfg.get<string>('defaultModelId')?.trim() ?? '',
    title: auxChoice(cfg.get('titleModel'), cfg.get('titleMaxTokens')),
    compaction: auxChoice(cfg.get('compactionModel'), cfg.get('compactionMaxTokens')),
    drainTimeoutSeconds: seconds(cfg.get('drainTimeoutSeconds'), 120, 0),
    ingestIntervalSeconds: seconds(cfg.get('ingestIntervalSeconds'), 10, 2),
  }
}

/**
 * The main extension's registry, read from its own settings keys. Returns
 * empty arrays when the companion is absent: the bridge stays polite and dark
 * rather than inventing a registry.
 */
export function readMainRegistry(cfg = vscode.workspace.getConfiguration(MAIN_PREFIX)): RegistrySnapshot {
  const servers = (cfg.get<RegistryServer[]>('servers') ?? []).filter((s) => s && typeof s.id === 'string' && typeof s.serverUrl === 'string')
  const models = (cfg.get<RegistryModel[]>('models') ?? []).filter((m) => m && typeof m.id === 'string' && typeof m.server === 'string')
  return { servers, models }
}

export function mainExtensionInstalled(): boolean {
  return vscode.extensions.getExtension(MAIN_EXT_ID) !== undefined
}

export { MAIN_EXT_ID, MAIN_PREFIX }
