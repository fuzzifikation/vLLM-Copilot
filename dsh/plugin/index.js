/**
 * vLLM-Copilot adapter plugin for the DeepSeek Harness (dsh).
 *
 * Cordis bundle plugin: registers the `vllmc` LlmAdapter inside the dsh
 * process. Reads the registry snapshot written by the bridge extension, loads
 * the staged vLLM-Copilot core (installed as this package's dependency), and
 * routes every generation through the real core request path. Completed
 * request records land in the usage outbox for the bridge to ingest into the
 * main extension's canonical ledger.
 *
 * Certified contract facts (dsh 0.2.0-rc.2): `inject = ['llm']` is required
 * for ctx.llm; registerAdapter returns a disposer; chunk order
 * block-start -> deltas -> block-end -> usage -> finish renders; usage counts
 * are cache-disjoint; the loop deep-freezes its GenerateOptions, hence the
 * fully detached projection in project.js.
 */
import path from 'node:path'
import { loadSnapshot, snapshotPathFrom } from './snapshot.js'
import { createVllmcAdapter } from './adapter.js'
import { flagFileFrom, createRecorder } from './capture.js'

export const inject = ['llm']

export function apply(ctx) {
  const file = snapshotPathFrom()
  let snapshot
  try {
    snapshot = loadSnapshot(file)
  } catch (err) {
    ctx.logger.error(
      `vllmc bridge: refusing to register (${err.message}). ` +
        'Install the vLLM-Copilot extension and launch dsh through the bridge, or remove this bundle.',
    )
    return
  }
  const adapterDeps = {
    outboxDir: path.join(path.dirname(file), 'usage-outbox'),
    activeDir: path.join(path.dirname(file), 'active'),
    log: { appendLine: (line) => ctx.logger.info(`[vllmc] ${line}`) },
    // The durable image bytes live in the harness attachment service, the same
    // service dsh's own routes pull from via ctx.get('attachments'). Absent
    // service is not fatal: image occurrences project to honest placeholder
    // text, never fabricated descriptions.
    resolveAttachments: () => {
      try {
        return typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
      } catch {
        return undefined
      }
    },
  }
  return import('vllm-copilot-core')
    .then((core) => {
      // Recording: the consent marker lives beside the snapshot, the target
      // is the workspace file the snapshot names (capture.js for the rules -
      // no destination in the snapshot means no recording, ever).
      adapterDeps.capture = createRecorder({ core, flagFile: flagFileFrom(file), snapshotFile: file, log: adapterDeps.log })
      const adapter = createVllmcAdapter({ core, snapshot, deps: adapterDeps })
      const registration = ctx.llm.registerAdapter(['vllmc'], adapter)
      ctx.effect(() => () => registration())
      ctx.logger.info(
        `vllmc adapter registered: ${snapshot.config.models.length} model(s), default '${snapshot.defaultModelId}' (snapshot v${snapshot.version})`,
      )
    })
    .catch((err) => {
      // Without this the rejection escapes the plugin host as an anonymous
      // crash. The dominant cause is a stale file: link from a bridge update
      // that has not restaged, and the user deserves to be told exactly that.
      ctx.logger.error(
        `vllmc bridge: the staged vLLM-Copilot core failed to load (${err?.message ?? err}). ` +
          'Start the harness from the editor to restage the vendor trees, or remove this bundle.',
      )
    })
}
