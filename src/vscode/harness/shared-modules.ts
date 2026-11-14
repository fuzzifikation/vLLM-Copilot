/**
 * Loaders for the plain-ESM modules in `dsh/shared/`.
 *
 * The extension imports them by absolute path at runtime instead of by static
 * specifier. Two reasons, both about surviving on a stranger's machine: a
 * static cross-directory import would have to survive `tsc`'s output layout
 * (the compiled file lands in `out/` and the relative path would then point
 * outside the package), and there is no bundler here to rewrite it, because
 * esbuild's postinstall is blocked by this project's npm install-script policy.
 * Absolute paths off the extension root are unambiguous in both dev and the
 * packed VSIX.
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'

export interface OverlayModule {
  buildOverlay(dumpText: string, input: { provider?: string; model: string; mcpEndpoint?: { url: string; token: string } }): {
    yml: string
    disabled: number
    skipped: string[]
    presetMounts: string[]
    provider: string
    model: string
  }
  stripMcpChildLines(cfgLines: string[]): string[]
  mergePatchLayer(existing: string, overlayYml: string): string
  PATCH_LAYER_START: string
  PATCH_LAYER_END: string
  PRIVACY_ROWS: readonly string[]
  DEPENDENT_ROWS: readonly string[]
}

export interface StagingModule {
  stageCore(input: {
    coreDir: string
    sourceManifest: Record<string, unknown> & { version?: string; dependencies?: Record<string, string> }
    targetDir: string
    docsDir?: string
    coreVersion?: string
    description?: string
  }): { name: string; version: string; dependencies?: Record<string, string> }
  stageAdapter(input: { pluginDir: string; targetDir: string }): { name: string; version: string }
  readCoreStamp(file: string): { coreVersion?: string; extensionVersion?: string; pluginFingerprint?: string; stagedAt?: string } | undefined
  writeCoreStamp(file: string, stamp: Record<string, unknown>): Record<string, unknown>
}

export interface PluginSnapshotModule {
  SNAPSHOT_VERSION: number
  parseSnapshot(text: string, label?: string): unknown
}

async function loadShared<T>(extensionRoot: string, file: string): Promise<T> {
  const target = pathToFileURL(path.join(extensionRoot, 'dsh', 'shared', file)).href
  try {
    return (await import(target)) as T
  } catch (err) {
    throw new Error(
      `the bridge cannot load its own ${file} from ${path.join(extensionRoot, 'dsh', 'shared')}. ` +
        `That folder is missing from the installed extension, so the package is incomplete: ${(err as Error).message}`,
    )
  }
}

export const loadOverlay = (extensionRoot: string): Promise<OverlayModule> => loadShared<OverlayModule>(extensionRoot, 'overlay.mjs')
export const loadStaging = (extensionRoot: string): Promise<StagingModule> => loadShared<StagingModule>(extensionRoot, 'core-staging.mjs')

/**
 * The staged plugin is the authority on the snapshot contract, so the writer
 * validates its own output through the loader the harness will actually run.
 */
export async function loadPluginSnapshotModule(pluginStageDir: string): Promise<PluginSnapshotModule> {
  const target = pathToFileURL(path.join(pluginStageDir, 'snapshot.js')).href
  const mod = (await import(target)) as Partial<PluginSnapshotModule>
  if (typeof mod.SNAPSHOT_VERSION !== 'number' || typeof mod.parseSnapshot !== 'function') {
    throw new Error(`staged adapter at ${pluginStageDir} does not export SNAPSHOT_VERSION/parseSnapshot`)
  }
  return mod as PluginSnapshotModule
}
