/**
 * The history of harness URLs we have served, and the loopback rules that
 * make it safe to act on.
 *
 * Why this file exists: the harness binds a fresh ephemeral port with a fresh
 * token on every boot, so a harness browser tab restored after a restart can
 * never connect. In VS Code 1.140 that browser tab is a native child view,
 * and a restored fail-load one paints over the workbench DOM, which is to say
 * it hides every menu in the window (owner-reproduced 2026-10-11; upstream
 * sibling microsoft/vscode#317715). The bridge cannot prevent the restore,
 * but it can recognise its own zombie: the tab's label is the host:port, and
 * this history says which host:ports were ever ours.
 *
 * Node built-ins only, so the vitest tree and the extension host read the
 * same code.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

/** Relative to the `vllmc` directory inside the harness home. */
export const SERVED_URLS_FILE = 'served-urls.log'

/** A few days of restarts stay recognised; the file never grows past this. */
const MAX_ENTRIES = 10

export function servedUrlsFile(vllmcDir: string): string {
  return path.join(vllmcDir, SERVED_URLS_FILE)
}

/**
 * The loopback host:port of a harness URL, or undefined for anything else.
 * The sweep closes tabs matched on this value, so non-loopback input is a bug
 * to reject here, not a tab to ever touch.
 */
export function loopbackHostPort(url: string): string | undefined {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:') return undefined
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return undefined
    return u.host
  } catch {
    return undefined
  }
}

function readLines(file: string): string[] {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Record a served URL, replacing any earlier entry for the same host:port
 * (a dead port is dead). Only the origin is stored, never the announced URL
 * itself: readers re-derive host:port and nothing else, so the UI token this
 * bridge passes around must never land in this file. A rewrite of ten short
 * lines per boot is free; the history being advisory means a failed write
 * warns and never fails a start.
 */
export function appendServedUrl(file: string, url: string, log?: { warn(message: string): void }): void {
  const hostPort = loopbackHostPort(url)
  if (!hostPort) {
    if (url) log?.warn('refused to record a non-loopback harness URL in the served-url history')
    return
  }
  const kept = readLines(file).filter((line) => loopbackHostPort(line) !== hostPort)
  kept.push(new URL(url).origin)
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, kept.slice(-MAX_ENTRIES).join('\n') + '\n')
  } catch (err) {
    log?.warn(`served-url history not written: ${(err as Error).message}`)
  }
}

/** Distinct loopback host:ports this bridge has served, oldest first. */
export function readServedHostPorts(file: string): string[] {
  return [...new Set(readLines(file).map(loopbackHostPort).filter((host): host is string => Boolean(host)))]
}

/**
 * Whether someone is home on this origin. Any HTTP answer counts, including
 * redirects and errors: the sweep closes tabs only when NOTHING answers.
 * Someone else's fresh server on a recycled port keeps its tab.
 */
export async function originAnswers(hostPort: string, timeoutMs = 2000): Promise<boolean> {
  try {
    await fetch(`http://${hostPort}/`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' })
    return true
  } catch {
    return false
  }
}
