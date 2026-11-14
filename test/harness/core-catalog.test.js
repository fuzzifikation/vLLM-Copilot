/**
 * Tripwires for the staged-core catalog loader, the seam where the 0.0.12
 * class of bug would return: a core that cannot be loaded or exports nothing
 * must degrade to "offer every model", never kill prepare, and a restaged core
 * must actually reach this window instead of a cached module of the old one.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createCoreCatalogSource } from '../../src/vscode/harness/core-catalog.js'

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'vllmc-catalog-'))
}

describe('staged-core catalog loader', () => {
  it('catches prepare death from a broken stage: missing file or missing export degrades to undefined, never a throw', async () => {
    const dir = tmpDir()
    try {
      const file = join(dir, 'index.js')
      const warns = []
      const source = createCoreCatalogSource({ entryFile: () => file, log: { warn: (m) => warns.push(m) } })
      expect(await source.load()).toBeUndefined() // file does not exist yet: import fails, warning only
      expect(warns.length).toBe(1)
      writeFileSync(file, 'export const unrelated = 1\n')
      source.invalidate()
      expect(await source.load()).toBeUndefined() // core too old to export the resolver: filtering stays off
      expect(warns.length).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('catches serving stale verdicts after a restage: invalidate reloads the module from disk', async () => {
    const dir = tmpDir()
    try {
      const file = join(dir, 'index.js')
      writeFileSync(file, 'export function resolveServedModels() { return new Map() }\nexport function buildDisplayKeys() { return new Map([["m", "Model"]]) }\n')
      const source = createCoreCatalogSource({ entryFile: () => file, log: { warn() {} } })
      const first = await source.load()
      expect(typeof first?.resolveServedModels).toBe('function')
      expect(first?.buildDisplayKeys?.([{ id: 'm' }])).toEqual(new Map([['m', 'Model']]))
      // The restaged build: different exports entirely. Without cache busting
      // this window keeps calling the FIRST module until reload.
      writeFileSync(file, 'export function resolveServedModels() { return new Map([["m", { state: "absent", reason: "retired" }]]) }\n')
      source.invalidate()
      const second = await source.load()
      const verdicts = await second?.resolveServedModels([], [])
      expect(verdicts?.get('m')).toEqual({ state: 'absent', reason: 'retired' })
      expect(second?.buildDisplayKeys).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
