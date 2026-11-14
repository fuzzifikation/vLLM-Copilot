import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const SNAPSHOT_VERSION = 1

/** Snapshot location: explicit VLLMC_SNAPSHOT file, else <DSH_HOME|~/.dsh>/vllmc/snapshot.json. */
export function snapshotPathFrom(env = process.env) {
  if (env.VLLMC_SNAPSHOT) return env.VLLMC_SNAPSHOT
  const home = env.DSH_HOME && env.DSH_HOME.trim() ? env.DSH_HOME : path.join(homedir(), '.dsh')
  return path.join(home, 'vllmc', 'snapshot.json')
}

/**
 * Parse and validate a snapshot. Unknown versions and missing fields fail loudly:
 * a silently wrong snapshot means silently wrong requests, and the harness has no
 * way to notice it drove a different model config than the user configured.
 */
export function parseSnapshot(text, sourceLabel = 'snapshot') {
  let data
  try {
    data = JSON.parse(text)
  } catch (err) {
    throw new Error(`${sourceLabel}: not valid JSON (${err.message})`)
  }
  if (data.version !== SNAPSHOT_VERSION) {
    throw new Error(`${sourceLabel}: unsupported version ${JSON.stringify(data.version)} (plugin understands version ${SNAPSHOT_VERSION})`)
  }
  const config = data.config
  if (!config || !Array.isArray(config.models) || config.models.length === 0) {
    throw new Error(`${sourceLabel}: config.models must be a non-empty array`)
  }
  if (!Array.isArray(config.servers)) {
    throw new Error(`${sourceLabel}: config.servers must be an array`)
  }
  const ids = new Set(config.models.map((m) => m.id))
  if (!ids.has(data.defaultModelId)) {
    throw new Error(`${sourceLabel}: defaultModelId ${JSON.stringify(data.defaultModelId)} is not among the configured models`)
  }
  for (const model of config.models) {
    if (!model.id) throw new Error(`${sourceLabel}: a model entry is missing its id`)
    if (!config.servers.some((s) => s.id === model.server)) {
      throw new Error(`${sourceLabel}: model ${model.id} references unknown server ${JSON.stringify(model.server)}`)
    }
  }
  for (const purpose of ['session-title', 'compaction']) {
    const auxId = data.aux?.[purpose]?.modelId
    if (auxId && !ids.has(auxId)) {
      throw new Error(`${sourceLabel}: aux.${purpose}.modelId ${JSON.stringify(auxId)} is not among the configured models`)
    }
  }
  return data
}

export function loadSnapshot(file = snapshotPathFrom()) {
  if (!existsSync(file)) throw new Error(`snapshot file not found: ${file}`)
  return parseSnapshot(readFileSync(file, 'utf8'), file)
}
