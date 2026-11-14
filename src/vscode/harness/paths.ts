/**
 * Paths of the bridge's on-disk layout. Everything the bridge creates lives
 * under one root so the harness and the extension can never drift onto
 * different trees, and an uninstall has exactly one directory to delete.
 *
 * The root is STABLE across bridge versions. Version-keyed homes meant every
 * update re-downloaded the dsh runtime, rebuilt the profile, redropped the
 * Preview Notice, lost the sessions, and orphaned the previous home's harness
 * forever (the sweep matches on DSH_HOME, and a new version never looks at
 * the old path again). What an update must not do - hand a restaged plugin
 * tree to a running harness - is handled where it belongs: the start path
 * compares the running composition's stamp with the current build and
 * replaces a harness that predates the upgrade.
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'

/** Layout inside `$DSH_HOME`; dsh owns the rest of the tree (profiles, sessions). */
export const VLLMC_DIR = 'vllmc'
export const PROFILE_NAME = 'vllmc'
/** The stable harness home directory name inside the extension's storage. */
export const HOME_DIR = 'dsh-home'

/** Relative to the `vllmc` directory. */
export const SNAPSHOT_FILE = 'snapshot.json'
/** Legacy: superseded by the profile patch layer; removed again on every prepare. */
export const OVERLAY_FILE = 'overlay.yml'
export const PID_FILE = 'dsh.pid'
export const OUTBOX_DIR = 'usage-outbox'
export const ACTIVE_DIR = 'active'
export const CORE_VERSION_FILE = 'core-version.json'
export const START_LOCK_FILE = 'start.lock'
/** Live capture-consent marker (`on`/`off`) the dsh process re-reads at every capture. */
export const CAPTURE_FLAG_FILE = 'capture.flag'

/** Relative to the `dsh-home` root: where the profile's pnpm install puts the adapter. */
export const PROFILE_DIR_PREFIX = 'profiles'

export interface BridgePaths {
  root: string
  vllmc: string
  snapshot: string
  overlay: string
  pid: string
  outbox: string
  quarantine: string
  active: string
  coreVersion: string
  profile: string
  profileModules: string
  /** Cross-window startup lock, held while a window prepares and spawns. */
  startLock: string
  /** Installed `@deepseek-ai/dsh` lives here (never in the editor's own tree). */
  runtime: string
  /** Records that `dsh plugin add` ran against the currently staged adapter. */
  adapterStamp: string
  /** Live capture-consent marker beside the snapshot; the dsh process re-reads it per capture. */
  captureFlag: string
  vendor: { core: string; adapter: string }
}

/**
 * @param dataDir this extension's globalStorage directory.
 */
export function bridgePaths(dataDir: string): BridgePaths {
  const root = path.join(dataDir, HOME_DIR)
  const vllmc = path.join(root, VLLMC_DIR)
  const profile = path.join(root, PROFILE_DIR_PREFIX, PROFILE_NAME)
  const vendor = vendorPaths(root)
  return {
    root,
    vllmc,
    snapshot: path.join(vllmc, SNAPSHOT_FILE),
    overlay: path.join(vllmc, OVERLAY_FILE),
    pid: path.join(vllmc, PID_FILE),
    outbox: path.join(vllmc, OUTBOX_DIR),
    quarantine: path.join(vllmc, 'quarantine'),
    active: path.join(vllmc, ACTIVE_DIR),
    coreVersion: path.join(vllmc, CORE_VERSION_FILE),
    profile,
    profileModules: path.join(profile, 'node_modules'),
    startLock: path.join(vllmc, START_LOCK_FILE),
    runtime: path.join(root, 'runtime'),
    adapterStamp: path.join(vllmc, 'adapter-installed.txt'),
    captureFlag: path.join(vllmc, CAPTURE_FLAG_FILE),
    vendor,
  }
}

/** Create the directories the bridge writes into. Idempotent. */
export function ensureBridgeDirs(paths: BridgePaths): void {
  for (const dir of [paths.root, paths.vllmc, paths.outbox, paths.active, paths.vendor.core]) {
    mkdirSync(dir, { recursive: true })
  }
}

/** Where the staged vendor pair goes: the core, plus the adapter beside it. */
export function vendorPaths(root: string): { core: string; adapter: string } {
  return { core: path.join(root, 'vendor', 'vllm-copilot-core'), adapter: path.join(root, 'vendor', 'dsh-adapter-vllmc') }
}
