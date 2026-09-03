import { parsePresetFile, type ModelPreset } from './presets.js';

/**
 * Live remote preset lookup (docs/remote-presets-plan.md).
 *
 * When a model is added, the flow fetches a tiny index file from the
 * vLLM-Copilot GitHub repo, matches the identified model against its patterns
 * in memory, and downloads AT MOST ONE preset file — the match winner. The
 * file must be a valid v2 envelope and passes the exact same guard as bundled
 * presets ({@link parsePresetFile}): non-v2 files, unknown `presetVersion`
 * and unknown `config` keys reject the whole file, so a remote preset can
 * never carry identity, headers or server fields.
 *
 * Zero state, zero caching, never throws: every failure path (offline,
 * timeout, bad JSON, guard reject, oversized payload) resolves `undefined` and
 * the caller silently continues with bundled presets. A hard 2 s timeout
 * bounds the lookup — the Add flow is modal and uncancellable, so there is no
 * cancellation token to plumb (the timeout is the entire bound).
 */

const BASE = 'https://raw.githubusercontent.com/fuzzifikation/vLLM-Copilot/main/model-configs';
/** Hard bound for both fetches — Add Server must never feel this. */
const TIMEOUT_MS = 2000;
/** 64 KB per response: presets are ~2 KB; anything bigger is not a preset. */
const MAX_BYTES = 64 * 1024;
/** List format versions this client understands (newer → skip lookup). */
const LIST_SCHEMA_VERSION = 1;

interface ListEntry {
  match: string[];
  file: string;
}

interface PresetIndex {
  schemaVersion?: number;
  presets?: ListEntry[];
}

/**
 * GET a URL, enforce the size cap, return the decoded text.
 * Returns undefined on ANY failure (network, HTTP status, oversize, decode).
 */
async function getBoundedText(url: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) {
      return undefined;
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BYTES) {
      return undefined;
    }
    return new TextDecoder().decode(buf);
  } catch {
    return undefined; // offline / timeout / abort — indistinguishable, all mean "skip"
  }
}

/**
 * Same case-insensitive substring rule as {@link findPresetForModel}, applied
 * to list entries. `file` must be a bare `*.json` name — any path separator is
 * rejected so a hostile list cannot redirect the fetch (path traversal).
 * Longest matching pattern wins; ties keep list order (remote is a single
 * source, so order is the generator's deterministic sort).
 */
function longestListMatch(
  list: ListEntry[],
  modelId: string,
  root?: string,
): ListEntry | undefined {
  if (!Array.isArray(list)) {
    return undefined; // hostile/corrupt index shape ({}, "str", …) — iterating it would THROW
  }
  const hays = [modelId.toLowerCase(), root?.toLowerCase()].filter((x): x is string => x !== undefined);
  let best: ListEntry | undefined;
  let bestLen = -1;
  for (const e of list) {
    if (typeof e?.file !== 'string' || !/^[^/\\]+\.json$/.test(e.file)) {
      continue; // bare filename or nothing
    }
    for (const m of Array.isArray(e.match) ? e.match : []) {
      // Array.isArray: a bare string would iterate ONE CHARACTER at a time —
      // a 1-char pattern matches nearly every model. Non-arrays match nothing.
      const mL = String(m).toLowerCase();
      if (mL && hays.some(h => h.includes(mL)) && mL.length > bestLen) {
        best = e;
        bestLen = mL.length;
      }
    }
  }
  return best;
}

/**
 * Live lookup: index file → (winner only) preset file → v2 guard.
 * Returns the remote preset or `undefined`. Every failure path returns
 * `undefined` (and logs one output-channel line where the reason matters);
 * this function never throws into the Add flow.
 *
 */
export async function fetchRemotePreset(
  modelId: string,
  root: string | undefined,
  log: (msg: string) => void,
): Promise<ModelPreset | undefined> {
  // No cancellation parameter on purpose: the Add flow is dialog-driven
  // (cancellable: false), so no token exists to honour. If a cancellable
  // flow ever appears, compose its signal in here.
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  const listText = await getBoundedText(`${BASE}/index.json`, signal);
  if (listText === undefined) {
    return undefined; // offline / timeout / GitHub hiccup — stay silent, bundled applies
  }
  let list: PresetIndex | undefined;
  try {
    list = JSON.parse(listText) as PresetIndex;
  } catch {
    list = undefined; // malformed list text — treated like the shape guard below
  }
  if (!list || typeof list !== 'object' || (list.schemaVersion ?? 1) > LIST_SCHEMA_VERSION) {
    return undefined; // unparseable or future list format → skip, never half-interpret
  }

  // Array.isArray, NOT `?? []`: `{}` and "evil" are truthy non-arrays whose
  // for..of iteration would throw straight out of the never-throws lookup.
  const hit = longestListMatch(Array.isArray(list.presets) ? list.presets : [], modelId, root);
  if (!hit) {
    return undefined; // miss — the whole non-match cost was one ~1 KB GET
  }

  const text = await getBoundedText(`${BASE}/${hit.file}`, signal);
  if (text === undefined) {
    log(`[WARN] Remote preset ${hit.file}: fetch failed or oversized`);
    return undefined;
  }
  // Same strict guard as bundled files, and the ONLY accepted format: the v2
  // envelope. parsePresetFile rejects non-v2 files, unknown presetVersion,
  // empty match and any config key outside PRESET_CONFIG_KEYS (whole-file
  // reject) — no separate version probe needed.
  const preset = parsePresetFile(text, `remote:${hit.file}`);
  if (!preset) {
    log(`[WARN] Remote preset ${hit.file} rejected: failed preset schema guard`);
    return undefined;
  }
  return preset;
}
