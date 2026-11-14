/**
 * Disk arithmetic for the uninstall report. Pure node: the walk is exactly
 * what it sounds like, and its only consumer is a human sentence - so an
 * entry that cannot be read counts as nothing and never throws. A directory
 * that is missing has a size of zero, which is also the honest answer.
 */
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

export function directorySize(dir: string): number {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const current = stack.pop() as string
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      try {
        if (entry.isDirectory()) stack.push(full)
        else if (entry.isFile()) total += statSync(full).size
      } catch {
        // unreadable entries are nobody's bytes
      }
    }
  }
  return total
}

/** One-decimal human sizing for the uninstall sentence. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return unit === 0 ? `${bytes} B` : `${value.toFixed(1)} ${units[unit]}`
}

/**
 * Whether `dir` may be recursively deleted, given `boundary` is the directory
 * this bridge owns. Recursive deletion follows a junction or symlink planted
 * AT its target, and unprivileged users can plant junctions, so the honest
 * question is not what the path string says but where it really lands: the
 * resolved directory must be inside the resolved boundary, never the boundary
 * itself. Case folding is a Windows-only courtesy: NTFS answers a wrong-case
 * path with the same directory, so containment must ignore case there. On a
 * case-sensitive filesystem `Dsh-home` is a different directory, and folding
 * there would wave a case-variant sibling through the gate; realpath already
 * hands us the truth, so compare it byte-exact.
 */
export function deletableWithin(dir: string, boundary: string): boolean {
  try {
    const foldCase = process.platform === 'win32'
    const norm = (p: string): string => {
      const trimmed = p.replace(/[\\/]+$/, '')
      return foldCase ? trimmed.toLowerCase() : trimmed
    }
    const real = norm(realpathSync(dir))
    const root = norm(realpathSync(boundary))
    if (real === root || !real.startsWith(root + path.sep)) return false
    return lstatSync(real).isDirectory()
  } catch {
    return false
  }
}
