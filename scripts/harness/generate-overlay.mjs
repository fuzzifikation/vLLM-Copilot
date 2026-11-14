#!/usr/bin/env node
/**
 * Overlay generator CLI. Thin wrapper over `dsh/shared/overlay.mjs` (the single
 * source of truth shared with the extension): read a `--dump-config` capture,
 * emit the privacy-disable + default-model overlay, fail loudly on drift.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { buildOverlay } from '../../dsh/shared/overlay.mjs'

function parseArgs(argv) {
  const args = { provider: 'vllmc', model: 'canned-demo' }
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (value === undefined) throw new Error(`missing value for ${key}`)
    if (key === '--dump') args.dump = value
    else if (key === '--out') args.out = value
    else if (key === '--provider') args.provider = value
    else if (key === '--model') args.model = value
    else throw new Error(`unknown argument ${key}`)
  }
  if (!args.dump || !args.out) {
    throw new Error('usage: generate-overlay.mjs --dump <dump-config.yml> --out <overlay.yml> [--provider vllmc] [--model <id>]')
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const { yml, disabled, skipped, provider, model } = buildOverlay(readFileSync(args.dump, 'utf8'), {
  provider: args.provider,
  model: args.model,
})
writeFileSync(args.out, yml)
console.log(`overlay written to ${args.out}: ${disabled} rows disabled (privacy + their dependents), default model -> ${provider}/${model}`)
if (skipped.length) console.log(`skipped rows absent from this composition: ${skipped.join(', ')}`)
