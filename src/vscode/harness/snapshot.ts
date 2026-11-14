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

export interface SnapshotServer {
  id: string
  serverUrl: string
  serverType?: string
  displayName?: string
  requestHeaders?: Record<string, string>
  [key: string]: unknown
}

export interface SnapshotModel {
  id: string
  server: string
  /** Carried verbatim from the registry entry (see RegistryModel): the
   *  adapter gates vision on `capabilities.imageInput`, so a build step that
   *  cherry-picked fields would silently blind every vision model. */
  capabilities?: { toolCalling?: boolean; imageInput?: boolean }
  [key: string]: unknown
}

export interface AuxChoice {
  modelId?: string
  maxTokens?: number
}

/**
 * The core's served-model verdict (`resolveServedModels` in the staged core,
 * shipped since vLLM-Copilot 1.37.1). The core answers; the reaction here is
 * the bridge's own posture: only a demonstrated `absent` prunes. `unknown`
 * ("could not ask", including an empty answer) keeps the model offered — a
 * network hiccup must never empty the harness catalog, and "could not ask"
 * is never "serves nothing" (the 0.0.12 accident the core now enforces).
 */
export interface ServedVerdict {
  readonly state: 'served' | 'absent' | 'unknown'
  readonly reason?: string
}

export interface SnapshotInput {
  servers: readonly SnapshotServer[]
  models: readonly SnapshotModel[]
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
   * verdict (no core, or a core too old to answer): everything is offered —
   * the same posture as a probe that cannot reach the server.
   */
  served?: Readonly<Record<string, ServedVerdict | undefined>>
  /**
   * Display-safe keys from the core's `buildDisplayKeys`, keyed by registry
   * model id. When present they ARE the re-key base, so harness identity is
   * the core's one rule; the writer's own name fallback below is the same
   * rule, kept for cores too old to export the helper. The collision suffix
   * stays as a guard no matter where base names come from.
   */
  displayKeys?: Readonly<Record<string, string | undefined>>
  /** Absolute path per model id, already resolved to a readable file. */
  personalityFiles?: Readonly<Record<string, string>>
  /** Reasons surfaced to the user rather than dropped silently. */
  onWarning?(message: string): void
}

export interface SnapshotPayload {
  config: { servers: SnapshotServer[]; models: SnapshotModel[] }
  defaultModelId: string
  aux: Record<string, AuxChoice>
  fixEmptyToolParameters?: boolean
  personalityFile?: string
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

  const servers = input.servers.filter((s) => typeof s?.id === 'string' && typeof s?.serverUrl === 'string')
  const serverIds = new Set(servers.map((s) => s.id))
  const models = input.models.filter((m) => {
    if (typeof m?.id !== 'string') return false
    if (!serverIds.has(m.server)) {
      warn(`model "${m.displayName ?? m.id}" points at server "${String(m.server)}", which no longer exists; it is not offered to the harness`)
      return false
    }
    return true
  })
  if (models.length === 0) {
    throw new Error(
      'the vLLM-Copilot registry has no model whose server still exists, so there is nothing to offer the harness. ' +
        'Add a server and a model in vLLM-Copilot settings.',
    )
  }

  // The wire id is what a server's model list reports; the config id is ours.
  const wireOf = (m: SnapshotModel): string => (typeof m.vllmModelId === 'string' && m.vllmModelId ? m.vllmModelId : m.id)
  // Registry entries are open records, so `displayName` needs a runtime check
  // before it may pretend to be a label.
  const displayNameOf = (m: SnapshotModel | undefined): string | undefined =>
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
  // ours: re-key to the user-chosen display name, uniquified. Requests still
  // carry `vllmModelId`; this is display hygiene and hostname scrubbing at
  // once. Old sessions that stored a previous id re-pick once, same as any
  // model removal.
  const takenKeys = new Set<string>()
  const oldToNew = new Map<string, string>()
  const newToOld = new Map<string, string>()
  const rekeyed: SnapshotModel[] = offered.map((m) => {
    const named = input.displayKeys?.[m.id] || displayNameOf(m) || wireOf(m)
    let key = named
    for (let n = 2; takenKeys.has(key); n++) key = `${named} (${n})`
    takenKeys.add(key)
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

  const personalityFiles = input.personalityFiles ?? {}
  const registryIdOf = (key: string): string => newToOld.get(key) ?? key
  const wanted = rekeyed.map((m) => ({ model: m, file: personalityFiles[registryIdOf(m.id)] })).filter((x) => x.file !== undefined)
  // `personalityFiles` arrives keyed by REGISTRY id; the default is a display
  // key, so the lookup crosses back through the re-key map.
  const personalityFile = personalityFiles[registryIdOf(defaultModelId)]
  if (wanted.length > 1) {
    // The harness applies one personality per session. Which sentence is
    // true depends on whether the DEFAULT carries a file: with one, it wins;
    // without one, no personality applies at all, and saying "the default
    // wins" would be a fairy tale.
    warn(
      personalityFile
        ? `several models carry their own personality file; the harness applies one personality per session, so "${label(defaultModelId)}" wins. Other models run without their personality file.`
        : `several models carry their own personality file, but the default model carries none; the harness applies one personality per session, so no personality takes effect. Move the personality file onto the default model.`,
    )
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
