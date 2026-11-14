/**
 * Tripwires for the license a staged core ships, because the staged manifest
 * orders every reader to look at it (`SEE LICENSE IN LICENSE`).
 *
 * The two callers hand `stageCore` two different trees. The rails stage from a
 * checkout, whose source license is `LICENSE`. The extension stages from its own
 * install directory, where vsce has renamed the shipped license to
 * `LICENSE.txt` (read out of a packaged VSIX, 2026-11-14). A copy that looked
 * only for `LICENSE` staged a package declaring a license file that was not
 * there, in production only, the one place no rail had ever looked.
 */
import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { stageCore } from '../../dsh/shared/core-staging.mjs'

const repo = path.resolve(import.meta.dirname, '..', '..')
const SOURCE_MANIFEST = { name: 'vllm-copilot', version: '1.40.0', dependencies: {} }

/** Stand-in for a compiled `out/core`: staging needs index.js and its imports. */
function fakeCore(root) {
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, 'index.js'), 'export const core = 1\n')
  return root
}

/** Stage `docsDir` as the docs of a core compiled under `work`. */
function stage(work, docsDir) {
  const targetDir = path.join(work, 'vendor', 'vllm-copilot-core')
  const manifest = stageCore({
    coreDir: fakeCore(path.join(work, 'out', 'core')),
    sourceManifest: { ...SOURCE_MANIFEST },
    targetDir,
    docsDir,
  })
  return { targetDir, manifest }
}

describe('stageCore license staging', () => {
  it('stages a checkout LICENSE under the name the manifest declares', () => {
    const work = mkdtempSync(path.join(tmpdir(), 'dsh-stage-checkout-'))
    try {
      // The real repository root, because that is what `npm run harness:stage`
      // passes: the rails carry the source license, never the MIT text that only
      // a packaged extension holds.
      const { targetDir, manifest } = stage(work, repo)
      expect(readFileSync(path.join(targetDir, 'LICENSE'), 'utf8')).toBe(
        readFileSync(path.join(repo, 'licenses', 'LICENSE-BUSL-1.1.txt'), 'utf8'),
      )
      expect(readFileSync(path.join(targetDir, 'THIRD-PARTY-NOTICES.txt'), 'utf8')).toBe(
        readFileSync(path.join(repo, 'THIRD-PARTY-NOTICES.txt'), 'utf8'),
      )
      expect(manifest.license).toBe('SEE LICENSE IN LICENSE')
      // The pointer the manifest prints has to resolve inside the staged tree.
      expect(manifest.files).toContain('LICENSE')
      expect(existsSync(path.join(targetDir, 'LICENSE'))).toBe(true)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('stages an installed extension LICENSE.txt as LICENSE', () => {
    const work = mkdtempSync(path.join(tmpdir(), 'dsh-stage-installed-'))
    try {
      const extensionRoot = path.join(work, 'extension')
      mkdirSync(extensionRoot, { recursive: true })
      const mit = readFileSync(path.join(repo, 'licenses', 'LICENSE-MIT.txt'), 'utf8')
      writeFileSync(path.join(extensionRoot, 'LICENSE.txt'), mit)
      writeFileSync(path.join(extensionRoot, 'THIRD-PARTY-NOTICES.txt'), 'notices\n')
      const { targetDir } = stage(work, extensionRoot)
      // Verbatim text, canonical name: the packaged extension is MIT and a
      // checkout is BUSL, so a stage must not borrow the other tree's license.
      expect(readFileSync(path.join(targetDir, 'LICENSE'), 'utf8')).toBe(mit)
      expect(existsSync(path.join(targetDir, 'LICENSE.txt'))).toBe(false)
      expect(readFileSync(path.join(targetDir, 'THIRD-PARTY-NOTICES.txt'), 'utf8')).toBe('notices\n')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('stages without notices and refuses a tree with no license', () => {
    const work = mkdtempSync(path.join(tmpdir(), 'dsh-stage-licenseless-'))
    try {
      const bare = path.join(work, 'bare')
      mkdirSync(bare, { recursive: true })
      writeFileSync(path.join(bare, 'LICENSE'), 'source license\n')
      const first = stage(work, bare)
      // Notices stay best-effort; only the license is load-bearing here.
      expect(readFileSync(path.join(first.targetDir, 'LICENSE'), 'utf8')).toBe('source license\n')
      expect(existsSync(path.join(first.targetDir, 'THIRD-PARTY-NOTICES.txt'))).toBe(false)

      const empty = path.join(work, 'no-license')
      mkdirSync(empty, { recursive: true })
      expect(() => stage(work, empty)).toThrow(/no license file in/)
      // The check runs while the previous stage still stands, so a tree this
      // helper cannot read costs the user nothing it did not already have.
      expect(readFileSync(path.join(first.targetDir, 'LICENSE'), 'utf8')).toBe('source license\n')
      expect(existsSync(path.join(first.targetDir, 'core', 'index.js'))).toBe(true)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
