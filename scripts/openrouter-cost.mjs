#!/usr/bin/env node
/**
 * Quick catalog-level preview of the Model Selector's cost ranking.
 *
 * The differentiator over OpenRouter's own model list: models are NOT ranked
 * by their sticker input/output price but by what our actual token mix costs
 * on each model. The quality axis (--benchmarks) comes from OpenRouter's
 * unified benchmarks endpoint (Artificial Analysis coding / agentic /
 * intelligence indices, joined on the catalog slug).
 *
 * Scope, honestly stated (the shipped selector lives in
 * src/ui/modelSelectorView.ts + resources/modelSelector.js): this script
 * reads ONLY the catalog - one price per model, no per-provider endpoint
 * fan-out, no long-context tier or time-of-day overrides (the catalog's
 * `pricing.overrides` is ignored, so a time-priced model's base rate here
 * can be its off-peak value - the shipped surfaces show the peak instead).
 * Rankings can therefore differ
 * from the webview for models whose cheapest provider reprices at long
 * context. Where both compute a cost they use the same formula:
 *
 * Calibrated from real usage (agentic Copilot sessions, 2026-09):
 *
 *   prompt      4,113,894,637
 *   cached      3,852,036,800   -> 93.63% of prompt served from cache
 *   new input     261,857,837   -> prompt - cached (with cache activity the
 *                                  new share IS the cache delta: billed at
 *                                  the published cache-write rate IN PLACE
 *                                  of input - the input buckets are disjoint,
 *                                  Sonnet 4.6 write 3.75 replaces input 3.00,
 *                                  never 6.75; no write rate -> plain input)
 *   output         33,962,390   -> 0.83% of prompt
 *
 * Effective rate per 1M prompt tokens (same formula as the selector, minus
 * its per-config policy adjustment - this script prices the default policy):
 *
 *   p_eff = 0.063652 * p_new + 0.936348 * p_cache_read + 0.008256 * p_out
 *   p_new = p_write when published, else p_in
 *
 * Models that report no cache-read price (no caching support) pay FULL input
 * for the cached share too: they cannot serve our workload's 93.6% cache hits,
 * so charging them the input rate is the honest comparison.
 *
 * Usage:
 *   node scripts/openrouter-cost.mjs [--all] [--grep <substring>]
 *   node scripts/openrouter-cost.mjs --benchmarks [--quality <axis>] [--weights c,a,i]
 *
 * Options:
 *   --all               print every priced model (default: top 60)
 *   --grep <substring>  only models whose id contains the substring
 *   --benchmarks        join the quality axis from GET /api/v1/benchmarks
 *                       (Artificial Analysis indices; needs OPENROUTER_API_KEY
 *                       env var - any valid OpenRouter key works, 500 req/day)
 *   --quality <axis>    coding | agentic | intelligence | blend (default coding)
 *   --weights <c,a,i>   weights for blend / partial-index renormalization
 *
 * In --benchmarks mode the table is sorted by quality descending and the Pareto
 * front (no model both cheaper AND better) is marked with '*'.
 */

const CATALOG_URL = 'https://openrouter.ai/api/v1/models';
const BENCHMARKS_URL = 'https://openrouter.ai/api/v1/benchmarks?source=artificial-analysis';

// ── Usage profile (single source of truth: the raw counts above) ──────────
const USAGE = {
  prompt: 4_113_894_637,
  cached: 3_852_036_800,
  output: 33_962_390,
};

const R_CACHED = USAGE.cached / USAGE.prompt; // share of prompt from cache
const R_NEW = 1 - R_CACHED; // share billed at full input price
const R_OUT = USAGE.output / USAGE.prompt; // output tokens per prompt token

/**
 * OpenRouter pricing strings are per-token USD; `-1` means unknown/dynamic.
 * Convert to per-1M USD. Mirrors `perMillion()` in src/backends/openRouter.ts
 * (kept as a local copy: scripts/ must not import compiled extension code).
 */
function perMillion(rate) {
  if (typeof rate !== 'string' || rate.trim() === '') return undefined;
  const n = Number(rate);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 1e12) / 1e6;
}

/** Effective per-1M-prompt-token cost under our usage profile (selector
 *  formula). The input buckets are DISJOINT: tokens written to the cache are
 *  billed at the write rate INSTEAD OF the input rate (Anthropic semantics,
 *  Sonnet 4.6: write 3.75 = 1.25x input 3.00 - not 6.75). Our usage has a
 *  real cache-read share, so the new share IS the cache delta: billed at the
 *  write rate where one is published, plain input otherwise. */
function effectiveRate({ input, output, cacheRead, write }) {
  const pCache = cacheRead ?? input; // no caching = cached share at full price
  const newRate = write || input;
  return R_NEW * newRate + R_CACHED * pCache + R_OUT * output;
}

async function fetchCatalog() {
  const res = await fetch(CATALOG_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`catalog fetch failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body.data)) throw new Error('catalog response has no data array');
  return body.data;
}

/**
 * Fetch the Artificial Analysis indices. Auth: any valid OpenRouter API key.
 * Returns permaslug -> {coding, agentic, intelligence} (permaslug is the plain
 * catalog slug, variants like ':free' are stripped by the caller before lookup)
 * plus the required attribution citation.
 */
async function fetchBenchmarks(apiKey) {
  const res = await fetch(BENCHMARKS_URL, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 401) throw new Error('benchmarks: OpenRouter rejected the API key (401)');
  if (res.status === 429) throw new Error('benchmarks: rate limited (30/min, 500/day per account) - try later');
  if (!res.ok) throw new Error(`benchmarks fetch failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body.data)) throw new Error('benchmarks response has no data array');
  const scores = new Map();
  for (const item of body.data) {
    if (item.source !== 'artificial-analysis' || typeof item.model_permaslug !== 'string') continue;
    scores.set(item.model_permaslug, {
      coding: typeof item.coding_index === 'number' ? item.coding_index : undefined,
      agentic: typeof item.agentic_index === 'number' ? item.agentic_index : undefined,
      intelligence: typeof item.intelligence_index === 'number' ? item.intelligence_index : undefined,
    });
  }
  return { scores, citation: body.meta?.citation ?? null, asOf: body.meta?.as_of ?? null };
}

/**
 * Blend the available indices with the given weights, renormalizing over the
 * components that exist (a model missing 'agentic' is scored from the rest,
 * not penalized for the gap). undefined only when NO index is available.
 */
function blendQuality(s, [wc, wa, wi]) {
  const parts = [
    [s.coding, wc],
    [s.agentic, wa],
    [s.intelligence, wi],
  ].filter(([v, w]) => v !== undefined && w > 0);
  const wSum = parts.reduce((acc, [, w]) => acc + w, 0);
  if (wSum === 0) return undefined;
  return parts.reduce((acc, [v, w]) => acc + v * w, 0) / wSum;
}

/**
 * Mark the Pareto front on rows that carry a quality value: a row is on the
 * front when no other scored row is both cheaper-or-equal AND better.
 * Sorts by cost ascending internally; sets r.front.
 */
function markParetoFront(rows) {
  const scored = rows.filter((r) => r.q !== undefined).sort((a, b) => a.eff - b.eff || b.q - a.q);
  let bestQ = -Infinity;
  for (const r of scored) {
    r.front = r.q > bestQ;
    if (r.q > bestQ) bestQ = r.q;
  }
}

const usd = (v) => (v === undefined ? '-' : `$${v.toLocaleString('en-US', { maximumFractionDigits: 4 })}`);
const num = (v) => v.toLocaleString('en-US', { maximumFractionDigits: 3 });

async function main() {
  const args = process.argv.slice(2);
  const showAll = args.includes('--all');
  const grepIdx = args.indexOf('--grep');
  const grep = grepIdx >= 0 ? args[grepIdx + 1] : undefined;
  const withBench = args.includes('--benchmarks');
  const qIdx = args.indexOf('--quality');
  const axis = qIdx >= 0 ? args[qIdx + 1] : 'coding';
  const wIdx = args.indexOf('--weights');
  const weights = wIdx >= 0 ? args[wIdx + 1].split(',').map(Number) : [1, 1, 1];
  if (withBench && !['coding', 'agentic', 'intelligence', 'blend'].includes(axis)) {
    throw new Error(`--quality must be coding|agentic|intelligence|blend, got '${axis}'`);
  }
  if (weights.some((w) => !Number.isFinite(w) || w < 0) || weights.length !== 3) {
    throw new Error('--weights needs 3 non-negative numbers, e.g. --weights 1,1,0.5');
  }

  // Benchmarks first: fail fast (missing key / 401 / 429) before any table work.
  let scores = new Map();
  let citation = null;
  let asOf = null;
  if (withBench) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('--benchmarks needs the OPENROUTER_API_KEY environment variable set');
    ({ scores, citation, asOf } = await fetchBenchmarks(apiKey));
  }

  const rows = [];
  let skipped = 0;
  for (const m of await fetchCatalog()) {
    const input = perMillion(m.pricing?.prompt);
    const output = perMillion(m.pricing?.completion);
    if (input === undefined || output === undefined) {
      skipped++;
      continue; // unpriced/dynamic-router entry: not comparable
    }
    const cacheRead = perMillion(m.pricing?.input_cache_read);
    const write = perMillion(m.pricing?.input_cache_write) ?? 0;
    const eff = effectiveRate({ input, output, cacheRead, write });
    const row = { id: m.id ?? '?', input, output, cacheRead, eff };
    if (withBench) {
      // Benchmark rows are keyed by the DATED canonical permaslug
      // (z-ai/glm-5.3-20260816); the catalog's canonical_slug carries exactly
      // that. Joining on the plain id matches only never-renamed models and
      // silently drops every recent release from the quality axis.
      const key = m.canonical_slug || (m.id ?? '').split(':')[0];
      const s = scores.get(key);
      if (s) {
        row.s = s;
        row.q = axis === 'blend' ? blendQuality(s, weights) : s[axis];
      }
    }
    rows.push(row);
  }

  let filtered = grep ? rows.filter((r) => r.id.includes(grep)) : rows;
  if (withBench) {
    const unscored = filtered.filter((r) => r.q === undefined).length;
    if (!showAll) filtered = filtered.filter((r) => r.q !== undefined);
    markParetoFront(rows); // front is computed over ALL priced models, grep only hides rows
    filtered.sort((a, b) => (b.q ?? -Infinity) - (a.q ?? -Infinity));
    console.log(`Quality axis: ${axis}${axis === 'blend' ? ` (weights coding=${weights[0]}, agentic=${weights[1]}, intelligence=${weights[2]})` : ''} - Artificial Analysis indices via OpenRouter${asOf ? `, data as of ${asOf}` : ''}`);
    if (unscored) console.log(`${unscored} priced models have no AA benchmark row${showAll ? " (q = '-')" : ' (hidden, use --all to include)'}`);
  } else {
    filtered.sort((a, b) => a.eff - b.eff);
  }
  const shown = showAll ? filtered : filtered.slice(0, 60);

  console.log(`Usage profile: ${(R_NEW * 100).toFixed(2)}% new input, ${(R_CACHED * 100).toFixed(2)}% cache read, output = ${(R_OUT * 100).toFixed(3)}% of prompt`);
  console.log(`100M-token day: ${num(Math.round(R_NEW * 1e8))} new + ${num(Math.round(R_CACHED * 1e8))} cached + ${num(Math.round(R_OUT * 1e8))} out tokens`);
  console.log(`${rows.length} priced models, ${skipped} skipped (no/stub pricing)\n`);

  if (withBench) {
    const header = ['*', '#', 'id', 'in', 'out', 'cache', 'p_eff', 'cod', 'age', 'int', 'q'].map((h, i) => (i === 2 ? h.padEnd(46) : h.padStart(i <= 1 ? 1 : 9)));
    console.log(header.join(' '));
    shown.forEach((r, i) => {
      const s = r.s ?? {};
      const cells = [
        r.front ? '*' : ' ',
        String(i + 1).padStart(1),
        r.id.padEnd(46),
        usd(r.input).padStart(9),
        usd(r.output).padStart(9),
        (r.cacheRead === undefined ? 'none*' : usd(r.cacheRead)).padStart(9),
        usd(r.eff).padStart(9),
        (s.coding ?? '-').toString().padStart(9),
        (s.agentic ?? '-').toString().padStart(9),
        (s.intelligence ?? '-').toString().padStart(9),
        (r.q === undefined ? '-' : r.q.toFixed(1)).padStart(9),
      ];
      console.log(cells.join(' '));
    });
    if (citation) console.log(`\n${citation}`);
  } else {
    const header = ['#', 'id', 'in', 'out', 'cache', 'p_eff', '$/100M day'].map((h, i) => (i === 1 ? h.padEnd(52) : h.padStart(i === 0 ? 3 : 10)));
    console.log(header.join(' '));
    shown.forEach((r, i) => {
      const cells = [
        String(i + 1).padStart(3),
        r.id.padEnd(52),
        usd(r.input).padStart(10),
        usd(r.output).padStart(10),
        (r.cacheRead === undefined ? 'none*' : usd(r.cacheRead)).padStart(10),
        usd(r.eff).padStart(10),
        ('$' + (r.eff * 100).toFixed(2)).padStart(10),
      ];
      console.log(cells.join(' '));
    });
  }
  if (!showAll && filtered.length > shown.length) {
    console.log(`\n... ${filtered.length - shown.length} more (use --all). 'none*' = no cache price, cached tokens charged at full input.`);
  }
}

main().catch((err) => {
  console.error(String(err?.message ?? err));
  process.exit(1);
});
