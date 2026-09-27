// analyze.mjs — language-agnostic placement metrics over a canonical function
// call graph (see extract-ts.mjs for the producer side; ANY language adapter
// may produce the same JSON schema). Pure graph math: does not parse source,
// does not know or care what language created the nodes.
//
// usage: node analyze.mjs --graph=graph.json [--tools-dir=src/shared,src/common]
//        [--min-share=0.6] [--min-weight=2] [--min-tool-consumers=4] [--top=40]
//        [--waivers=.tools/structural/waivers.json] [--tsv]
//
// Reports:
//   ZERO_CALLER  node with zero incoming call edges (Judgment 1's == 0 row).
//                Only ref/missing-node evidence: true dynamic reaches are invisible.
//   SINGLE_CALLER  node with exactly one distinct production caller
//                (Judgment 1's == 1 row). Escapes (large/ENTRY/CONTRACT/toolbox)
//                are for the reviewer to rule; the machine only counts.
//   MOVE_GAIN    function whose call weight points mostly at ONE other file
//                (>= min-share of weight, >= min-weight total, >= 1 real call
//                toward the target). extFiles=1 + home 0 = strong move signal;
//                extFiles>=2 with no home use = honest module API, keep.
//   TOOLS        profile of the common-helpers exception: a file under
//                --tools-dir that is stateless, loosely self-coupled
//                (internal edges <= functions) and consumed by
//                >= min-tool-consumers files is a TOOLBOX - cut-heavy by
//                design, general helpers stay. Single-consumer helpers in a
//                toolbox stay NOMINATED: a machine can disprove laziness but
//                can never prove generality; that ruling stays human.
//   SCC_CROSS    strongly connected component (call edges only) spanning
//                >1 file: function ping-pong hiding inside a clean file DAG.
//   MODULARITY   Q of the current file partition vs a deterministic greedy
//                merge reference. DIAGNOSTIC ONLY: a smoke alarm, never a
//                refactoring plan (greedy loves blobby monocultures).
//   CONDUCTANCE  cut/volume per file - conversation-starter, not a verdict;
//                entry-wiring/leaf/toolbox files are cut-heavy BY DESIGN.
//   MODULE_CYCLES / MODULE_ORPHANS  file-level directed cycles and zero-edge
//                files, derived from the same graph (free dep-cruiser-lite).
//   PATCHES      inventory of blind-spot glue edges, by extractor patch kind,
//                so the report can declare exactly what was patched.
//   TIERS        evidence verdict from extractor stats: unresolved-rate and
//                patch-share thresholds decide Tier A vs Tier B mechanically.
//
// Determinism law: same bytes in => same report out. Sorted inputs expected
// (producers must sort); all tie-breaks alphabetical. Verify by running twice
// and diffing.

const argv = process.argv.slice(2);
const argVal = (name, dflt) => {
  const a = argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : dflt;
};
const TSV = argv.includes('--tsv');
const GRAPH = argVal('graph', '.tools/structural/graph.json');
const TOOLS_DIRS = argVal('tools-dir', '').split(',').map((s) => s.trim()).filter(Boolean);
const MIN_SHARE = parseFloat(argVal('min-share', '0.6'));
const MIN_WEIGHT = parseFloat(argVal('min-weight', '2'));
const MIN_TOOL_CONSUMERS = parseInt(argVal('min-tool-consumers', '4'), 10);
const TOP = parseInt(argVal('top', '40'), 10);

const { readFileSync, existsSync } = await import('node:fs');
const graph = JSON.parse(readFileSync(GRAPH, 'utf8'));
const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
const fileMeta = new Map((graph.files ?? []).map((f) => [f.path, f]));
const fileOf = new Map(graph.nodes.map((n) => [n.id, n.file]));

// waivers: {"waive": {"file::name": "reason", ...}, "keep": {...}}
// keyed by node id so they survive positional label churn. 'waive' suppresses
// a candidate into the WAIVED section; 'keep' pins it as human-approved.
const WAIVERS_PATH = argVal('waivers', '');
let WAIVE = new Map();
if (WAIVERS_PATH && existsSync(WAIVERS_PATH)) {
  try {
    const w = JSON.parse(readFileSync(WAIVERS_PATH, 'utf8'));
    for (const [k, v] of Object.entries(w.waive ?? {})) WAIVE.set(k, { ruling: 'waive', reason: String(v) });
    for (const [k, v] of Object.entries(w.keep ?? {})) WAIVE.set(k, { ruling: 'keep', reason: String(v) });
  } catch { console.error(`warning: could not parse waivers file ${WAIVERS_PATH} - ignoring`); }
}

// rebuild the working graph: edgeW/callPair are undirected sums (modularity,
// gain, conductance); dir keeps true call direction (SCC, module cycles);
// patches are undirected low-weight glue and never enter dir.
const edgeW = new Map(); // "a\0b" sorted -> weight
const callPair = new Map(); // "a\0b" sorted -> real-call count (either direction)
const dir = new Map(); // caller -> Set(callee) (calls only)
for (const e of graph.calls ?? []) {
  if (!nodes.has(e.from) || !nodes.has(e.to) || e.from === e.to) continue;
  const k = e.from < e.to ? `${e.from}\u0000${e.to}` : `${e.to}\u0000${e.from}`;
  edgeW.set(k, (edgeW.get(k) ?? 0) + e.w);
  callPair.set(k, (callPair.get(k) ?? 0) + e.w);
  if (!dir.has(e.from)) dir.set(e.from, new Set());
  dir.get(e.from).add(e.to);
}
for (const e of graph.patches ?? []) {
  if (!nodes.has(e.a) || !nodes.has(e.b) || e.a === e.b) continue;
  const k = e.a < e.b ? `${e.a}\u0000${e.b}` : `${e.b}\u0000${e.a}`;
  edgeW.set(k, (edgeW.get(k) ?? 0) + e.w);
}

let twoM = 0;
const deg = new Map();
for (const [k, w] of edgeW) {
  const [a, b] = k.split('\u0000');
  deg.set(a, (deg.get(a) ?? 0) + w);
  deg.set(b, (deg.get(b) ?? 0) + w);
  twoM += w;
}
if (twoM === 0) throw new Error('graph has no edges; nothing to analyze');

const fInt = new Map();
const fExt = new Map();
for (const [k, w] of edgeW) {
  const [a, b] = k.split('\u0000');
  const fa = fileOf.get(a), fb = fileOf.get(b);
  const kk = fa === fb ? fa : (fa < fb ? `${fa}\u0000${fb}` : `${fb}\u0000${fa}`);
  if (fa === fb) fInt.set(kk, (fInt.get(kk) ?? 0) + w);
  else fExt.set(kk, (fExt.get(kk) ?? 0) + w);
}

// ---------- TOOLS profile ----------
const toolsStats = [];
const toolsSet = new Set();
for (const [path, meta] of [...fileMeta].sort((a, b) => a[0].localeCompare(b[0]))) {
  if (!TOOLS_DIRS.some((d) => path.startsWith(d))) continue;
  const fns = graph.nodes.filter((n) => n.file === path).length;
  if (fns < 3) continue;
  const internal = fInt.get(path) ?? 0;
  const consumers = new Set();
  for (const [k] of fExt) {
    const [a, b] = k.split('\u0000');
    if (a === path) consumers.add(b); else if (b === path) consumers.add(a);
  }
  const shapeOk = !meta.mutable && internal <= fns;
  const qualified = shapeOk && consumers.size >= MIN_TOOL_CONSUMERS;
  toolsStats.push({ path, fns, internal, consumers: consumers.size, mutable: !!meta.mutable, qualified });
  if (qualified) toolsSet.add(path);
}

// ---------- MOVE_GAIN ----------
const gains = [];
let toolsSkipped = 0;
for (const [key, n] of [...nodes].sort((a, b) => a[0].localeCompare(b[0]))) {
  let home = 0;
  const ext = new Map();
  for (const [k, w] of edgeW) {
    const [a, b] = k.split('\u0000');
    let other = null;
    if (a === key) other = b; else if (b === key) other = a; else continue;
    const of = fileOf.get(other);
    if (of === n.file) home += w; else ext.set(of, (ext.get(of) ?? 0) + w);
  }
  const total = home + [...ext.values()].reduce((s, v) => s + v, 0);
  if (total < MIN_WEIGHT || ext.size === 0) continue;
  const [tf, tw] = [...ext.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
  let realToTarget = 0;
  for (const [k, c] of callPair) {
    const [a, b] = k.split('\u0000');
    if ((a === key && fileOf.get(b) === tf) || (b === key && fileOf.get(a) === tf)) realToTarget += c;
  }
  if (realToTarget < 1) continue;
  if (tw / total >= MIN_SHARE && tw > home) {
    if (toolsSet.has(n.file) && ext.size >= 2) { toolsSkipped++; continue; }
    gains.push({ n, home, tf, tw, total, extFiles: ext.size, toolsHome: toolsSet.has(n.file) });
  }
}
gains.sort((a, b) => (b.tw / b.total) - (a.tw / a.total) || a.n.id.localeCompare(b.n.id));

// ---------- CALLER CENSUS (Judgment 1 evidence) ----------
// Distinct incoming call edges per node, from REAL calls only. Patch edges
// (message pairs, shared imports, reference glue) never count as callers;
// they are listed separately so zero-caller nodes can be checked against them.
const inCallers = new Map(); // id -> Set(caller ids)
for (const e of graph.calls ?? []) {
  if (!nodes.has(e.from) || !nodes.has(e.to) || e.from === e.to) continue;
  if (!inCallers.has(e.to)) inCallers.set(e.to, new Set());
  inCallers.get(e.to).add(e.from);
}
const patchPartners = new Map(); // id -> Set(ids)
for (const e of graph.patches ?? []) {
  if (!nodes.has(e.a) || !nodes.has(e.b)) continue;
  if (!patchPartners.has(e.a)) patchPartners.set(e.a, new Set());
  patchPartners.get(e.a).add(e.b);
  if (!patchPartners.has(e.b)) patchPartners.set(e.b, new Set());
  patchPartners.get(e.b).add(e.a);
}
const zeroCaller = [];
const singleCaller = [];
for (const id of [...nodes.keys()].sort()) {
  const n = inCallers.get(id)?.size ?? 0;
  if (n === 0) zeroCaller.push({ id, patched: patchPartners.get(id)?.size ?? 0 });
  else if (n === 1) singleCaller.push({ id, caller: [...inCallers.get(id)][0], patched: patchPartners.get(id)?.size ?? 0 });
}
// waivers split candidates into active findings vs ruled-on items
const waivedHits = [];
const applyWaivers = (list) => list.filter((c) => {
  const w = WAIVE.get(c.id);
  if (w) { waivedHits.push({ id: c.id, ...w }); return false; }
  return true;
});
const zeroActive = applyWaivers(zeroCaller);
const singleActive = applyWaivers(singleCaller);
const gainsActive = gains.filter((g) => !WAIVE.has(g.n.id));
for (const g of gains) if (WAIVE.has(g.n.id)) waivedHits.push({ id: g.n.id, ...WAIVE.get(g.n.id) });

// ---------- EVIDENCE TIER verdict ----------
const stats = graph.meta?.stats ?? {};
const callPairs = (graph.calls ?? []).length;
const patchPairs = (graph.patches ?? []).length;
const unresolved = stats.unresolved ?? 0;
const resolvedCalls = stats.call ?? callPairs;
const unresolvedRate = resolvedCalls + unresolved > 0 ? unresolved / (resolvedCalls + unresolved) : 0;
const patchShare = callPairs + patchPairs > 0 ? patchPairs / (callPairs + patchPairs) : 0;
const tier = unresolvedRate > 0.25 || patchShare > 0.35 ? 'B' : 'A';
const tierReasons = [
  `unresolved-rate ${(unresolvedRate * 100).toFixed(1)}% (${unresolved} unresolved vs ${resolvedCalls} resolved calls)`,
  `patch-share ${(patchShare * 100).toFixed(1)}% (${patchPairs} patch pairs vs ${callPairs} call pairs)`,
];

// ---------- SCC (iterative Tarjan over true call direction) ----------
const adj = dir;
const index = new Map(); const low = new Map(); const onStack = new Set(); const stack = []; const sccs = [];
let counter = 0;
const allKeys = [...nodes.keys()].sort();
for (const root of allKeys) {
  if (index.has(root)) continue;
  const work = [[root, 0]];
  const childLists = new Map();
  while (work.length) {
    const frame = work[work.length - 1];
    const [v, ci] = frame;
    if (ci === 0) {
      index.set(v, counter); low.set(v, counter++); stack.push(v); onStack.add(v);
      childLists.set(v, [...(adj.get(v) ?? [])].sort());
    }
    const kids = childLists.get(v);
    let pushed = false;
    for (let i = ci; i < kids.length; i++) {
      const w = kids[i];
      frame[1] = i + 1;
      if (!index.has(w)) { work.push([w, 0]); pushed = true; break; }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (pushed) continue;
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) sccs.push(comp);
    }
    work.pop();
    if (work.length) {
      const parent = work[work.length - 1][0];
      low.set(parent, Math.min(low.get(parent), low.get(v)));
    }
  }
}
const crossSccs = sccs.filter((c) => new Set(c.map((k) => fileOf.get(k))).size > 1)
  .sort((a, b) => a[0].localeCompare(b[0]));

// ---------- MODULARITY + deterministic greedy reference ----------
function modularity(communityOf) {
  let q = 0;
  const sumIn = new Map(); const sumTot = new Map();
  const seen = new Set();
  for (const [k] of edgeW) {
    const [a, b] = k.split('\u0000');
    for (const nd of [a, b]) {
      if (seen.has(nd)) continue;
      seen.add(nd);
      const c = communityOf(nd);
      sumTot.set(c, (sumTot.get(c) ?? 0) + (deg.get(nd) ?? 0));
    }
  }
  for (const [k, w] of edgeW) {
    const [a, b] = k.split('\u0000');
    if (communityOf(a) === communityOf(b)) sumIn.set(communityOf(a), (sumIn.get(communityOf(a)) ?? 0) + 2 * w);
  }
  for (const c of sumTot.keys()) {
    const ein = sumIn.get(c) ?? 0, etot = sumTot.get(c);
    q += ein / twoM - (etot / twoM) ** 2;
  }
  return q;
}
const Q_now = modularity((k) => fileOf.get(k));
const comm = new Map(); for (const k of nodes.keys()) comm.set(k, k);
const cDeg = new Map(deg);
const pairs = edgeW;
function find(c) { let x = c; while (comm.get(x) !== x) x = comm.get(x); return x; }
function curDeg(c) { return cDeg.get(c) ?? 0; }
function pairWeight(a, b) {
  let s = 0;
  for (const [k, w] of pairs) {
    const [u, v] = k.split('\u0000');
    if ((find(u) === a && find(v) === b) || (find(u) === b && find(v) === a)) s += w;
  }
  return s;
}
function merge(a, b) { comm.set(b, a); cDeg.set(a, curDeg(a) + curDeg(b)); cDeg.delete(b); }
for (let pass = 0; pass < 8; pass++) {
  let merged = false;
  for (const kk of [...pairs.keys()].sort()) {
    const [x, y] = kk.split('\u0000').map((c) => find(c));
    if (x === y) continue;
    const w = pairWeight(x, y);
    if (w <= 0) continue;
    if (w - (curDeg(x) * curDeg(y)) / twoM > 1e-9) { merge(x, y); merged = true; }
  }
  if (!merged) break;
}
const Q_greedy = (() => { try { return modularity((k) => find(comm.get(k) ?? k)); } catch { return NaN; } })();

// ---------- CONDUCTANCE ----------
const fnCount = new Map();
for (const n of nodes.values()) fnCount.set(n.file, (fnCount.get(n.file) ?? 0) + 1);
const cond = [];
for (const f of [...fnCount.keys()].sort()) {
  if ((fnCount.get(f) ?? 0) < 3) continue;
  const internal = fInt.get(f) ?? 0;
  let cut = 0;
  for (const [k, w] of fExt) { const [a, b] = k.split('\u0000'); if (a === f || b === f) cut += w; }
  const vol = 2 * internal + cut;
  if (vol > 0) cond.push({ f, phi: cut / vol, internal, cut, fns: fnCount.get(f) });
}
cond.sort((a, b) => b.phi - a.phi || a.f.localeCompare(b.f));

// ---------- module-level cycles + orphans (dep-cruiser-lite, call direction) ----------
const modDir = new Map();
for (const [a, set] of dir) {
  const fa = fileOf.get(a);
  for (const b of set) {
    const fb = fileOf.get(b);
    if (fa === fb) continue;
    if (!modDir.has(fa)) modDir.set(fa, new Set());
    modDir.get(fa).add(fb);
  }
}
const mIndex = new Map(); const mLow = new Map(); const mStack = []; const mOn = new Set(); const mSccs = [];
let mCounter = 0;
for (const root of [...new Set([...modDir.keys(), ...[...modDir.values()].flatMap((s) => [...s])])].sort()) {
  if (mIndex.has(root)) continue;
  const work = [[root, 0]];
  const kidsMap = new Map();
  while (work.length) {
    const fr = work[work.length - 1];
    const [v, ci] = fr;
    if (ci === 0) {
      mIndex.set(v, mCounter); mLow.set(v, mCounter++); mStack.push(v); mOn.add(v);
      kidsMap.set(v, [...(modDir.get(v) ?? [])].sort());
    }
    const kids = kidsMap.get(v);
    let pushed = false;
    for (let i = ci; i < kids.length; i++) {
      const w = kids[i];
      fr[1] = i + 1;
      if (!mIndex.has(w)) { work.push([w, 0]); pushed = true; break; }
      else if (mOn.has(w)) mLow.set(v, Math.min(mLow.get(v), mIndex.get(w)));
    }
    if (pushed) continue;
    if (mLow.get(v) === mIndex.get(v)) {
      const comp = [];
      let w;
      do { w = mStack.pop(); mOn.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) mSccs.push(comp.sort());
    }
    work.pop();
    if (work.length) {
      const p = work[work.length - 1][0];
      mLow.set(p, Math.min(mLow.get(p), mLow.get(v)));
    }
  }
}
const touched = new Set();
for (const [k] of edgeW) { const [a, b] = k.split('\u0000'); touched.add(fileOf.get(a)); touched.add(fileOf.get(b)); }
const orphans = [...fnCount.keys()].filter((f) => !touched.has(f) && (fnCount.get(f) ?? 0) > 0).sort();

// ---------- PATCHES inventory ----------
const patchKinds = new Map();
for (const e of graph.patches ?? []) {
  const k = `w=${e.w}`;
  patchKinds.set(k, (patchKinds.get(k) ?? 0) + 1);
}

// ---------- report ----------
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(3) : String(x));
if (TSV) {
  const rows = [];
  for (const c of zeroActive.slice(0, TOP)) rows.push(['ZERO_CALLER', c.id, `patched=${c.patched}`].join('\t'));
  for (const c of singleActive.slice(0, TOP)) rows.push(['SINGLE_CALLER', c.id, `caller=${c.caller}`, `patched=${c.patched}`].join('\t'));
  for (const g of gainsActive.slice(0, TOP)) rows.push(['MOVE_GAIN', g.n.id, `${g.home}`, `extFiles=${g.extFiles}`, `${g.tf}=${g.tw}`, fmt(g.tw / g.total)].join('\t'));
  for (const t of toolsStats) if (t.qualified) rows.push(['TOOLS', t.path, `fns=${t.fns}`, `consumers=${t.consumers}`, `internal=${t.internal}`].join('\t'));
  for (const c of crossSccs) rows.push(['SCC_CROSS', [...new Set(c.map((k) => fileOf.get(k)))].sort().join(','), c.length].join('\t'));
  for (const c of cond.slice(0, TOP)) rows.push(['CONDUCTANCE', c.f, fmt(c.phi), `cut=${c.cut}`, `fns=${c.fns}`].join('\t'));
  for (const c of mSccs) rows.push(['MODULE_CYCLE', c.join(',')].join('\t'));
  for (const o of orphans) rows.push(['MODULE_ORPHAN', o].join('\t'));
  for (const w of waivedHits) rows.push(['WAIVED', w.id, w.ruling, w.reason].join('\t'));
  rows.push(['MODULARITY', `Q_now=${fmt(Q_now)}`, `Q_greedy=${fmt(Q_greedy)}`, `dQ=${fmt(Q_greedy - Q_now)}`].join('\t'));
  rows.push(['TIER', tier, ...tierReasons].join('\t'));
  process.stdout.write(rows.join('\n') + '\n');
} else {
  console.log(`analyze: ${nodes.size} nodes, ${edgeW.size} edge pairs (${callPairs} call pairs, ${patchPairs} patch pairs), twoM=${fmt(twoM)} (extractor: ${graph.meta?.extractor ?? '?'}, project: ${graph.meta?.project ?? '?'})`);
  console.log(`EVIDENCE TIER: ${tier} (${tierReasons.join('; ')})${tier === 'B' ? '  -> findings are HINTS until the edges they rest on are hand-verified' : ''}`);
  console.log('Reading guide: MOVE_GAIN extFiles=1 + home 0 = move candidate; extFiles>=2 with no home use = honest API, keep.');
  console.log(`TOOLS exception: files under [${TOOLS_DIRS.join(', ') || '(none configured)'}] that are stateless, loosely self-coupled and have >= ${MIN_TOOL_CONSUMERS} consumer files are toolboxes: cut-heavy by design, general helpers stay (single-consumer helpers stay nominated - generality is a human ruling).`);
  console.log('');
  console.log(`ZERO_CALLER nodes (no incoming call edges; check ENTRY/CONTRACT/dynamic escapes before proposing deletion): ${zeroActive.length}${zeroCaller.length !== zeroActive.length ? ` (${zeroCaller.length - zeroActive.length} waived)` : ''}`);
  for (const c of zeroActive.slice(0, TOP)) console.log(`  ${c.id}${c.patched ? `  (${c.patched} patch edge(s) - dynamically reached?)` : ''}`);
  console.log('');
  console.log(`SINGLE_CALLER nodes (one distinct caller; absorb unless an escape applies): ${singleActive.length}${singleCaller.length !== singleActive.length ? ` (${singleCaller.length - singleActive.length} waived)` : ''}`);
  for (const c of singleActive.slice(0, TOP)) console.log(`  ${c.id}  <- ${c.caller}${c.patched ? `  (+${c.patched} patch)` : ''}`);
  console.log('');
  console.log(`MOVE_GAIN candidates (share >= ${MIN_SHARE}, weight >= ${MIN_WEIGHT}): ${gainsActive.length}${toolsSkipped ? `  (${toolsSkipped} toolbox helpers exempted: generality proven)` : ''}${gains.length !== gainsActive.length ? `  (${gains.length - gainsActive.length} waived)` : ''}`);
  for (const g of gainsActive.slice(0, TOP)) console.log(`  ${(g.tw / g.total).toFixed(2)}  ${g.n.id}  [home ${g.home}, ${g.extFiles} ext file(s)] -> ${g.tf} [${g.tw}]${g.toolsHome ? '  (TOOLS home: rule generality)' : ''}`);
  console.log('');
  console.log('TOOLS profile (stateless, internal <= fns, consumers >= ' + MIN_TOOL_CONSUMERS + '):');
  for (const t of toolsStats) console.log(`  ${t.qualified ? '[TOOLS]   ' : '[not yet] '}${t.path}  (${t.fns} fns, ${t.consumers} consumer file(s), internal ${t.internal}${t.mutable ? ', HAS MODULE STATE' : ''})`);
  if (!toolsStats.length) console.log('  (no candidate files under --tools-dir)');
  console.log('');
  console.log(`CROSS-FILE SCCs: ${crossSccs.length}`);
  for (const c of crossSccs) console.log(`  files: ${[...new Set(c.map((k) => fileOf.get(k)))].sort().join(', ')}\n    ${c.sort().join('\n    ')}`);
  console.log('');
  console.log(`MODULARITY: Q(current files) ${fmt(Q_now)}  Q(greedy reference) ${fmt(Q_greedy)}  dQ ${fmt(Q_greedy - Q_now)}  (diagnostic only)`);
  console.log('');
  console.log(`CONDUCTANCE (top ${Math.min(TOP, cond.length)}, files with >= 3 functions):`);
  for (const c of cond.slice(0, TOP)) console.log(`  ${fmt(c.phi)}  ${c.f}  (cut ${c.cut} / vol ${2 * c.internal + c.cut}, ${c.fns} fns)${toolsSet.has(c.f) ? ' [TOOLS - cut-heavy by design]' : ''}`);
  console.log('');
  console.log(`MODULE_CYCLES (directed, call edges): ${mSccs.length}`);
  for (const c of mSccs) console.log(`  ${c.join(', ')}`);
  console.log(`MODULE_ORPHANS (zero graph edges): ${orphans.length}`);
  for (const o of orphans) console.log(`  ${o}`);
  console.log('');
  console.log(`PATCHES applied (blind-spot glue by weight; w=0.5 message pairs, w=0.25 shared imports / reference glue): ${patchPairs} total`);
  for (const [k, v] of [...patchKinds].sort()) console.log(`  ${k}: ${v}`);
  if (waivedHits.length) {
    console.log('');
    console.log(`WAIVED by waivers file (${waivedHits.length}):`);
    for (const w of waivedHits) console.log(`  [${w.ruling}] ${w.id}  - ${w.reason}`);
  }
}
