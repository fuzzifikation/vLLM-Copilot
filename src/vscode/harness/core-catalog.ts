/**
 * Loading the staged core's catalog surface (`resolveServedModels`, plus
 * `buildDisplayKeys` when present) behind one never-throwing, invalidatable
 * source.
 *
 * The extension and the node rails build the SAME source over the SAME file
 * (the profile-installed core at `profiles/vllmc/node_modules/vllm-copilot-core`,
 * where pnpm resolved the core's bare dependencies; the raw vendor staging has
 * no node_modules and dies on import). That is the point: a loader the rails
 * do not share is a loader the ship gate never exercises, and the served-catalog
 * path would again be proven only by fakes that echo their own assumptions.
 *
 * Duck-typed on purpose: staged cores older than 1.37.1 export neither name,
 * and a too-old core must degrade to "offer every model unfiltered", the same
 * posture as a probe that cannot reach the server. A load failure is a warning,
 * never a throw: prepare must survive a broken stage.
 *
 * `invalidate()` exists because the extension restages the core in place when
 * vLLM-Copilot updates, while Node's module cache would otherwise serve the
 * previous build's exports to the same window forever. The bump query is part
 * of the module cache key and nothing else: Node's file loader strips it
 * before touching disk.
 */
import { pathToFileURL } from 'node:url'
import type { ServedVerdict, SnapshotModel, SnapshotServer } from './snapshot.js'

/**
 * The staged core's catalog surface, duck-typed against the dynamic import.
 * Both members key by registry model id; callers flatten Maps to plain
 * records because `buildSnapshot` input stays JSON-ish for the pure tests.
 */
export interface CoreCatalog {
  resolveServedModels(
    models: readonly SnapshotModel[],
    servers: readonly SnapshotServer[],
  ): Promise<ReadonlyMap<string, ServedVerdict>>
  buildDisplayKeys?(models: readonly SnapshotModel[]): ReadonlyMap<string, string>
}

export interface CoreCatalogLog {
  warn(message: string): void
}

export interface CoreCatalogSource {
  /** The catalog, or undefined when no usable core exports one. Never throws. */
  load(): Promise<CoreCatalog | undefined>
  /** Forget the cached module so the next `load()` reads the restaged tree. */
  invalidate(): void
}

/**
 * @param entryFile resolves the core's `core/index.js` per call, because the
 * profile tree may not exist yet at construction time (first prepare creates it).
 */
export function createCoreCatalogSource(opts: { entryFile: () => string; log: CoreCatalogLog }): CoreCatalogSource {
  let cached: CoreCatalog | null | undefined
  let generation = 0
  return {
    async load(): Promise<CoreCatalog | undefined> {
      if (cached !== undefined) return cached ?? undefined
      const file = opts.entryFile()
      try {
        const core = (await import(`${pathToFileURL(file).href}?bridgegen=${generation}`)) as Partial<CoreCatalog>
        if (typeof core.resolveServedModels !== 'function') {
          opts.log.warn('the staged vLLM-Copilot core exports no served-model resolver; offering models unfiltered')
          cached = null
        } else {
          cached = {
            resolveServedModels: core.resolveServedModels,
            ...(typeof core.buildDisplayKeys === 'function' ? { buildDisplayKeys: core.buildDisplayKeys } : {}),
          }
        }
      } catch (err) {
        // A failed import is not evidence about future imports: the tree may
        // be mid-restage right now, and caching the failure would serve
        // "no resolver" (every model unfiltered) until the next stamp bump.
        // Leave the cache empty so the next prepare retries.
        opts.log.warn(`could not load the staged core for the served-model resolver: ${(err as Error).message}`)
        return undefined
      }
      return cached ?? undefined
    },
    invalidate(): void {
      cached = undefined
      generation++
    },
  }
}
