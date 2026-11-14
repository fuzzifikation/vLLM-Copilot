/**
 * The bridge controller: everything that must be true before the harness can
 * serve a turn, in the order it must be true.
 *
 * Order matters and is not arbitrary. Staging must precede `dsh plugin add`
 * (the profile installs the staged directory), the profile must precede
 * `--dump-config` (the dump is the composed tree of that profile), and the dump
 * must precede the overlay (every emitted row id is verified against it). The
 * snapshot is written last-but-one so a failed prepare never leaves the harness
 * pointing at half-updated config, and the stale-pid reap happens immediately
 * before spawn so exactly one instance can hold the port.
 *
 * No `vscode` import: the editor glue lives in `harness.ts`.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { ensureDshRuntime, type DshRuntime } from './runtime.js'
import { ensureAdapterInstalled, ensureProfile, requireDsh } from './dsh-cli.js'
import { buildSnapshot, type AuxChoice, type ServedVerdict, type SnapshotModel, type SnapshotServer } from './snapshot.js'
import { writeSnapshot } from './snapshot-writer.js'
import type { CoreCatalogSource } from './core-catalog.js'
import { loadOverlay, loadPluginSnapshotModule, loadStaging, type OverlayModule } from './shared-modules.js'
import { classifyPidRecord, probeHarness, sweepDetachedHarnesses, Supervisor, type PidRecord } from './supervisor.js'
import { acquireStartLock } from './start-lock.js'
import { ingestOutbox, type IngestOutcome } from './ingest.js'
import { registerDefaultWorkspace } from './workspace.js'
import type { LedgerPort } from './api.js'
import type { BridgePaths } from './paths.js'
import { ensureBridgeDirs, legacyHomeDirs } from './paths.js'
import { appendServedUrl, servedUrlsFile } from './served-urls.js'

export interface BridgeLog {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

export interface RegistryView {
  servers: SnapshotServer[]
  models: SnapshotModel[]
  /** Mirrored from `vllm-copilot.fixEmptyToolParameters`. */
  fixEmptyToolParameters?: boolean
  /**
   * Absolute, readable personality file per model id (resolved from each
   * model's `systemMessageReplacementsFile`). Without this the snapshot
   * carries no `personalityFile` and configured personalities silently never
   * reach the harness.
   */
  personalityFiles?: Readonly<Record<string, string>>
}

export interface BridgeChoices {
  defaultModelId?: string
  title?: AuxChoice
  compaction?: AuxChoice
  drainTimeoutMs: number
}

export interface BridgeDeps {
  /** Extension install root: holds `dsh/shared/` and `dsh/plugin/`. */
  extensionRoot: string
  extensionVersion: string
  paths: BridgePaths
  log: BridgeLog
  /**
   * Exact dsh version to install and launch, or a reader of it. The editor
   * passes a reader so the `dshVersion` setting takes effect on the next
   * restart instead of being frozen at activation.
   */
  dshVersion: string | (() => string)
  registry: () => RegistryView
  choices: () => BridgeChoices
  /** undefined while the main extension cannot accept records; keeps the outbox. */
  ledgerPort: () => LedgerPort | undefined
  /** The installed vLLM-Copilot extension, or undefined when absent. */
  mainExtension: () => { path: string; version: string } | undefined
  /**
   * The editor's primary folder, when there is one. Registered as the
   * harness's default workspace immediately before our own spawn, so dsh
   * sessions open where the user is working instead of dsh's own corner.
   */
  editorWorkspaceFolder?: () => string | undefined
  /**
   * The plugin manager rewrote a profile file while the harness runs.
   * The toggle persisted, but this dsh build cannot hot-apply it; the
   * extension turns this into a "restart to apply" notice.
   */
  onProfileEdit?: (file: string) => void
  /**
   * Editor control channel (loopback URL + bearer token), resolved when the
   * overlay is built and burned into the generated `dsh-mcp-client` row, so
   * the upstream plugin dials exactly this window's listener. Undefined means
   * the overlay emits no editor-tool row and the harness boots without them.
   */
  controlEndpoint?: () => { url: string; token: string } | undefined
  /**
   * Live narration of the slow prepare phases (first-start npm installs, the
   * profile plugin add, the harness boot). A cold start runs for minutes, and
   * a spinner that says nothing reads like a hang: the editor renders this
   * into a progress notification so the user watches real steps, not a guess.
   * Increments weight by measured duration, so the bar tracks elapsed time on
   * a cold start and races ahead on a warm one, which is the honest picture.
   */
  progress?(message: string, increment?: number): void
  /**
   * The staged core's catalog resolver (`resolveServedModels`, plus
   * `buildDisplayKeys` when present) as a shared, invalidatable source, loaded
   * lazily per prepare and reset whenever staging restages the core, so a
   * same-window extension update cannot keep serving the previous build's
   * verdicts. Absent (or a core too old to export it), every server's models
   * are offered unfiltered and re-keyed by the writer's own fallback: the same
   * posture as a probe that cannot reach the server.
   */
  coreCatalog?: CoreCatalogSource
  onUnexpectedExit?(info: { code: number | null; signal: string | null }): void
}

export interface PreparedBridge {
  dshVersion: string
  coreVersion: string
  snapshotVersion: number
  rowsDisabled: number
  warnings: string[]
}

/**
 * Whether the staged trees on disk are the ones this bridge build will boot.
 * The single truth behind both the stage() skip and "may this window adopt the
 * running harness": a harness built by a different build serves a different
 * plugin, and reusing it quietly is how the stale-terminal-tool incident
 * happened even after the files on disk were current.
 */
export function compositionIsCurrent(
  stamp: { extensionVersion?: string; pluginFingerprint?: string } | undefined,
  current: { extensionVersion: string; pluginFingerprint: string; vendorCoreExists: boolean },
): boolean {
  return (
    stamp?.extensionVersion === current.extensionVersion &&
    stamp?.pluginFingerprint === current.pluginFingerprint &&
    current.vendorCoreExists
  )
}

export class Bridge {
  readonly supervisor: Supervisor
  private prepared: PreparedBridge | undefined
  private legacyHomesRetired = false

  constructor(private readonly deps: BridgeDeps) {
    this.supervisor = new Supervisor({
      binPath: '',
      dshHome: deps.paths.root,
      profile: 'vllmc',
      pidFile: deps.paths.pid,
      activeDir: deps.paths.active,
      dshVersion: deps.dshVersion,
      log: deps.log,
      onUnexpectedExit: (info) => deps.onUnexpectedExit?.(info),
      profileDir: deps.paths.profile,
      onProfileEdit: (file) => this.deps.onProfileEdit?.(file),
    })
  }

  get preparedInfo(): PreparedBridge | undefined {
    return this.prepared
  }

  /** Installed dsh launcher, installing the package on first use. Awaited: a cold install must not block the event loop. */
  private async runtime(): Promise<DshRuntime> {
    const version = typeof this.deps.dshVersion === 'function' ? this.deps.dshVersion() : this.deps.dshVersion
    return ensureDshRuntime({ runtimeDir: this.deps.paths.runtime, version, log: this.deps.log })
  }

  /**
   * Copy the compiled core out of the installed extension and stage the adapter
   * beside it, so the profile's `file:../vllm-copilot-core` resolves. Skipped
   * when the stamp already matches the installed extension version, which is
   * what keeps an editor restart from re-copying 2 MB of JavaScript.
   */
  private async stage(): Promise<{ coreVersion: string; recompileNeeded: boolean }> {
    const { paths, deps } = { paths: this.deps.paths, deps: this.deps }
    const staging = await loadStaging(this.deps.extensionRoot)
    const main = this.deps.mainExtension()
    if (!main) throw new Error('vLLM-Copilot is not installed, so there is no core to stage')
    const manifest = JSON.parse(readFileSync(path.join(main.path, 'package.json'), 'utf8')) as { version?: string }
    const stamp = staging.readCoreStamp(paths.coreVersion)
    const fingerprint = this.pluginFingerprint()
    if (
      compositionIsCurrent(stamp, {
        extensionVersion: main.version,
        pluginFingerprint: fingerprint,
        vendorCoreExists: existsSync(path.join(paths.vendor.core, 'core', 'index.js')),
      })
    ) {
      return { coreVersion: String(stamp?.coreVersion ?? main.version), recompileNeeded: false }
    }
    this.deps.log.info(`staging vLLM-Copilot core ${main.version} for the harness`)
    staging.stageCore({
      coreDir: path.join(main.path, 'out', 'core'),
      sourceManifest: manifest,
      targetDir: paths.vendor.core,
      docsDir: main.path,
      description: `vLLM-Copilot editor-free core (compiled out/core of vLLM-Copilot ${main.version}, staged by the bridge).`,
    })
    staging.stageAdapter({ pluginDir: path.join(this.deps.extensionRoot, 'dsh', 'plugin'), targetDir: paths.vendor.adapter })
    staging.writeCoreStamp(paths.coreVersion, {
      coreVersion: manifest.version ?? 'unknown',
      extensionVersion: main.version,
      bridgeVersion: this.deps.extensionVersion,
      pluginFingerprint: fingerprint,
      stagedAt: new Date().toISOString(),
    })
    // The profile pinned the previous adapter build; force a reinstall.
    rmSync(deps.paths.adapterStamp, { force: true })
    return { coreVersion: String(manifest.version ?? 'unknown'), recompileNeeded: true }
  }

  /**
   * Content fingerprint of the bundled plugin, recursively. A plugin-only
   * bridge update must restage even when the staged core stamp still matches,
   * or existing installs keep running the old plugin out of vendor/ forever.
   * Content, not mtime: an mtime that survives a reinstall (or a checkout
   * that restores one) would silently skip the restage, and mtime arithmetic
   * is not a change detector, it is a rumor.
   */
  private pluginFingerprint(): string {
    const dir = path.join(this.deps.extensionRoot, 'dsh', 'plugin')
    const hash = createHash('sha256')
    const walk = (current: string, rel: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          walk(full, `${rel}${entry.name}/`)
          continue
        }
        if (!entry.isFile()) continue
        hash.update(`${rel}${entry.name}\u0000`).update(createHash('sha256').update(readFileSync(full)).digest('hex')).update('\n')
      }
    }
    walk(dir, '')
    return hash.digest('hex')
  }

  /**
   * Ask the staged core for served verdicts and display keys. The resolver
   * never throws for probe failures — that is what `unknown` exists for — so
   * anything landing in the catch is a broken stage or a misbehaving core,
   * and the answer is the certified no-verdict posture: offer everything,
   * re-key locally. Same posture a probe failure always had.
   */
  private async resolveCatalog(
    registry: RegistryView,
  ): Promise<{ served?: Record<string, ServedVerdict>; displayKeys?: Record<string, string> }> {
    const catalog = await this.deps.coreCatalog?.load()
    if (!catalog) return {}
    try {
      const served: Record<string, ServedVerdict> = {}
      for (const [id, verdict] of await catalog.resolveServedModels(registry.models, registry.servers)) {
        served[id] = verdict
      }
      if (!catalog.buildDisplayKeys) return { served }
      const displayKeys: Record<string, string> = {}
      for (const [id, key] of catalog.buildDisplayKeys(registry.models)) displayKeys[id] = key
      return { served, displayKeys }
    } catch (err) {
      this.deps.log.warn(
        `the staged core could not resolve the served models (${(err as Error).message}); offering every model unfiltered`,
      )
      return {}
    }
  }

  /**
   * Bring everything up to date: runtime, vendor staging, profile, adapter
   * install, snapshot, overlay. Safe to call repeatedly; each step no-ops when
   * already current.
   */
  async prepare(): Promise<PreparedBridge> {
    await this.retireLegacyHomes()
    ensureBridgeDirs(this.deps.paths)
    this.deps.progress?.('installing the harness runtime (first start only, about 1-2 minutes)')
    const runtime = await this.runtime()
    this.deps.progress?.('staging the vLLM-Copilot core for the harness', 45)
    const { coreVersion, recompileNeeded } = await this.stage()
    // The trees under the profile changed, so any module the catalog source
    // cached from the previous build is stale. Node caches dynamic imports by
    // URL, which is exactly why the source takes an invalidate() instead of
    // trusting the extension host to restart.
    if (recompileNeeded) this.deps.coreCatalog?.invalidate()

    this.deps.progress?.('creating the dsh profile (first start only, about a minute)', 2)
    await ensureProfile({ binPath: runtime.binPath, dshHome: this.deps.paths.root, profile: 'vllmc', manifestFile: path.join(this.deps.paths.profile, 'package.json') })
    this.deps.progress?.('installing the model adapter into the dsh profile', 18)
    await ensureAdapterInstalled({
      binPath: runtime.binPath,
      dshHome: this.deps.paths.root,
      profile: 'vllmc',
      adapterDir: this.deps.paths.vendor.adapter,
      coreDir: this.deps.paths.vendor.core,
      profileModules: this.deps.paths.profileModules,
      stampFile: this.deps.paths.adapterStamp,
    })

    this.deps.progress?.('asking your servers which models they serve', 15)
    const registry = this.deps.registry()
    const { served, displayKeys } = await this.resolveCatalog(registry)
    const payload = buildSnapshot({
      ...registry,
      ...this.deps.choices(),
      ...(served ? { served } : {}),
      ...(displayKeys ? { displayKeys } : {}),
      onWarning: (message) => this.deps.log.warn(message),
    })
    const plugin = await loadPluginSnapshotModule(this.deps.paths.vendor.adapter)
    const written = writeSnapshot({ snapshotFile: this.deps.paths.snapshot, payload, plugin })
    if (written.written) this.deps.log.info(`snapshot rewritten (v${written.version}, ${payload.config.models.length} model(s))`)

    this.deps.progress?.('composing the harness configuration', 3)
    const overlay = await this.buildOverlay(runtime)
    this.deps.progress?.('configuration ready', 4)
    this.prepared = {
      dshVersion: runtime.version,
      coreVersion,
      snapshotVersion: written.version,
      rowsDisabled: overlay.disabled,
      warnings: payload.warnings,
    }
    return this.prepared
  }

  /**
   * Compose the overlay from the profile's own composed tree. dsh's semver is
   * decorative, so the dump is the only honest input: rows that vanished or
   * renamed must stop the boot rather than compose a profile that keeps
   * phoning home.
   *
   * The rows are merged into the profile's own patch layer between markers.
   * They are never passed as --patch at boot: an include created with a
   * patches config is not recorded as the root Include entry, and every live
   * profile reload (every plugin toggle) then fails with "profile reload
   * requires the root Include entry" (docs/upstream-issues.md). The patch
   * layer is also where the plugin manager writes, so the merge preserves
   * every row the user's toggles created outside the generated block.
   */
  private async buildOverlay(runtime: DshRuntime): Promise<OverlayModule & { disabled: number }> {
    const overlay = await loadOverlay(this.deps.extensionRoot)
    const dump = (await requireDsh({
      binPath: runtime.binPath,
      dshHome: this.deps.paths.root,
      args: ['--profile', 'vllmc', '--dump-config'],
      timeoutMs: 300_000,
    })).stdout
    const snapshot = this.readSnapshotDefault()
    const mcpEndpoint = this.deps.controlEndpoint?.()
    const result = overlay.buildOverlay(dump, { provider: 'vllmc', model: snapshot.defaultModelId, ...(mcpEndpoint ? { mcpEndpoint } : {}) })
    const patchFile = path.join(this.deps.paths.profile, 'cordis.patch.yml')
    const existing = existsSync(patchFile) ? readFileSync(patchFile, 'utf8') : ''
    const merged = overlay.mergePatchLayer(existing, result.yml)
    if (merged !== existing) {
      // Owner-only on POSIX: the generated layer embeds the control bearer token.
      writeFileSync(`${patchFile}.tmp`, merged, { mode: 0o600 })
      renameSync(`${patchFile}.tmp`, patchFile)
      // Our own regeneration is not a change to restart for; the watcher
      // must recognize the bytes.
      this.supervisor.recordOwnProfileWrite(patchFile, merged)
    }
    // The pre-patch-layer artifact: stale text with a stale token, and the one
    // file someone could still hand to --patch to undo this fix by accident.
    rmSync(this.deps.paths.overlay, { force: true })
    // The label, not the id: our generated config ids embed hostnames, and logs
    // print wire ids and display names only.
    this.deps.log.info(
      `patch layer regenerated: ${result.disabled} rows disabled, default model "${snapshot.wireLabel}", ` +
        (mcpEndpoint ? `editor tools mounted on ${result.presetMounts.length} preset(s)` : 'editor tools not mounted (no control channel)'),
    )
    // A module namespace object is frozen, so the row count travels beside it
    // rather than being stamped onto it.
    return { ...overlay, disabled: result.disabled }
  }

  /**
   * Read the default model back from the snapshot we just wrote instead of
   * re-deriving it, so the overlay's `agent-default-model` row and the
   * snapshot's `defaultModelId` can never disagree.
   */
  private readSnapshotDefault(): { defaultModelId: string; wireLabel: string } {
    const parsed = JSON.parse(readFileSync(this.deps.paths.snapshot, 'utf8')) as {
      defaultModelId?: string
      config?: { models?: Array<{ id?: string; vllmModelId?: string; displayName?: string }> }
    }
    const defaultModelId = parsed.defaultModelId
    if (typeof defaultModelId !== 'string' || !defaultModelId) {
      throw new Error('snapshot has no defaultModelId; refusing to compose a harness with no default model')
    }
    const model = parsed.config?.models?.find((m) => m.id === defaultModelId)
    const wireLabel = model?.vllmModelId || model?.displayName || 'configured default'
    return { defaultModelId, wireLabel }
  }

  /**
   * Boot the harness, or reuse the one another window already boots.
   *
   * Adoption needs more than a live pid: the running harness must have been
   * built by THIS composition, or the window silently serves the previous
   * bridge's plugin (the stale-`vscode_terminal` incident). A live harness
   * that predates the current build is drained and replaced, which is also
   * what makes "update the extension, reload the window" land on a fresh
   * composition instead of a borrowed stale one.
   *
   * The start lock serializes the rest across restored windows: one window
   * prepares and spawns while the others wait and adopt, so two windows can
   * never run concurrent npm installs into one runtime tree or spawn twice
   * and shoot each other's harness through the sweep.
   */
  async start(): Promise<string> {
    const url = await this.acquire()
    // Remember every URL this harness answers on. Port and token die with
    // every boot, so the NEXT boot's restored browser tab points here, cannot
    // connect, and a fail-load browser view in VS Code 1.140 hides the
    // window's menus. The history is how the next window's stale-tab sweep
    // recognises its own zombies (served-urls.ts).
    appendServedUrl(servedUrlsFile(this.deps.paths.vllmc), url, this.deps.log)
    return url
  }

  private async acquire(): Promise<string> {
    const first = await this.adoptCandidate()
    if (first) {
      const url = await this.adopt(first)
      if (url) return url
    }
    // Captured before prepare() restages the trees under the running harness.
    const predating = await this.liveRecord()
    const held = await acquireStartLock({
      lockFile: this.deps.paths.startLock,
      pidFile: this.deps.paths.pid,
      log: this.deps.log,
      // The waiting path obeys the same adoption law as the direct path:
      // never borrow a harness whose composition predates this build.
      isAdoptable: async () => !(await this.needsRestage()),
    })
    if (held.kind === 'adopt') {
      const url = await this.adopt(held.record)
      if (url) return url
    } else if (held.kind === 'busy') {
      throw new Error(
        'another editor window is still preparing the harness and did not finish within the wait budget; start again after it reports',
      )
    }
    try {
      // While this window queued for the lock, its holder may have produced a
      // harness worth adopting after all.
      const second = await this.adoptCandidate()
      if (second) {
        const url = await this.adopt(second)
        if (url) return url
      }
      // A borrow this window made earlier may name a harness that stopped
      // answering (wedged): liveRecord refuses it, so nothing below drains it,
      // and the stale adoption would both block setBinPath and pretend the
      // home is busy. Forget it; the pre-spawn sweep reaps the corpse.
      if (this.supervisor.adopted) this.supervisor.dropAdoption()
      let prepared: PreparedBridge
      try {
        prepared = await this.prepare()
      } catch (err) {
        if (!predating || !(await probeHarness(predating.url))) throw err
        // Windows denies deleting files a live process is reading: a restage
        // under a running harness can fail on the runtime tree itself. Drain
        // the predating harness (its replacement was already decided when the
        // composition check refused to adopt it) and retry once.
        this.deps.log.info('prepare could not restage under the running harness; draining it and retrying')
        this.deps.progress?.('the previous harness is being drained so the update can restage (in-flight turns get their grace)')
        this.supervisor.adopt(predating)
        const drainedNow = await this.supervisor.stop({ drainMs: this.deps.choices().drainTimeoutMs })
        if (!drainedNow.drained) this.deps.log.warn(`${drainedNow.remaining} in-flight request(s) were cut restaging under the harness`)
        prepared = await this.prepare()
      }
      if (predating && (await probeHarness(predating.url))) {
        this.deps.log.info('restarting the running harness: its composition predates this bridge build')
        this.deps.progress?.('replacing the harness from before this build (in-flight turns get their grace)')
        this.supervisor.adopt(predating)
        const result = await this.supervisor.stop({ drainMs: this.deps.choices().drainTimeoutMs })
        if (!result.drained) this.deps.log.warn(`${result.remaining} in-flight request(s) were cut replacing the outdated harness`)
      }
      const runtime = await this.runtime()
      // The supervisor is constructed once, so point it at the launcher we have.
      this.supervisor.setBinPath(runtime.binPath)
      if (prepared.warnings.length) prepared.warnings.forEach((w) => this.deps.log.warn(w))
      // Only on the spawn path: a harness another window booted already knows
      // its workspace, and rewriting the registry under a running process would
      // race its in-memory copy.
      const folder = this.deps.editorWorkspaceFolder?.()
      if (folder) registerDefaultWorkspace(this.deps.paths.root, folder, this.deps.log)
      this.deps.progress?.('starting the harness and waiting for its address', 3)
      return await this.supervisor.start()
    } finally {
      if (held.kind === 'acquired') held.lock.release()
    }
  }

  /** A harness this window may take over as-is: alive, answering, and current. */
  private async adoptCandidate(): Promise<PidRecord | undefined> {
    const record = await this.liveRecord()
    if (!record) return undefined
    return (await this.needsRestage()) ? undefined : record
  }

  private async liveRecord(): Promise<PidRecord | undefined> {
    const state = classifyPidRecord(this.deps.paths.pid, this.deps.log)
    if (state.kind === 'live' && (await probeHarness(state.record.url))) return state.record
    return undefined
  }

  /** Borrow a recorded harness; undefined when the record carried no usable URL. */
  private async adopt(record: PidRecord): Promise<string | undefined> {
    this.supervisor.adopt(record)
    if (this.supervisor.url) return this.supervisor.url
    this.supervisor.dropAdoption()
    return undefined
  }

  /**
   * Cheap check (two file reads and a hash, no dsh invocation) of whether the
   * staged trees match this build, which is exactly what decides whether the
   * running harness may be reused.
   */
  private async needsRestage(): Promise<boolean> {
    const main = this.deps.mainExtension()
    if (!main) return false
    const staging = await loadStaging(this.deps.extensionRoot)
    return !compositionIsCurrent(staging.readCoreStamp(this.deps.paths.coreVersion), {
      extensionVersion: main.version,
      pluginFingerprint: this.pluginFingerprint(),
      vendorCoreExists: existsSync(path.join(this.deps.paths.vendor.core, 'core', 'index.js')),
    })
  }

  /**
   * Bridges up to 0.0.3 keyed the harness home to the extension version, so an
   * updated install can find old homes whose harnesses nothing will ever sweep
   * again (every later sweep matches on the new home path). Reap their process
   * trees once; the directories stay for the user to delete.
   */
  private async retireLegacyHomes(): Promise<void> {
    if (this.legacyHomesRetired) return
    this.legacyHomesRetired = true
    for (const dir of legacyHomeDirs(path.dirname(this.deps.paths.root), this.deps.paths.root)) {
      this.deps.log.info(`retiring the harness home left by an older bridge: ${path.basename(dir)}`)
      await sweepDetachedHarnesses(dir)
    }
  }

  /**
   * Stop, draining in-flight harness requests first. `drained: false` means
   * live requests were cut, and the caller must say so.
   */
  async stop(opts: { force?: boolean } = {}): Promise<{ drained: boolean; remaining: number }> {
    const drainMs = opts.force ? 0 : this.deps.choices().drainTimeoutMs
    const result = await this.supervisor.stop({ drainMs })
    if (!result.drained) this.deps.log.warn(`${result.remaining} harness request(s) still in flight after the drain budget; they were cut`)
    return result
  }

  async restart(opts: { force?: boolean } = {}): Promise<{ url: string; drained: boolean; remaining: number }> {
    const stop = await this.stop(opts)
    const url = await this.start()
    // The caller must be able to say out loud that the restart cut live
    // requests; swallowing the drain verdict here is how turns vanish silently.
    return { url, drained: stop.drained, remaining: stop.remaining }
  }

  /** Fold completed harness requests into the main extension's ledger. */
  async ingest(): Promise<IngestOutcome> {
    return ingestOutbox({
      outboxDir: this.deps.paths.outbox,
      quarantineDir: this.deps.paths.quarantine,
      port: this.deps.ledgerPort(),
      log: this.deps.log,
    })
  }

  /** In-flight count for the status bar. */
  activeRequests(): number {
    try {
      return readdirSync(this.deps.paths.active).filter((n) => n.endsWith('.json')).length
    } catch {
      return 0
    }
  }
}
