/**
 * Generates model-configs/index.json — the remote preset list served live to
 * the extension during Add Server / Auto-Configure
 * (docs/remote-presets-plan.md §3).
 *
 * GENERATED, NEVER HAND-EDITED. Freshness chain:
 *   1. GitHub Action (.github/workflows/preset-index.yml) regenerates + commits
 *      this file on any push touching model-configs/**.
 *   2. The Vitest drift test (test/modelConfigPresets.test.ts) fails a stale
 *      index, so `npm run build` cannot ship one.
 *
 * Usage:  node scripts/gen-preset-index.mjs   (or: npm run gen:presets)
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'model-configs');
const INDEX_FILE = 'index.json';
const SCHEMA_VERSION = 1;

/**
 * Mirror of PRESET_CONFIG_KEYS in src/commands/presets.ts (this script is
 * dependency-free Node and cannot import the TypeScript module). A Vitest
 * sync test (test/gen-preset-index.test.ts) fails if the two ever diverge.
 * Without this check the GitHub Action could publish an index advertising a
 * preset the runtime guard will reject — the lookup fails gracefully, but the
 * index should never advertise garbage in the first place.
 */
export const PRESET_CONFIG_KEYS = new Set([
  'vllmModelId',
  'displayName',
  'family',
  'maxInputTokens',
  'maxOutputTokens',
  'capabilities',
  'modelModes',
  'defaultMode',
  'defaultParams',
  'estimateCharsPerToken',
]);

/** Strip full-line // comments (preset files carry authoring prose above the envelope). */
function stripComments(text) {
  return text
    .split('\n')
    .filter(line => !line.trim().startsWith('//'))
    .join('\n');
}

/** Build the index object from the preset files in `dir`. Throws on invalid input. */
export function buildIndex(dir = DIR) {
  const presets = readdirSync(dir)
    .filter(f => f.endsWith('.json') && f !== INDEX_FILE)
    .sort()
    .map(f => {
      let env;
      try {
        env = JSON.parse(stripComments(readFileSync(join(dir, f), 'utf8')));
      } catch (err) {
        throw new Error(`${f}: not parseable preset JSON (${err.message})`);
      }
      if (env.presetVersion !== 1) {
        throw new Error(`${f}: must be a v2 preset envelope (presetVersion 1)`);
      }
      // Mirror the runtime guard (parsePresetEnvelope) — the Action runs this
      // WITHOUT the strict suite, so the generator itself must refuse presets
      // the extension would reject at download time.
      if (!Array.isArray(env.match) || env.match.length === 0) {
        throw new Error(`${f}: v2 envelope needs a non-empty match[]`);
      }
      if (!env.match.every(m => typeof m === 'string' && m.trim().length > 0)) {
        throw new Error(`${f}: match[] entries must be non-empty strings`);
      }
      const config = env.config;
      if (!config || typeof config !== 'object' || Array.isArray(config)) {
        throw new Error(`${f}: v2 envelope needs a config object`);
      }
      for (const k of Object.keys(config)) {
        if (!PRESET_CONFIG_KEYS.has(k)) {
          throw new Error(`${f}: unknown config key "${k}" (runtime guard would reject the file)`);
        }
      }
      // { match, file } — key order is deliberate: patterns first, file second (§3).
      return { match: env.match, file: f };
    });
  return {
    schemaVersion: SCHEMA_VERSION,
    updated: new Date().toISOString().slice(0, 10),
    presets,
  };
}

function main() {
  const index = buildIndex();
  const out = join(DIR, INDEX_FILE);
  writeFileSync(out, JSON.stringify(index, null, 2) + '\n', 'utf8');
  console.log(`gen-preset-index: wrote ${index.presets.length} presets to ${INDEX_FILE} (updated ${index.updated})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
