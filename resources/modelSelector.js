// OpenRouter Model Selector Webview — runs inside the webview iframe.
// The extension posts RAW per-provider rates (per-1M USD) + benchmark indices
// once per open/refresh; every cost here is re-derived from the controls on
// each input event, so tuning the usage profile is instant and never re-hits
// the API (the benchmarks endpoint is quota-limited at 500 requests/day).
//
// The dot unit is a (model, provider) PAIR: the extension fans the scored
// catalog out to per-model endpoint lists, so the same model appears once per
// provider that passes the context filter, each at its own real price.
// Models without a provider list (everything the benchmarks do not score, or
// a scored model whose fan-out found no usable endpoint) still occupy ONE
// table row at the catalog list price - listed, searchable, never plotted.
// Selecting such a row lazily fetches its real provider endpoints from the
// extension (shared cache, one call) and upgrades it to the normal
// per-provider rows with "Use" (user ruling 2026-09-11: the plot stays
// scored-only, the list stays complete, every listed model stays addable).

(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  // ── State ────────────────────────────────────────────────────
  var models = [];            // [{id, base, bm, endpoints: [{tag, provider, ...}], list?: {...}}] - list = catalog fallback when endpoints is empty
  var qRange = null;          // per-axis {lo,hi} over the scored universe (blend normalization)
  var qRangeSrc = null;       // the models array qRange was computed from (cache key)
  var profile = { rCached: 0.936348, rOut: 0.008256 }; // overwritten by extension
  var selectedKey = null;     // modelId + '\u0000' + provider tag
  var expanded = {};          // modelId -> true for multi-provider groups that are open; default (unset): collapsed
  var haveData = false;
  var configured = [];        // [{id, provider?, elsewhere?, pc?}] - configs the user already has (extension-owned truth; pc = non-default prompt-cache policy)
  var dataSrv = null;         // server id the visible rows were fetched for (echoed back in 'use')
  var endpointState = {};     // list-row id -> 'pending' | 'done' | 'failed' (lazy provider fetch, ruling 2026-09-11)
  var noDataMsg = null;       // set on fetch failure: the empty chart says WHY instead of blaming the filters
  // Display unit: one heavy day of work = 100M prompt tokens (calibrated
  // 2026-09-09 against real usage: ~90M tokens by 20:00 on a working day).
  // p_eff stays per-1M math everywhere; this constant only scales what the
  // UI SHOWS (table, chart, detail, tooltips). Rankings are scale-free.
  var DAY = 100;

  var el = function (id) { return document.getElementById(id); };
  // Shared fuzzy matcher (resources/webview-search.js, loaded first - the
  // SAME function the Model Settings dropdown runs). The substring fallback
  // only matters if that script ever fails to load.
  var SEARCH = window.VllmSearch || { matches: function (t, h) { return h.indexOf(t) !== -1; } };
  var inputs = {
    cache: el('s-cache'), out: el('s-out'), axis: el('sel-axis'), ctx: el('sel-ctx'),
    prompt: el('sel-prompt'),
    free: el('cb-free'), batch: el('cb-batch'), q: el('q'),
    wc: el('sw-c'), wa: el('sw-a'), wi: el('sw-i')
  };

  // ── Cost formula (mirror of scripts/openrouter-cost.mjs, per provider) ──
  // p_eff per 1M prompt tokens. The NEW-input share pays the provider's
  // published cache-write rate IN PLACE OF input when the mix has cache
  // activity (the input buckets are disjoint - see effPerMillion); plain
  // input otherwise. A provider WITHOUT a cache-read price pays FULL input
  // for the cached share (it cannot serve our workload's cache hits).
  // Long-context tiers key off
  // the PRICING PROMPT SIZE control - the user's declared typical request -
  // and are independent of the min-context capacity filter. A provider can
  // report SEVERAL tiers: per the OpenAPI spec every applicable entry
  // (prompt size STRICTLY above its threshold) contributes, later array
  // entries win per price key, and keys no applicable entry reports stay at
  // base. activeTier picks the last applicable entry for the badge;
  // activeRates ACCUMULATES all applicable ones per key over the (time-peak)
  // base - taking one tier wholesale let a later PARTIAL tier discard an
  // earlier tier's still-applicable field override (external review
  // 2026-09-09). Per key the shown value is the peak UPPER BOUND (max, like
  // the time-window fold), never an order- or clock-dependent guess.
  function activeTier(ep, promptSize) {
    if (!ep.tiers) return undefined;
    var hit;
    for (var i = 0; i < ep.tiers.length; i++) {
      if (promptSize > ep.tiers[i].at) hit = ep.tiers[i];
    }
    return hit;
  }
  function activeRates(ep, promptSize) {
    var tiers = ep.tiers;
    if (!tiers) return ep;
    var r = null;
    for (var i = 0; i < tiers.length; i++) {
      var t = tiers[i];
      if (promptSize <= t.at) continue;
      if (!r) r = { in: ep.in, out: ep.out, cache: ep.cache, write: ep.write, w1h: ep.w1h };
      if (t.in != null && t.in > r.in) r.in = t.in;
      if (t.out != null && t.out > r.out) r.out = t.out;
      if (t.cache != null && (r.cache == null || t.cache > r.cache)) r.cache = t.cache;
      if (t.write != null && t.write > (r.write || 0)) r.write = t.write;
      if (t.w1h != null && t.w1h > (r.w1h || 0)) r.w1h = t.w1h;
    }
    return r || ep;
  }
  // Cost per 1M prompt tokens under the user's declared mix. The three input
  // buckets (regular input, cache write, cache read) are DISJOINT: a token
  // written to the cache is billed at the write rate INSTEAD OF the input
  // rate, never on top of it (Anthropic semantics; live-verified Sonnet 4.6:
  // input 3.00, write 3.75 = 1.25x - an earlier in+write formula billed
  // 6.75 and overstated the default profile ~30%, external review
  // 2026-09-09). With caching active the growing prefix's new tokens ARE the
  // cache delta, so the new share is billed at the write rate; with no cache
  // activity (read share 0) or no published write rate it is plain input.
  function effPerMillion(ep, promptSize, pc) {
    var rate = activeRates(ep, promptSize);
    var x = mix(rate, pc);
    var rOut = parseFloat(inputs.out.value) / 100;
    return x.rn * x.newRate + x.rc * x.pCache + rOut * rate.out;
  }
  // Slider profile adjusted to the config's cache policy (round-6 review):
  // 'off' prices the row UNCACHED (no read share, new input at plain input -
  // a Claude config with the directive off never writes or reads a cache);
  // '1h' swaps in the published 1-hour write rate (w1h) when the provider
  // publishes one, else the 5-min rate stands (documented fallback). pc is
  // only ever set for anthropic-family configs (cfgPolicy mirrors the
  // request-path family gate); every other row uses the raw profile.
  function mix(rate, pc) {
    var rc = parseFloat(inputs.cache.value) / 100;
    var write = rate.write || 0;
    var pCache = rate.cache !== undefined && rate.cache !== null ? rate.cache : rate.in;
    if (pc === 'off') { rc = 0; write = 0; pCache = rate.in; }
    else if (pc === '1h' && rate.w1h) write = rate.w1h;
    var rn = 1 - rc;
    var newRate = rc > 0 && write > 0 ? write : rate.in;
    return { rc: rc, rn: rn, newRate: newRate, pCache: pCache, write: write };
  }

  // Per-axis min/max across the COMPLETE universe (models reporting all
  // three indices - the only models the blend can show), not the filtered
  // view, so a model's blend score never shifts as you type in the filter
  // box. Cached per model-list identity: keyed on the `models` reference
  // itself, so replacing the list (refresh or error wipe) can never serve a
  // stale range no matter where the assignment happens.
  function axisRange() {
    if (qRange && qRangeSrc === models) return qRange;
    var axes = { coding: null, agentic: null, intelligence: null };
    for (var i = 0; i < models.length; i++) {
      var bm = models[i].bm;
      if (!bm || bm.coding == null || bm.agentic == null || bm.intelligence == null) continue;
      for (var a in axes) {
        var v = bm[a];
        if (v === undefined || v === null) continue;
        if (!axes[a]) axes[a] = { lo: v, hi: v };
        else { if (v < axes[a].lo) axes[a].lo = v; if (v > axes[a].hi) axes[a].hi = v; }
      }
    }
    qRange = axes;
    qRangeSrc = models;
    return qRange;
  }

  // Blend = weighted average of the indices AFTER normalizing each axis to
  // 0-1 within the complete universe, scaled to 0-100. The normalization is
  // not cosmetic - the three AA indices run on DIFFERENT numeric scales, so
  // the original raw weighted average let the widest-scale axis dominate no
  // matter what the weight sliders said, and worse: a model MISSING a
  // low-scale index reweighted over only its high-scale ones and could beat
  // a model that led every single category (user report 2026-09-09: the
  // all-around leader lost its own blend). With per-axis normalization the
  // leader of every index provably tops the blend (n=1 each axis -> 100).
  // Completeness is enforced, not reweighted (user ruling 2026-09-09 after
  // external review): the blend scores ONLY models reporting all three
  // indices, a single axis only models reporting that one. No guessing, no
  // massaging: a partial model never earns a score (or a tie at 100) it has
  // no data for. Undefined here means NO DOT and NO STAR (2026-09-11: the
  // model itself stays in the table as a list row, quality shown as '-').
  function quality(m) {
    var axis = inputs.axis.value;
    var bm = m.bm;
    if (!bm) return undefined;
    if (axis !== 'blend') return bm[axis];
    if (bm.coding == null || bm.agentic == null || bm.intelligence == null) return undefined;
    var rg = axisRange();
    var parts = [
      [bm.coding, 'coding', parseFloat(inputs.wc.value)],
      [bm.agentic, 'agentic', parseFloat(inputs.wa.value)],
      [bm.intelligence, 'intelligence', parseFloat(inputs.wi.value)]
    ];
    var wSum = 0, acc = 0;
    for (var i = 0; i < parts.length; i++) {
      var w = parts[i][2], r = rg[parts[i][1]];
      if (w <= 0 || !r) continue;
      var n = r.hi > r.lo ? (parts[i][0] - r.lo) / (r.hi - r.lo) : 1;
      wSum += w; acc += n * w;
    }
    return wSum > 0 ? 100 * acc / wSum : undefined;
  }

  // ── Formatting ───────────────────────────────────────────────
  function usd(v) {
    if (v === undefined || v === null) return '-';
    return '$' + v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  }
  // Day-scale money (the $/day columns, totals, tooltips): two decimals -
  // cent noise is meaningless at 100M scale. Rate columns keep usd():
  // published $/1M rates genuinely need 4 digits.
  function usd2(v) {
    if (v === undefined || v === null) return '-';
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtQ(v) { return v === undefined || v === null ? '-' : v.toFixed(1); }
  function fmtCtx(v) { return v === undefined || v === null ? '-' : Math.round(v / 1024) + 'k'; }
  // Tier thresholds are DECIMAL token counts from the API (32000, 256000) -
  // formatting them with the binary fmtCtx showed '31k'/'250k'. Windows are
  // binary power-of-two sizes and keep fmtCtx; tiers are round decimals.
  function fmtTier(v) { return v === undefined || v === null ? '-' : Math.round(v / 1000) + 'k'; }
  // Perf stats: p50 TTFT ms / p50 tok/s over the last 30 min (OpenRouter only
  // reports them with recent traffic; '-' means unmeasured, not down).
  function fmtLat(v) { return v === undefined || v === null ? '-' : v < 1000 ? Math.round(v) + ' ms' : (v / 1000).toFixed(1) + ' s'; }
  function fmtTput(v) { return v === undefined || v === null ? '-' : Math.round(v) + ' tok/s'; }
  function fmtUp(v) { return v === undefined || v === null ? '-' : v.toFixed(2) + '%'; }
  // Compact token counts for the detail card's example column: 6.4M, 93.6M,
  // 0.92M, 4k. Three significant digits, trailing zeros trimmed. Counts are
  // 100M-day shares, so M covers nearly everything; k is the fallback.
  function fmtTok(n) {
    if (n === undefined || n === null) return '-';
    var trim = function (v) { return String(parseFloat(v.toPrecision(3))); };
    if (n >= 1e5) return trim(n / 1e6) + 'M';
    if (n >= 1e3) return trim(n / 1e3) + 'k';
    return String(Math.round(n));
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── Flatten + filter + score pass (one row per model-provider pair) ──
  // The table gets a row for EVERY surviving model: pairs from the endpoint
  // fan-out, or one row at the catalog list price where there are none (the
  // pseudo-endpoint below: list: true, or bare: true when even the headline
  // carries no rate - such rows search and price but never plot and never
  // earn a star; they carry no "Use" until selecting them lazily upgrades
  // them to real provider rows (routing needs a real provider tag, and one
  // invented from a headline would lie). A missing quality score no longer
  // drops the model (that 2026-09-09 rule now governs the plot and the stars
  // only, via quality()'s undefined reaching drawChart and the Pareto filter
  // below).
  function computeRows() {
    var minCtx = parseInt(inputs.ctx.value, 10);
    var promptSize = parseInt(inputs.prompt.value, 10);
    var text = inputs.q.value.trim().toLowerCase();
    var rows = [];
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      if (!inputs.batch.checked && m.id.indexOf(':batch') !== -1) continue;
      if (!inputs.free.checked && m.id.indexOf(':free') !== -1) continue;
      // Search box: the shared quickpick-style matcher (substring or
      // subsequence) over the id and every provider name. Since 2026-09-11
      // the text does NOT drop rows: it marks them (hit). The table shows
      // matches only; the chart keeps EVERY dot for context and dims the
      // non-matches, so axes and Pareto stars never shift while typing.
      var hit = true;
      if (text) {
        hit = SEARCH.matches(text, m.id.toLowerCase()) ||
          (m.endpoints || []).some(function (e) {
            return SEARCH.matches(text, (e.provider || '').toLowerCase());
          });
      }
      var q = quality(m);
      var eps = m.endpoints && m.endpoints.length > 0 ? m.endpoints : [m.list
        ? {
            tag: '', provider: '', list: true,
            in: m.list.in, out: m.list.out, cache: m.list.cache,
            write: m.list.write, w1h: m.list.w1h, ctx: m.list.ctx,
            tiers: m.list.tiers, timeWorst: m.list.timeWorst
          }
        : { tag: '', provider: '', list: true, bare: true }];
      for (var j = 0; j < eps.length; j++) {
        var ep = eps[j];
        // Provider's OWN window must satisfy the selector — the catalog max is
        // not a promise the cheap provider keeps. A list row is filtered by
        // the catalog's advertised window; a bare row proves nothing, so any
        // min-context filter drops it.
        if (minCtx > 0 && (ep.ctx === undefined || ep.ctx < minCtx)) continue;
        var tierHit = activeTier(ep, promptSize);
        rows.push({
          m: m, ep: ep, q: q, hit: hit,
          eff: ep.bare ? undefined : effPerMillion(ep, promptSize, cfgPolicy(m.id, ep.tag, ep, promptSize)),
          tierOn: !!tierHit,
          tierAt: tierHit ? tierHit.at : undefined
        });
      }
    }
    // Pareto front over the pairs - real provider pairs with a score only:
    // a list-price headline is not a provider truth and an unscored row has
    // no quality to be front-ranked on. Computed over ALL rows, never the
    // search matches: stars are a property of the loaded data, not of what
    // you happen to have typed (same stability law as the blend range). Rows are processed in cost order, and
    // bit-identical prices (the common case: providers copying the same rate
    // card) form one tie group scored together: every pair at the group's
    // best quality earns the star, not just the sort-lucky first. A pair is
    // on the front iff no strictly cheaper pair scores as good or better AND
    // no same-price pair scores strictly better. Providers of one model share
    // a quality score, so within a model only the cheapest price reaches the
    // front; price twins there share the star.
    var bestBelow = -Infinity;
    var byCost = rows.filter(function (r) {
      return !r.ep.list && r.eff !== undefined && r.q !== undefined && r.q !== null;
    }).sort(function (a, b) { return a.eff - b.eff; });
    var gi = 0;
    while (gi < byCost.length) {
      var gj = gi, bestIn = -Infinity;
      while (gj < byCost.length && byCost[gj].eff === byCost[gi].eff) {
        var qv = byCost[gj].q;
        if (qv !== undefined && qv !== null && qv > bestIn) bestIn = qv;
        gj++;
      }
      for (var gk = gi; gk < gj; gk++) {
        var q = byCost[gk].q;
        byCost[gk].front = q !== undefined && q !== null && q > bestBelow && q === bestIn;
      }
      if (bestIn > bestBelow) bestBelow = bestIn;
      gi = gj;
    }
    return rows;
  }

  function pairKey(r) { return r.m.id + '\u0000' + r.ep.tag; }

  // Configured-model marks (the extension knows the settings, the webview
  // does not): true = a config on THIS server matches this pair - Auto
  // configs match every provider row, a pinned one only its tag. A string =
  // the wire id lives on another entry sharing this URL; the string is that
  // entry's name for the tooltip.
  function cfgMark(id, tag) {
    var elsewhere = null;
    for (var i = 0; i < configured.length; i++) {
      var c = configured[i];
      if (c.id !== id) continue;
      if (c.provider && c.provider !== tag) continue;
      if (!c.elsewhere) return true;
      elsewhere = elsewhere || c.elsewhere;
    }
    return elsewhere;
  }
  // The configured model's prompt-cache POLICY, for policy-aware pricing:
  // only for the family the request path actually sends the directive for
  // (mirrors /^~?anthropic\// in requestBuilder.ts - a policy on any other
  // family is inert on the wire and must not bend the price). Several configs
  // may share one wire id, so the pick is a full PRIORITIZED ranking, never
  // first-match and never non-default-only (external reviews 2026-09-09,
  // rounds 7-8): EVERY matching config carries a policy, an omitted one
  // standing in as 'on' - a pin left at the default must not be outvoted by
  // a lower-rank Auto. Rank 1, who serves this row: a config pinning THIS
  // exact provider (it is the config that would actually serve it), then an
  // Auto on this entry, then an Auto on a sibling URL entry; pinned-but-not-
  // this-tag never matches (same rule as cfgMark). Rank 2: an explicit choice
  // beats an omitted one at the same rank. Rank 3: a genuine conflict at
  // equal rank and explicitness prices the COSTLIEST policy under the row's
  // current profile - COMPUTED, never a static order (round-9 review: with
  // the default cache-heavy profile 'off' (~$3.12/M on Sonnet 4.6, full
  // input on every token) far exceeds '1h' (~$0.79/M), so a static
  // 1h > on > off picked the wrong worst case). A fixed order
  // (1h > on > off) settles only exact cost ties (eg the no-cache profile,
  // where all three price identically) - deterministic under any mark order.
  // An 'on' winner returns undefined: the caller contract prices only
  // off/1h specially, 'on' is the default path.
  function cfgPolicy(id, tag, ep, promptSize) {
    if (!/^~?anthropic\//.test(id)) return undefined;
    var TIE = { off: 0, on: 1, '1h': 2 }; // ONLY for exact computed-cost ties
    var best, bestRank = 9, bestExp = 9, bestCost = -Infinity;
    for (var i = 0; i < configured.length; i++) {
      var c = configured[i];
      if (c.id !== id) continue;
      var rank;
      if (c.provider === tag) rank = c.elsewhere ? 1 : 0;
      else if (!c.provider) rank = c.elsewhere ? 3 : 2;
      else continue;
      var pc = c.pc || 'on';
      var exp = c.pc ? 0 : 1;
      var cost = effPerMillion(ep, promptSize, pc === 'on' ? undefined : pc);
      var replace;
      if (best === undefined || rank < bestRank || (rank === bestRank && exp < bestExp)) replace = true;
      else if (rank === bestRank && exp === bestExp) replace = cost > bestCost || (cost === bestCost && TIE[pc] > TIE[best]);
      else replace = false;
      if (replace) { best = pc; bestRank = rank; bestExp = exp; bestCost = cost; }
    }
    return best === 'on' ? undefined : best;
  }
  function cfgMarkHtml(cfg) {
    if (cfg === true) return '<span class="cfg-mark" title="already configured on this server - using it again overwrites this config">&#x2713;</span> ';
    if (typeof cfg === 'string') return '<span class="cfg-mark-other" title="' + esc('configured on "' + cfg + '" (another entry with the same URL)') + '">&#9671;</span> ';
    return '';
  }

  // ── Scatter chart (hand-drawn SVG, log-x cost, linear-y quality) ──
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svgEl(name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  function drawChart(rows) {
    var wrap = el('chart');
    wrap.innerHTML = '';
    // The plot shows scored pairs on REAL provider endpoints only. List-price
    // rows are catalog headlines, not provider truths: they live in the table.
    // A search never removes dots (ruling 2026-09-11): the axes, the stars
    // and the whole field stay put while typing, hits are marked by a ring.
    var searching = inputs.q.value.trim() !== '';
    var scored = rows.filter(function (r) {
      return r.q !== undefined && r.q !== null && r.eff !== undefined && !r.ep.list;
    });
    if (rows.length === 0) {
      var d0 = document.createElement('div');
      d0.className = 'hint';
      d0.textContent = noDataMsg || 'Nothing passes the capacity filters - lower min context or re-tick the variant checkboxes.';
      wrap.appendChild(d0);
      return;
    }
    if (scored.length === 0) {
      var d1 = document.createElement('div');
      d1.className = 'hint';
      d1.textContent = 'No benchmark-scored provider passes the current filters - the list below still shows every model.';
      wrap.appendChild(d1);
      return;
    }

    var W = 920, H = 430, padL = 56, padR = 16, padT = 14, padB = 40;
    var svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, 'class': 'scatter', preserveAspectRatio: 'xMidYMid meet' });

    // x: $ per 100M-token day, log scale (provider prices span $0.3 to $30k).
    function costDay(r) { return Math.max(r.eff * DAY, 0.01); }
    var lo = Infinity, hi = -Infinity;
    rows.forEach(function (r) { var c = costDay(r); if (c < lo) lo = c; if (c > hi) hi = c; });
    var lx = Math.floor(Math.log10(lo)), hx = Math.ceil(Math.log10(Math.max(hi, lo * 10)));
    function x(c) { return padL + (Math.log10(Math.max(c, 0.01)) - lx) / (hx - lx) * (W - padL - padR); }

    // y: quality, linear over the scored rows' range.
    var qMax = 0;
    scored.forEach(function (r) { if (r.q > qMax) qMax = r.q; });
    qMax = Math.max(Math.ceil(qMax / 10) * 10, 10);
    function y(q) { return H - padB - (q / qMax) * (H - padT - padB); }

    // Gridlines + x ticks (powers of ten).
    for (var p = lx; p <= hx; p++) {
      var val = Math.pow(10, p);
      var gx = x(val);
      svg.appendChild(svgEl('line', { x1: gx, y1: padT, x2: gx, y2: H - padB, 'class': 'grid' }));
      var tl = svgEl('text', { x: gx, y: H - padB + 16, 'class': 'tick', 'text-anchor': 'middle' });
      tl.textContent = val >= 1 ? '$' + val.toLocaleString('en-US') : '$' + val;
      svg.appendChild(tl);
    }
    // y ticks at 0 / half / max.
    [0, 0.5, 1].forEach(function (f) {
      var qv = qMax * f, gy = y(qv);
      svg.appendChild(svgEl('line', { x1: padL, y1: gy, x2: W - padR, y2: gy, 'class': 'grid' }));
      var yl = svgEl('text', { x: padL - 8, y: gy + 4, 'class': 'tick', 'text-anchor': 'end' });
      yl.textContent = qv.toFixed(0);
      svg.appendChild(yl);
    });
    var xl = svgEl('text', { x: (padL + W - padR) / 2, y: H - 6, 'class': 'axis-label', 'text-anchor': 'middle' });
    xl.textContent = 'cost per 100M-token day at the SERVING PROVIDER (USD, log scale, your usage profile)';
    svg.appendChild(xl);
    var ylab = svgEl('text', { x: 14, y: (padT + H - padB) / 2, 'class': 'axis-label', 'text-anchor': 'middle', transform: 'rotate(-90 14 ' + ((padT + H - padB) / 2) + ')' });
    ylab.textContent = axisLabel() + ' (higher is better)';
    svg.appendChild(ylab);

    // Dots: dominated first, front last (on top). Unscored and list-price
    // rows are already out of `scored` - they never get a dot.
    function dot(r, cls) {
      var c = svgEl('circle', { cx: x(costDay(r)), cy: y(r.q), r: r.front ? 5.5 : 3.5, 'class': cls });
      var title = document.createElementNS(SVG_NS, 'title');
      title.textContent = r.m.id + ' @ ' + r.ep.provider +
        (r.ep.quant && r.ep.quant !== 'unknown' ? ' (' + r.ep.quant + ')' : '') +
        ' - ' + usd2(r.eff * DAY) + '/day' +
        (r.tierOn ? ' [long-context tier]' : '') +
        ' - ctx ' + fmtCtx(r.ep.ctx) +
        ' - lat ' + fmtLat(r.ep.lat) + ' - ' + fmtTput(r.ep.tput) + ' - up ' + fmtUp(r.ep.uptime) +
        ' - ' + r.q.toFixed(1);
      c.appendChild(title);
      if (pairKey(r) === selectedKey) c.setAttribute('class', cls + ' selected');
      c.addEventListener('click', function () { jumpTo(r.m.id, r.ep.tag); });
      svg.appendChild(c);
    }
    scored.forEach(function (r) { if (!r.front) dot(r, 'dot-dominated'); });
    scored.forEach(function (r) { if (r.front) dot(r, 'dot-front'); });
    // Search hits get a solid ring on top of their dot (ruling 2026-09-11,
    // after live use: dimming the rest alone was too hard to spot). The
    // dashed white halo below stays the SELECTION's exclusive mark, so hit
    // ring and selection are never confused.
    if (searching) {
      scored.forEach(function (r) {
        if (!r.hit) return;
        svg.appendChild(svgEl('circle', {
          cx: x(costDay(r)), cy: y(r.q), r: r.front ? 8.5 : 6.5, 'class': 'dot-hit'
        }));
      });
    }
    // Selection halo on top of every dot: a dashed ring around the selected
    // pair, so the pick stays visible even under overlapping dots or the
    // dimmed dominated styles (CSS adds the glow to the dot itself).
    for (var si = 0; si < scored.length; si++) {
      if (pairKey(scored[si]) === selectedKey) {
        svg.appendChild(svgEl('circle', { cx: x(costDay(scored[si])), cy: y(scored[si].q), r: 10, 'class': 'dot-halo' }));
        break;
      }
    }
    wrap.appendChild(svg);
  }

  function axisLabel() {
    var a = inputs.axis.value;
    if (a === 'coding') return 'AA coding index';
    if (a === 'agentic') return 'AA agentic index';
    if (a === 'intelligence') return 'AA intelligence index';
    return 'AA blend (0-100 relative)';
  }

  // ── Table ────────────────────────────────────────────────────
  // Set when a chart dot is clicked: the next drawTable scrolls to that pair's
  // row and highlights every row at the same effective price (identical-price
  // providers sort apart, so the highlight is what shows the twin set).
  var jumpKey = null;

  function drawTable(rows) {
    var thead = document.querySelector('#tbl thead');
    var tbody = document.querySelector('#tbl tbody');
    thead.innerHTML = '<tr><th title="Pareto front: no provider is both cheaper and better">*</th>' +
      '<th>model</th><th>provider</th>' +
      '<th title="effective cost of a heavy day (100M prompt tokens) under your usage profile (see How it is calculated)">$/100M day</th>' +
      '<th title="the provider\'s own context window">ctx</th>' +
      '<th title="p50 time to first token, last 30 min (OpenRouter-reported)">lat</th>' +
      '<th title="p50 output throughput, last 30 min (OpenRouter-reported)">tok/s</th>' +
      '<th title="uptime, last day">up</th>' +
      '<th title="input $/1M tokens">in</th><th title="output $/1M tokens">out</th>' +
      '<th title="cache-read $/1M tokens; none* = provider has no cache rate, cached share pays full input">cache</th>' +
          '<th title="cache-write $/1M tokens: with cache activity the new-input share is billed at THIS rate instead of input">write</th>' +
      '<th' + (axisTitle() ? ' title="' + esc(axisTitle()) + '"' : '') + '>' + esc(shortAxis()) + '</th></tr>';
    var sorted = sortRows(rows);
    // Same-price twin set for the dot-click jump: identical published rates
    // produce a bit-identical p_eff, so strict equality finds them. Scoped to
    // the clicked pair's model - a different model that happens to cost the
    // same is not what the dot points at.
    var effSel, idSel;
    if (jumpKey) {
      for (var s = 0; s < rows.length; s++) {
        if (pairKey(rows[s]) === jumpKey) { effSel = rows[s].eff; idSel = rows[s].m.id; break; }
      }
    }
    // No display cap: a chart dot must always have its row (the jump scrolls
    // to any pair). The chart already renders every pair per input event, so
    // the table adds DOM of the same order, not a new cost class.
    function pairRowHtml(r, isChild) {
      var ep = r.ep;
      var rate = activeRates(ep, parseInt(inputs.prompt.value, 10));
      var noCache = rate.cache === undefined || rate.cache === null;
      var classes = [];
      if (isChild) classes.push('child');
      if (pairKey(r) === selectedKey) classes.push('selected');
      if (r.front) classes.push('front');
      if (jumpKey && effSel !== undefined && r.m.id === idSel && r.eff === effSel) classes.push('samecost');
      return '<tr data-id="' + esc(r.m.id) + '" data-tag="' + esc(ep.tag) + '"' +
        (classes.length ? ' class="' + classes.join(' ') + '"' : '') + '>' +
        '<td>' + (r.front ? '&#9733;' : '') + '</td>' +
        '<td class="mid modelid">' + cfgMarkHtml(cfgMark(r.m.id, ep.tag)) + esc(r.m.id) + (r.tierOn ? ' <span class="hint">(tier)</span>' : '') + '</td>' +
        (ep.list
          ? '<td class="mid prov dim">' + (ep.bare ? 'no pricing' : 'list price') + '</td>'
          : '<td class="mid prov">' + esc(ep.provider) + '</td>') +
        '<td class="num">' + (ep.timeWorst ? '<span title="time-of-day pricing - shown at the most expensive window; look up the exact windows on the provider\'s OpenRouter page">&#9719;</span> ' : '') + usd2(r.eff === undefined ? undefined : r.eff * DAY) + '</td>' +
        '<td class="num">' + fmtCtx(ep.ctx) + '</td>' +
        '<td class="num">' + (ep.list ? '-' : fmtLat(ep.lat)) + '</td>' +
        '<td class="num">' + (ep.list ? '-' : fmtTput(ep.tput)) + '</td>' +
        '<td class="num">' + (ep.list ? '-' : fmtUp(ep.uptime)) + '</td>' +
        '<td class="num">' + usd(rate.in) + '</td>' +
        '<td class="num">' + usd(rate.out) + '</td>' +
        '<td class="num">' + (ep.bare ? '-' : (noCache ? 'none*' : usd(rate.cache))) + '</td>' +
        '<td class="num">' + (rate.write ? usd(rate.write) : '-') + '</td>' +
        '<td class="num"><b>' + fmtQ(r.q) + '</b></td></tr>';
    }
    // Collapse pass (user feature 2026-09-09): a model served by several
    // providers becomes ONE group row - cheapest price, largest window, the
    // model's quality, provider count - with the provider rows as children.
    // Collapsed by default; selecting any pair opens its group (select()
    // marks it), the caret toggles without selecting. Single-provider models
    // skip the wrapper entirely - nothing to collapse. Group ORDER follows
    // the group leader = each model's first row in flat order (models share
    // one quality score across providers, so that is the model's best pair).
    var groups = [], gById = {};
    for (var i = 0; i < sorted.length; i++) {
      var g = gById[sorted[i].m.id];
      if (!g) { g = gById[sorted[i].m.id] = { id: sorted[i].m.id, rows: [] }; groups.push(g); }
      g.rows.push(sorted[i]);
    }
    var byEff = function (a, b) { return a.eff - b.eff; };
    var html = '';
    for (i = 0; i < groups.length; i++) {
      var grp = groups[i];
      if (grp.rows.length === 1) { html += pairRowHtml(grp.rows[0], false); continue; }
      grp.rows.sort(byEff);
      var lead = grp.rows[0];
      var open = expanded[grp.id] === true;
      var anyFront = false, maxCtx, mark = false, k;
      for (k = 0; k < grp.rows.length; k++) {
        if (grp.rows[k].front) anyFront = true;
        if (grp.rows[k].ep.ctx !== undefined && (maxCtx === undefined || grp.rows[k].ep.ctx > maxCtx)) maxCtx = grp.rows[k].ep.ctx;
        if (mark !== true) {
          var cm = cfgMark(grp.id, grp.rows[k].ep.tag);
          if (cm === true) mark = true;
          else if (typeof cm === 'string' && mark === false) mark = cm;
        }
      }
      // Aggregates only - the per-provider rate columns stay blank rather
      // than fake a model-level rate that no provider actually quotes.
      html += '<tr class="grp' + (anyFront ? ' front' : '') + '" data-group="' + esc(grp.id) + '" data-lead="' + esc(lead.ep.tag) + '">' +
        '<td>' + (anyFront ? '&#9733;' : '') + '</td>' +
        '<td class="mid"><span class="caret">' + (open ? '&#9662;' : '&#9656;') + '</span>' + cfgMarkHtml(mark) + esc(grp.id) + '</td>' +
        '<td class="mid dim">' + grp.rows.length + ' providers</td>' +
        '<td class="num">' + (lead.ep.timeWorst ? '<span title="time-of-day pricing - shown at the most expensive window; look up the exact windows on the provider\'s OpenRouter page">&#9719;</span> ' : '') + usd2(lead.eff * DAY) + '</td>' +
        '<td class="num">' + fmtCtx(maxCtx) + '</td>' +
        '<td class="num dim">-</td><td class="num dim">-</td><td class="num dim">-</td>' +
        '<td class="num dim">-</td><td class="num dim">-</td><td class="num dim">-</td><td class="num dim">-</td>' +
        '<td class="num"><b>' + fmtQ(lead.q) + '</b></td></tr>';
      if (open) for (k = 0; k < grp.rows.length; k++) html += pairRowHtml(grp.rows[k], true);
    }
    tbody.innerHTML = html;
    if (jumpKey) {
      var sep = jumpKey.indexOf('\u0000');
      var tr = tbody.querySelector('tr[data-id="' + jumpKey.slice(0, sep) +
        '"][data-tag="' + jumpKey.slice(sep + 1) + '"]');
      // Scroll ONLY the list container (never the page): the chart above the
      // table stays exactly where it is while the row glides to its middle.
      if (tr) {
        var wrap = el('table-wrap');
        var wr = wrap.getBoundingClientRect();
        var rr = tr.getBoundingClientRect();
        // Center the row in the ON-SCREEN band of the list box, not in the
        // box itself - a box poking below the fold (or starting above it)
        // made the old box-center math land off-view on some window sizes.
        var bandTop = Math.max(wr.top, 0);
        var bandBot = Math.min(wr.bottom, window.innerHeight);
        // Only when no meaningful band exists (box fully off-screen) nudge
        // the page the minimum that reveals the box; the chart above stays
        // untouched in every other case.
        var page = bandBot - bandTop < 40
          ? (wr.top < 0 ? wr.top : wr.bottom - window.innerHeight) : 0;
        if (page) window.scrollBy({ top: page, behavior: 'smooth' });
        var topNew = wr.top - page;
        var target = (Math.max(0, -topNew) +
          Math.min(wr.height, window.innerHeight - topNew)) / 2;
        // Box-local row offset is unaffected by the page scroll (box and row
        // shift together), so both smooth scrolls may run in parallel.
        wrap.scrollTo({
          top: wrap.scrollTop + (rr.top - wr.top) + rr.height / 2 - target,
          behavior: 'smooth'
        });
      }
      jumpKey = null;
    }
  }

  function shortAxis() {
    var a = inputs.axis.value;
    return a === 'blend' ? 'blend' : a;
  }
  // Extra header hint where the short label hides the scale change.
  function axisTitle() {
    return inputs.axis.value === 'blend'
      ? 'relative 0-100: each AA index normalized within the scored set, then weighted by your sliders (see How it is calculated)'
      : null;
  }

  // The flat pair order, as a function - drawTable groups these rows into
  // collapsible model blocks, and the keyboard handler walks this SAME flat
  // order; landing on a row inside a collapsed group opens the group (select
  // marks it expanded), so hidden rows reveal themselves on arrival.
  function sortRows(rows) {
    return rows.slice().sort(function (a, b) {
      var aq = a.q === undefined || a.q === null ? -Infinity : a.q;
      var bq = b.q === undefined || b.q === null ? -Infinity : b.q;
      if (bq !== aq) return bq - aq;
      // Unpriceable bare rows sink below every priced one.
      var ae = a.eff === undefined ? Infinity : a.eff;
      var be = b.eff === undefined ? Infinity : b.eff;
      return ae - be;
    });
  }

  // ── Detail panel: one pair's formula, itemized, under current controls ──
  function drawDetail(rows) {
    var box = el('detail');
    var hit = null;
    for (var i = 0; i < rows.length; i++) if (pairKey(rows[i]) === selectedKey) { hit = rows[i]; break; }
    if (!hit) {
      box.innerHTML = '<div class="hint">Click a dot or row for the provider cost breakdown.</div>';
      return;
    }
    var m = hit.m, ep = hit.ep;
    // A bare row (no list price either) has nothing to itemize - say so,
    // show the lazy-fetch state, and still offer the model's own page.
    if (ep.bare) {
      box.innerHTML = '<h2>' + esc(m.id) + '</h2>' +
        '<div class="hint">' + listStateText(m.id) + '</div>' +
        '<div class="detail-actions"><button id="btn-page">OpenRouter page</button></div>';
      el('btn-page').addEventListener('click', function () {
        vscode.postMessage({ type: 'open', url: 'https://openrouter.ai/' + m.id.split(':')[0] });
      });
      return;
    }
    var promptSize = parseInt(inputs.prompt.value, 10);
    var rate = activeRates(ep, promptSize);
    var pc = cfgPolicy(m.id, ep.tag, ep, promptSize);
    var x = mix(rate, pc);
    var rCached = x.rc;
    var rNew = x.rn;
    var rOut = parseFloat(inputs.out.value) / 100;
    var noCache = rate.cache === undefined || rate.cache === null;
    var pCache = x.pCache;
    var write = x.write;
    var tok = function (frac) { return fmtTok(Math.round(frac * 1e6 * DAY)); };
    // Plain data rows only: every explanation lives in the calc modal.
    // Left half is what you pay (label + the provider's published $/1M rate,
    // usd() not usd2()); right of the separator, the example day: DAY-scaled
    // tokens and their cost. Currency is '$' in header and values alike.
    var line = function (label, tokens, price, cost) {
      return '<tr><td>' + label + '</td><td class="num">' + usd(price) + '</td>' +
        '<td class="num ex">' + tokens + '</td>' +
        '<td class="num">' + usd2(cost) + '</td></tr>';
    };
    var bm = m.bm || {};
    var cfg = cfgMark(m.id, ep.tag);
    var page = 'https://openrouter.ai/' + m.id.split(':')[0];
    // Sibling spread: the same model's other providers surviving the filter.
    var siblings = rows.filter(function (r) { return r.m.id === m.id; });
    var sibHtml = '';
    if (siblings.length > 1) {
      siblings.sort(function (a, b) { return a.eff - b.eff; });
      sibHtml = '<div class="detail-q">' + siblings.length + ' providers pass, ' +
        usd2(siblings[0].eff * DAY) + ' to ' + usd2(siblings[siblings.length - 1].eff * DAY) +
        ' per 100M-token day</div>';
    }
    box.innerHTML =
      '<h2>' + esc(m.id) + '</h2>' +
      '<h3>' + esc(ep.provider) + (ep.quant && ep.quant !== 'unknown' ? ' &middot; ' + esc(ep.quant) : '') + '</h3>' +
      '<div class="detail-badges">' +
      (hit.front ? '<span class="badge front">&#9733; Pareto front</span>' : '') +
      (cfg === true ? '<span class="badge front">&#x2713; configured on this server</span>' : '') +
      (typeof cfg === 'string' ? '<span class="badge">&#9671; configured on ' + esc(cfg) + '</span>' : '') +
      (hit.tierOn ? '<span class="badge">long-context tier &gt;' + fmtTier(hit.tierAt) + '</span>' : '') +
      (ep.timeWorst ? '<span class="badge">&#9719; time-of-day pricing - shown at the peak window, check the provider\'s OpenRouter page for your windows</span>' : '') +
      (pc === 'off' ? '<span class="badge">prompt cache off in your config - priced uncached</span>' : '') +
      (pc === '1h' ? '<span class="badge">1-hour prompt cache in your config - write priced at ' + (rate.w1h ? usd(rate.w1h) : 'the 5-min rate (no 1h rate published)') + '</span>' : '') +
      (ep.list ? '<span class="badge">' + listStateText(m.id) + '</span>' : '') +
      '<span class="badge">ctx ' + fmtCtx(ep.ctx) + '</span>' +
      '<span class="badge">lat ' + fmtLat(ep.lat) + '</span>' +
      '<span class="badge">' + fmtTput(ep.tput) + '</span>' +
      (noCache ? '<span class="badge">no cache rate</span>' : '') +
      (ep.uptime !== undefined && ep.uptime !== null ? '<span class="badge">uptime ' + ep.uptime.toFixed(2) + '%</span>' : '') +
      '</div>' +
      '<table class="breakdown"><thead><tr><th>Cost</th><th class="num">$/1M tok</th><th class="num ex">Example</th><th class="num">est. $/day</th></tr></thead><tbody>' +
      (x.rc > 0 && write > 0
        ? line('new input<br>(cache write)', tok(rNew), write, DAY * rNew * write)
        : line('new input', tok(rNew), rate.in, DAY * rNew * rate.in)) +
      line('cache read', tok(rCached), pCache, DAY * rCached * pCache) +
      line('output', tok(rOut), rate.out, DAY * rOut * rate.out) +
      '<tr class="total"><td>total</td><td></td>' +
      '<td class="num ex"><b>' + tok(rNew + rCached + rOut) + '</b></td>' +
      '<td class="num"><b>' + usd2(hit.eff * DAY) + '</b></td></tr>' +
      '</tbody></table>' +
      '<div class="detail-q">Example: a heavy 100M-token day, split by your cache and output settings above.</div>' +
      sibHtml +
      '<div class="detail-q">quality: ' + axisLabel() + ' = <b>' + fmtQ(hit.q) + '</b>' +
      ' (coding ' + fmtQ(bm.coding) + ' &middot; agentic ' + fmtQ(bm.agentic) + ' &middot; intelligence ' + fmtQ(bm.intelligence) + ')</div>' +
      '<div class="detail-actions">' +
      // A list-price row offers no Use: routing needs a real provider tag,
      // and one invented from a catalog headline would be a lie. Selecting
      // the row has already requested its real endpoints - the upgrade
      // re-renders this card with the button (ruling 2026-09-11).
      (ep.list ? '' : '<button id="btn-use">' + (cfg === true ? 'Re-configure (replaces existing)' : 'Use this model now') + '</button>') +
      '<button id="btn-page">OpenRouter page</button>' +
      '</div>';
    if (!ep.list) el('btn-use').addEventListener('click', function () {
      // The extension asks Auto-vs-exact-provider routing, then adds the model
      // to the server the selector was opened from (the webview cannot touch
      // settings). The tag is this pair's VERBATIM provider slug - the exact
      // value the request-body provider routing needs.
      vscode.postMessage({ type: 'use', id: m.id, tag: ep.tag, provider: ep.provider, srv: dataSrv });
    });
    // Webviews cannot open external links themselves (sandbox + CSP): the
    // extension must call vscode.env.openExternal, so ask it via message.
    el('btn-page').addEventListener('click', function () {
      vscode.postMessage({ type: 'open', url: page });
    });
  }

  // What a list-price/bare detail card says about the lazy provider fetch
  // (ruling 2026-09-11: selecting a list row asks the extension for its real
  // endpoints; "Use" arrives with them).
  function listStateText(id) {
    var st = endpointState[id];
    if (st === 'pending') return 'loading this model\u2019s provider lists\u2026';
    if (st === 'failed') return 'no usable providers found - list price only, press Refresh to retry';
    return 'catalog list price - selecting a row loads its providers';
  }

  function select(id, tag) {
    selectedKey = id + '\u0000' + tag;
    expanded[id] = true; // the selected pair must be visible: its group opens
    // A list-price row (no provider fan-out ran for it - unscored models and
    // fan-out misses) upgrades on selection: ask the extension for this one
    // model's real endpoints (shared cache, one call). Click, Enter and the
    // arrow keys all arrive through here, so one hook covers every path.
    var mm = null;
    for (var mi = 0; mi < models.length; mi++) {
      if (models[mi].id === id) { mm = models[mi]; break; }
    }
    if (mm && !(mm.endpoints && mm.endpoints.length) && !endpointState[id]) {
      endpointState[id] = 'pending';
      vscode.postMessage({ type: 'endpoints', id: id, srv: dataSrv });
    }
    render(computeRows());
  }

  // Chart-dot click: select AND jump - the next table draw scrolls to the row
  // and lights up every pair at the same effective price.
  function jumpTo(id, tag) {
    jumpKey = id + '\u0000' + tag;
    select(id, tag);
  }

  // ── Render orchestration ─────────────────────────────────────
  function render(rows) {
    // The search is a highlight, not a filter: the chart gets EVERY row
    // (non-matches dimmed), the table and the legend get only the matches.
    var shown = rows.filter(function (r) { return r.hit; });
    drawChart(rows);
    drawTable(shown);
    drawDetail(rows);
    el('v-cache').textContent = parseFloat(inputs.cache.value).toFixed(1) + '%';
    el('v-out').textContent = parseFloat(inputs.out.value).toFixed(2) + '% of prompt';
    el('v-wc').textContent = parseFloat(inputs.wc.value).toFixed(2);
    el('v-wa').textContent = parseFloat(inputs.wa.value).toFixed(2);
    el('v-wi').textContent = parseFloat(inputs.wi.value).toFixed(2);
    var showW = inputs.axis.value === 'blend';
    el('w-c').hidden = !showW;
    el('w-a').hidden = !showW;
    el('w-i').hidden = !showW;
    // Legend only when there is something to explain: the marks exist per
    // configured set, and an empty set would leave orphan symbols here.
    var here = false, other = false, ci;
    for (ci = 0; ci < configured.length; ci++) {
      if (configured[ci].elsewhere) other = true; else here = true;
    }
    var leg = '';
    if (here) leg += '<span class="cfg-mark">&#x2713;</span> configured on this server (using it again overwrites) &nbsp;&nbsp;';
    if (other) leg += '<span class="cfg-mark-other">&#9671;</span> configured on another entry with the same URL';
    var seenIds = {}, multi = false, ri2;
    for (ri2 = 0; ri2 < shown.length; ri2++) {
      if (seenIds[shown[ri2].m.id]) { multi = true; break; }
      seenIds[shown[ri2].m.id] = 1;
    }
    if (multi) { if (leg) leg += ' &nbsp;&nbsp;'; leg += '<span class="dim">&#9656;</span> model with several providers: click the row to open it, the arrow to toggle'; }
    el('legend').innerHTML = leg;
    el('legend').hidden = leg === '';
  }

  function rerender() {
    if (haveData) render(computeRows());
  }

  function setBanner(text, kind) {
    var b = el('banner');
    if (!text) { b.hidden = true; b.innerHTML = ''; return; }
    b.hidden = false;
    b.className = kind;
    b.textContent = text;
  }

  // ── Data plumbing ────────────────────────────────────────────
  window.addEventListener('message', function (e) {
    var msg = e.data;
    if (!msg) return;
    if (msg.type === 'loading') {
      el('busy').hidden = false;
      el('stamp').textContent = 'Fetching benchmarks, catalog and provider lists…';
      return;
    }
    if (msg.type === 'configured') {
      // Live mark update after a save through "Use this model now".
      configured = msg.configured || [];
      rerender();
      return;
    }
    if (msg.type === 'endpoints') {
      // Lazy provider list for one list-price row. A response that raced a
      // server switch (srv no longer the visible data) is discarded.
      if (msg.srv !== dataSrv) return;
      var um = null;
      for (var ui = 0; ui < models.length; ui++) {
        if (models[ui].id === msg.id) { um = models[ui]; break; }
      }
      if (!um || (um.endpoints && um.endpoints.length)) return; // stale or already upgraded
      if (msg.endpoints && msg.endpoints.length > 0) {
        um.endpoints = msg.endpoints;
        endpointState[msg.id] = 'done';
        // The list pseudo-row is gone - keep the selection alive by moving
        // it to the model's cheapest real pair (the group leader).
        if (selectedKey === msg.id + '\u0000') {
          var ps = parseInt(inputs.prompt.value, 10);
          var best = msg.endpoints[0], bestE = Infinity;
          msg.endpoints.forEach(function (ep) {
            var e = effPerMillion(ep, ps, cfgPolicy(msg.id, ep.tag, ep, ps));
            if (e < bestE) { bestE = e; best = ep; }
          });
          selectedKey = msg.id + '\u0000' + best.tag;
        }
      } else {
        endpointState[msg.id] = 'failed';
      }
      rerender();
      return;
    }
    if (msg.type !== 'data') return;
    // Every data branch below (success or error banner) ends the wait.
    el('busy').hidden = true;

    var bmError = msg.bmError;
    if (bmError) {
      // Benchmarks define the universe - without them there is no chart.
      // Wipe everything interactive: stale rows under an error banner left a
      // live "Use this model now" pointing at data the refresh just failed to
      // confirm (and on a first failure, "Fetching…" had never been replaced).
      noDataMsg = 'No data loaded - fix the problem above and press Refresh.';
      models = []; selectedKey = null; jumpKey = null; endpointState = {};
      drawChart([]); drawTable([]); drawDetail([]);
      setBanner(bmError, 'error');
      el('stamp').textContent = 'no data';
      return;
    }
    if (msg.catalogError) {
      noDataMsg = 'No data loaded - fix the problem above and press Refresh.';
      models = []; selectedKey = null; jumpKey = null; endpointState = {};
      drawChart([]); drawTable([]); drawDetail([]);
      setBanner('Catalog fetch failed: ' + msg.catalogError, 'error');
      el('stamp').textContent = 'no data';
      return;
    }
    noDataMsg = null;
    dataSrv = msg.srv || null;
    models = msg.models || [];
    endpointState = {}; // fresh row set (refresh or server switch): rows may re-request
    configured = msg.configured || [];
    var bmBySlug = {};
    (msg.bm || []).forEach(function (b) { bmBySlug[b.slug] = b; });
    models.forEach(function (m) { m.bm = bmBySlug[m.base]; });
    if (msg.profile) profile = msg.profile;

    if (msg.citation) el('citation').textContent = msg.citation;
    var providers = 0;
    models.forEach(function (m) { providers += (m.endpoints || []).length; });
    if (models.length === 0) {
      setBanner('The OpenRouter catalog returned no text model - open the Output panel and try Refresh.', 'warn');
    } else {
      setBanner(null);
    }
    var listed = 0;
    models.forEach(function (m) { if ((m.endpoints || []).length > 0) listed++; });
    el('stamp').textContent = models.length + ' models listed, ' + listed +
      ' with provider lists, ' + providers +
      ' priced providers' + (msg.asOf ? ', scores as of ' + msg.asOf : '');

    // Prefill the profile sliders ONCE from the calibrated usage data; never
    // stomp manual slider moves on a later refresh.
    if (!haveData) {
      inputs.cache.value = (profile.rCached * 100).toFixed(1);
      inputs.out.value = (profile.rOut * 100).toFixed(2);
      haveData = true;
    }
    rerender();
  });

  // ── Control wiring ───────────────────────────────────────────
  [inputs.cache, inputs.out, inputs.axis, inputs.ctx, inputs.prompt, inputs.free, inputs.batch, inputs.wc, inputs.wa, inputs.wi].forEach(function (node) {
    node.addEventListener('input', rerender);
    node.addEventListener('change', rerender);
  });
  inputs.q.addEventListener('input', rerender);
  // Enter in the search box = quickpick commit: select the top match (the
  // table's first row - best quality, cheapest tie-break). The chart halo,
  // the scroll and the detail card all follow the selection.
  inputs.q.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || !haveData) return;
    var hits = sortRows(computeRows().filter(function (r) { return r.hit; }));
    if (hits.length > 0) jumpTo(hits[0].m.id, hits[0].ep.tag);
  });
  el('btn-refresh').addEventListener('click', function () { vscode.postMessage({ type: 'refresh' }); });

  // Header modals: disclaimer (!) and calculation help (?). Dialog semantics
  // live in the markup (role=dialog, aria-modal, labelled heading); here the
  // focus moves into the dialog on open and back to its opener button on
  // close, so a keyboard user is never dropped behind an inert backdrop.
  var modalReturnFocus = null;
  function openModal(id, trigger) {
    modalReturnFocus = trigger;
    el(id).hidden = false;
    var closer = el(id === 'modal' ? 'modal-close' : 'modal-warn-close');
    if (closer) closer.focus();
  }
  function closeModals() {
    var wasOpen = !el('modal').hidden || !el('modal-warn').hidden;
    el('modal').hidden = true;
    el('modal-warn').hidden = true;
    if (wasOpen && modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
    modalReturnFocus = null;
  }
  el('btn-help').addEventListener('click', function () { openModal('modal', this); });
  el('btn-warn').addEventListener('click', function () { openModal('modal-warn', this); });
  el('modal-close').addEventListener('click', closeModals);
  el('modal-warn-close').addEventListener('click', closeModals);
  ['modal', 'modal-warn'].forEach(function (id) {
    var box = el(id);
    box.addEventListener('click', function (e) {
      if (e.target === box) closeModals();
    });
    // Focus trap while open: Tab from the last focusable wraps to the first
    // (and Shift+Tab backwards), so the keyboard never wanders behind the
    // modal into the inert page beneath it.
    box.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var f = box.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (f.length === 0) return;
      var first = f[0];
      var last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeModals();
  });

  // Keyboard selection: the results box is focusable (tabindex in the
  // markup); Up/Down/Home/End walk the EXACT order the table draws and
  // jumpTo scrolls the row into view. Individual SVG dots stay unfocusable
  // - thousands of tab stops would be worse than none; this box plus the
  // detail card's real buttons is the keyboard path through the feature.
  el('table-wrap').addEventListener('keydown', function (e) {
    if (!haveData) return;
    var sorted = sortRows(computeRows().filter(function (r) { return r.hit; }));
    if (sorted.length === 0) return;
    var idx = -1;
    for (var i = 0; i < sorted.length; i++) {
      if (pairKey(sorted[i]) === selectedKey) { idx = i; break; }
    }
    var next =
      e.key === 'ArrowDown' ? Math.min(idx + 1, sorted.length - 1) :
      e.key === 'ArrowUp' ? (idx < 0 ? 0 : Math.max(0, idx - 1)) :
      e.key === 'Home' ? 0 :
      e.key === 'End' ? sorted.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    jumpTo(sorted[next].m.id, sorted[next].ep.tag);
  });

  // Row click -> select the pair (delegated: the tbody is re-rendered
  // constantly). A group row selects its CHEAPEST provider (which also opens
  // the group, via select); its caret alone toggles without selecting.
  document.querySelector('#tbl tbody').addEventListener('click', function (e) {
    var noClosest = !e.target.closest;
    if (!noClosest) {
      var caret = e.target.closest('tr[data-group] .caret');
      if (caret) {
        var gid = caret.closest('tr[data-group]').getAttribute('data-group');
        expanded[gid] = expanded[gid] !== true;
        render(computeRows());
        return;
      }
      var grpTr = e.target.closest('tr[data-group]');
      if (grpTr) { select(grpTr.getAttribute('data-group'), grpTr.getAttribute('data-lead')); return; }
    }
    var tr = noClosest ? null : e.target.closest('tr[data-id]');
    if (!tr) return;
    select(tr.getAttribute('data-id'), tr.getAttribute('data-tag'));
  });

  // Ready handshake: the extension only posts data after this.
  vscode.postMessage({ type: 'ready' });
})();
