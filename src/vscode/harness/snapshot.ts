/**
 * Build the snapshot payload the adapter plugin loads. Pure on purpose: it
 * takes plain data and returns plain data, so the rules are testable without an
 * extension host.
 *
 * It deliberately does NOT set `version`. The plugin's `parseSnapshot` is the
 * only authority on the snapshot contract, so the writer stamps the version
 * from the staged plugin it is about to ship and then validates its own output
 * through that same loader. A writer that hardcodes a version can drift from
 * the loader it ships with and only find out at harness boot.
 *
 * Rule that drives the shape: pass registry entries through verbatim. The core
 * consumes `ModelConfig[]` / `ServerEntry[]` as-is, and cherry-picking fields
 * here would silently strip a capability the moment upstream adds one.
 */
import path from 'node:path'
import { buildDisplayKeys } from '../../core/index.js'
import type { ModelConfig, ServerEntry } from '../../core/index.js'

export interface AuxChoice {
  modelId?: string
  maxTokens?: number
}

/**
 * The core's served-model verdict (`resolveServedModels`). The core answers;
 * the reaction here is the harness's own posture: only a demonstrated `absent`
 * prunes. `unknown` ("could not ask", including an empty answer) keeps the
 * model offered — a network hiccup must never empty the harness catalog, and
 * "could not ask" is never "serves nothing" (the 0.0.12 accident the core now
 * enforces).
 */
export interface ServedVerdict {
  readonly state: 'served' | 'absent' | 'unknown'
  readonly reason?: string
}

export interface SnapshotInput {
  servers: readonly ServerEntry[]
  models: readonly ModelConfig[]
  /** User preference; falls back to the first usable model when unusable. */
  defaultModelId?: string
  title?: AuxChoice
  compaction?: AuxChoice
  /** Mirrored from `vllm-copilot.fixEmptyToolParameters` so harness requests
   *  and Copilot requests build identical tool payloads. */
  fixEmptyToolParameters?: boolean
  /**
   * The core's served verdict per registry model id (see ServedVerdict). Only
   * `state: 'absent'` prunes — that is what keeps the harness picker honest:
   * a model the server demonstrably stopped serving still lives in the
   * registry, and Copilot's own picker hides it while the raw config would
   * happily offer it to dsh, where selecting it only produces an error toast
   * (the Space Bunny incident, 2026-10-06). A model with NO entry here got no
   * verdict (the resolver could not run at all): everything is offered — the
   * same posture as a probe that cannot reach the server.
   */
  served?: Readonly<Record<string, ServedVerdict | undefined>>
  /**
   * The harness personality: an absolute, readable find/replace file resolved
   * from the HARNESS's own session choice (vllm-copilot.harness.personalityFile),
   * or undefined/empty for Default (upstream prompt untouched). Copilot's
   * per-model personality references are NOT input here and must never be -
   * the two interfaces own independent prompt choices.
   */
  personalityFile?: string
  /**
   * The RAW PROMPT RECORDING target: an ABSOLUTE path inside the window's
   * workspace (`<workspace>/\.vllm\dsh-system-messages.json`), named
   * explicitly by the extension preparing the snapshot - never guessed from
   * cwd or a user home by the plugin. Absent = no destination: recording
   * fails closed (nothing is written anywhere) and chat proceeds untouched.
   * The snapshot carries the PATH only, never prompt text. Ownership follows
   * the last window to prepare: a harness adopted by another window keeps
   * recording into the PREPARING window's workspace until a re-prepare or a
   * fresh start rebinds the snapshot. One shared dsh therefore has exactly
   * one recording destination at a time.
   */
  captureFile?: string
  /** Reasons surfaced to the user rather than dropped silently. */
  onWarning?(message: string): void
}

export interface SnapshotPayload {
  config: { servers: ServerEntry[]; models: ModelConfig[] }
  defaultModelId: string
  aux: Record<string, AuxChoice>
  fixEmptyToolParameters?: boolean
  /** The harness personality file, verbatim from SnapshotInput (absent = Default). */
  personalityFile?: string
  /** The workspace recording target, verbatim from SnapshotInput when it was
   *  an absolute path (absent = recording has no destination and stays off). */
  captureFile?: string
  warnings: string[]
}

function usableAux(
  purpose: string,
  choice: AuxChoice | undefined,
  ids: Set<string>,
  warn: (m: string) => void,
  remap: (modelId: string) => string,
  label: (modelId: string) => string,
): AuxChoice | undefined {
  if (!choice) return undefined
  const out: AuxChoice = {}
  if (choice.modelId) {
    const mapped = remap(choice.modelId)
    // The plugin rejects an unknown aux model id outright, which would brick
    // every request. Dropping a stale choice and saying so beats that.
    if (!ids.has(mapped)) {
      warn(`${purpose} model "${label(choice.modelId)}" is no longer in the registry; the harness will use the default model for it`)
      return undefined
    }
    out.modelId = mapped
  }
  // Floor of 1: a maxTokens of 0.7 is a user reaching for "tiny", and a
  // silent floor to 0 asks the server for an empty completion every time.
  if (typeof choice.maxTokens === 'number' && choice.maxTokens > 0) out.maxTokens = Math.max(1, Math.floor(choice.maxTokens))
  return Object.keys(out).length ? out : undefined
}

/** Folder inside a workspace that holds BOTH capture files. Copilot writes
 *  its `system-messages.json` there; the harness writes its own file below. */
export const HARNESS_CAPTURE_DIRNAME = '.vllm'
/** Harness prompt-recording file name inside the workspace. Deliberately
 *  distinct from Copilot's `system-messages.json` - the two interfaces keep
 *  separate recordings, and neither one's file is ever the other's target. */
export const HARNESS_RECORDING_FILENAME = 'dsh-system-messages.json'

/** The harness recording target for a workspace folder: an explicit, fixed
 *  path under `.vllm\`, beside (never inside) Copilot's recording. */
export function harnessRecordingFileFor(workspaceFolder: string): string {
  return path.join(workspaceFolder, HARNESS_CAPTURE_DIRNAME, HARNESS_RECORDING_FILENAME)
}

/**
 * Which registry entries the harness may offer at all: a server needs an id and
 * a URL, a model needs an id and a server that is still in the registry. Pure
 * configuration admission, no network and no served-model verdict: "could not
 * ask" is never "serves nothing" (see `ServedVerdict`).
 *
 * This is the snapshot's own rule, exported so the install and start paths can
 * ask BEFORE they download anything. The writer below stays the authority: a
 * registry that empties between the guard and `buildSnapshot` still fails there.
 */
export function registryAdmission(
  servers: readonly ServerEntry[],
  models: readonly ModelConfig[],
): { servers: ServerEntry[]; models: ModelConfig[]; dangling: ModelConfig[] } {
  const usable = servers.filter((s) => typeof s?.id === 'string' && typeof s?.serverUrl === 'string')
  const serverIds = new Set(usable.map((s) => s.id))
  const kept: ModelConfig[] = []
  const dangling: ModelConfig[] = []
  for (const model of models) {
    if (typeof model?.id !== 'string') continue
    if (!serverIds.has(model.server)) {
      dangling.push(model)
      continue
    }
    kept.push(model)
  }
  return { servers: usable, models: kept, dangling }
}

/**
 * @throws when no usable model survives, because a snapshot with empty `models`
 * is rejected by the plugin and would leave the harness with no provider at all.
 */
export function buildSnapshot(input: SnapshotInput): SnapshotPayload {
  const warnings: string[] = []
  const warn = (message: string): void => {
    warnings.push(message)
    input.onWarning?.(message)
  }

  const { servers, models, dangling } = registryAdmission(input.servers, input.models)
  for (const model of dangling) {
    warn(`model "${model.displayName ?? model.id}" points at server "${String(model.server)}", which no longer exists; it is not offered to the harness`)
  }
  if (models.length === 0) {
    throw new Error(
      'the vLLM-Copilot registry has no model whose server still exists, so there is nothing to offer the harness. ' +
        'Add a server and a model in vLLM-Copilot settings.',
    )
  }

  // Settings are hand-editable JSON, so `displayName` needs a runtime check
  // before it may pretend to be a label.
  const displayNameOf = (m: ModelConfig | undefined): string | undefined =>
    typeof m?.displayName === 'string' && m.displayName.trim() ? m.displayName.trim() : undefined
  // Friendly text for warnings: users know display names, not generated ids.
  const registryLabel = (modelId: string): string => displayNameOf(models.find((m) => m.id === modelId)) ?? modelId
  // The core's verdict reasons quote the failing fetch, and a fetch error
  // text carries the full server URL. Warnings land in the bridge log and in
  // snapshot.json on disk: private hostnames never ride along.
  const privacySafe = (text: string): string => text.replace(/https?:\/\/\S+/g, '[the server URL]')

  // Drop models the core demonstrably found absent (see ServedVerdict).
  // `unknown` is never pruned: an unaskable server keeps its whole catalog.
  const served = input.served ?? {}
  const offered = models.filter((m) => {
    const verdict = served[m.id]
    if (!verdict || verdict.state !== 'absent') return true
    warn(
      `model "${registryLabel(m.id)}" is not currently served by its server${verdict.reason ? `: ${privacySafe(verdict.reason)}` : ''}; it is not offered to the harness`,
    )
    return false
  })
  if (offered.length === 0) {
    throw new Error(
      'every configured model is currently absent from its server\'s model list, so there is nothing honest to offer the harness. ' +
        'Start the server or refresh the model in vLLM-Copilot settings.',
    )
  }

  // dsh displays the model id wherever it shows the active model, and our
  // registry ids embed hostnames (`<wire> on <host>`), which put private
  // server names on screen in the harness UI. The snapshot's id namespace is
  // the CORE's one display-key rule (`buildDisplayKeys`), so the harness
  // picker, the Copilot picker and the adapter agree on one name per model.
  // It runs over every usable model, before the absent-pruning below, so a
  // neighbour going offline cannot rename a model that stayed. Requests still
  // carry `vllmModelId`; this is display hygiene and hostname scrubbing at
  // once. Old sessions that stored a previous id re-pick once, same as any
  // model removal.
  const displayKeys = buildDisplayKeys(models)
  const oldToNew = new Map<string, string>()
  const newToOld = new Map<string, string>()
  const rekeyed: ModelConfig[] = offered.map((m) => {
    // Every model the filter above let through has a non-empty id, which is
    // exactly what buildDisplayKeys keys on, so the `??` never fires.
    const key = displayKeys.get(m.id) ?? m.id
    oldToNew.set(m.id, key)
    newToOld.set(key, m.id)
    return { ...m, id: key }
  })
  const remap = (modelId: string): string => oldToNew.get(modelId) ?? modelId
  const modelsById = new Map(rekeyed.map((m) => [m.id, m]))
  const label = (modelId: string): string => displayNameOf(modelsById.get(remap(modelId))) ?? registryLabel(modelId)

  const newIds = new Set(rekeyed.map((m) => m.id))
  const mappedDefault = input.defaultModelId ? oldToNew.get(input.defaultModelId) : undefined
  const defaultUsable = mappedDefault !== undefined && newIds.has(mappedDefault)
  const defaultModelId = defaultUsable ? mappedDefault! : rekeyed[0]!.id
  if (input.defaultModelId && !defaultUsable) {
    warn(`default model "${label(input.defaultModelId)}" is not usable; the harness will use "${label(defaultModelId)}"`)
  }

  // The personality rides along verbatim - host-resolved, readable, absolute.
  // It comes from the harness's own session choice; model entries are not
  // consulted (their personality/systemMessageReplacementsFile fields belong
  // to the Copilot interface and never flow to dsh through this file).
  const personalityFile = input.personalityFile?.trim() ? input.personalityFile.trim() : undefined
  // The recording target rides the snapshot as a bare, validated path. A
  // non-absolute string is an upstream bug, and guessing a location for raw
  // prompts is not the plugin's job - recordings fail closed (chat is
  // untouched) and the user hears about it through the warning.
  let captureFile: string | undefined
  if (typeof input.captureFile === 'string' && input.captureFile.trim()) {
    const candidate = input.captureFile.trim()
    if (path.isAbsolute(candidate)) captureFile = candidate
    else warn(`harness recording target "${candidate}" is not an absolute path; prompt recording stays off`)
  }
  const snapshot: SnapshotPayload = {
    config: { servers, models: rekeyed },
    defaultModelId,
    aux: {},
    warnings,
  }
  const title = usableAux('session-title', input.title, newIds, warn, remap, registryLabel)
  const compaction = usableAux('compaction', input.compaction, newIds, warn, remap, registryLabel)
  // Keys are dsh's purpose strings verbatim ('session-title', not 'title'):
  // the adapter looks them up by `options.purpose`, and a mismatch there means
  // every session title silently runs on the big model.
  if (title) snapshot.aux['session-title'] = title
  if (compaction) snapshot.aux['compaction'] = compaction
  if (typeof input.fixEmptyToolParameters === 'boolean') snapshot.fixEmptyToolParameters = input.fixEmptyToolParameters
  if (personalityFile) snapshot.personalityFile = personalityFile
  if (captureFile) snapshot.captureFile = captureFile
  return snapshot
}

/**
 * Stable text for change detection: rewrite the file only when the content the
 * harness will actually read has changed. `warnings` is excluded because it
 * describes how the build went, not what the plugin loads. Keys are sorted
 * recursively: the registry stores open records, and two objects that differ
 * only in key ORDER are the same content, so an order-sensitive fingerprint
 * would rewrite the snapshot (and reload the harness's view of it) on pure
 * serialization noise.
 */
export function snapshotFingerprint(document: unknown): string {
  const { warnings: _warnings, ...rest } = document as { warnings?: unknown }
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(value).sort()) out[key] = canonical((value as Record<string, unknown>)[key])
      return out
    }
    return value
  }
  return JSON.stringify(canonical(rest))
}
