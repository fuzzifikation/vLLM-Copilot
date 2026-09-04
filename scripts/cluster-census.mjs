// cluster-census.mjs — pass 3 of the structural law: does each function live
// in the RIGHT file? (rent asks "should it exist", dep:check asks "may this
// file import that"; nothing until now asked "is this function standing in the
// wrong room"). Method: build the function call graph (TypeScript compiler
// API, deterministic), attribute nodes to files, then measure file placement:
//
//   MOVE_GAIN      function whose call weight points mostly at ONE other file
//                  (>= --min-share of its weight, >= --min-weight total)
//   SCC_CROSS      strongly connected function component spanning >1 file
//                  (dep:check only sees file-level cycles; this sees the
//                  ping-pong hiding inside a clean file DAG)
//   MODULARITY     Q of the current file partition vs a deterministic greedy
//                  merge reference (diagnostic: a big positive dQ means the
//                  files do not match the graph; the number is a smoke alarm,
//                  never a refactoring plan)
//   CONDUCTANCE    per-file cut/(volume) - the "least outside surface" number
//   TOOLS          src/shared/ toolbox profile: stateless + loosely
//                  self-coupled + >= 4 consumer files => cut-heavy by design;
//                  general helpers inside stay put (common-helpers exception,
//                  user ruling 2026-09-04; see the TOOLS block for the law)
//
// Blind-spot patches (user ruling 2026-09-04, edges the call graph cannot see):
//   webview message pair   TS <-> resources/*.js share message-type string
//                          literals; weight 0.5 edge to a per-JS-file pseudo-node
//   shared imports         two functions importing the SAME module symbol get a
//                          0.25 edge (skips >--hub fan-out symbols so wire types
//                          cannot fake a merge-everything attractor)
// Interface call targets resolve to the single implementing class member when
// exactly one exists (the DI seam, e.g. ProviderClient -> VllmClient);
// otherwise the edge is dropped and counted, never guessed.
//
// Tests are NOT customers (doctrine): the graph is production-only (src/**).
// Determinism: sorted traversals everywhere; greedy merge tie-breaks on
// alphabetical order; same bytes in => same report out. --tsv for diffs.
// Knobs: --min-share=0.6 --min-weight=2 --hub=15 --top=40

import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const argVal = (name, dflt) => {
  const a = argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : dflt;
};
const TSV = argv.includes('--tsv');
const MIN_SHARE = parseFloat(argVal('min-share', '0.6'));
const MIN_WEIGHT = parseFloat(argVal('min-weight', '2'));
const HUB = parseInt(argVal('hub', '15'), 10);
const TOP = parseInt(argVal('top', '40'), 10);

const cwd = process.cwd();
const norm = (f) => f.split(path.sep).join('/').replaceAll('\\', '/');
const rel = (f) => norm(path.relative(cwd, f));

function parsedConfig(p) {
  return ts.getParsedCommandLineOfConfigFile(p, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} });
}
const srcCfg = parsedConfig('tsconfig.json');
const testCfg = parsedConfig('test/tsconfig.json');
if (!srcCfg) throw new Error('cannot parse tsconfig.json');
const rootNames = [...new Set([...srcCfg.fileNames, ...(testCfg ? testCfg.fileNames : [])].map((f) => norm(f)))];
const program = ts.createProgram(rootNames, srcCfg.options);
const checker = program.getTypeChecker();
const prodFile = (sf) => sf && !sf.isDeclarationFile && rel(sf.fileName).startsWith('src/');

// ---------- nodes: named functions/methods in src/** ----------
const nodes = new Map(); // key "file::name" -> { key, file, name, line }
const byName = new Map(); // name -> [keys] (resolution fallback when symbol fails)
function addNode(sf, name, declNode) {
  const file = rel(sf.fileName);
  const key = `${file}::${name}`;
  if (nodes.has(key)) return key; // duplicate name in file (overloads): first wins
  const { line } = sf.getLineAndCharacterOfPosition(declNode.getStart());
  nodes.set(key, { key, file, name, line: line + 1 });
  if (!byName.has(name)) byName.set(name, []);
  byName.get(name).push(key);
  return key;
}
function funcNameOf(decl, sf) {
  if (ts.isFunctionDeclaration(decl) && decl.name) return decl.name.text;
  if (ts.isClassDeclaration(decl) && decl.name) return `${decl.name.text}#ctor`;
  if (ts.isMethodDeclaration(decl) && decl.name) {
    const cls = decl.parent;
    const cname = cls && ts.isClassDeclaration(cls) && cls.name ? cls.name.text : '(anon)';
    return `${cname}#${decl.name.getText()}`;
  }
  if (ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name)) {
    const init = decl.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return decl.name.text;
  }
  return null;
}
const files = program.getSourceFiles()
  .filter(prodFile)
  .sort((a, b) => rel(a.fileName).localeCompare(rel(b.fileName)));
for (const sf of files) {
  const visit = (n) => {
    const nm = funcNameOf(n, sf);
    if (nm) addNode(sf, nm, n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

// ---------- edge collection ----------
const edgeW = new Map(); // "a\u0000b" sorted -> weight (undirected, for modularity/gain)
const callW = new Map(); // "a\u0000b" sorted -> RAW call-edge count (calibration gate)
const dirEdges = new Map(); // a -> Set(b) (for SCC)
const stats = { call: 0, callSame: 0, patchedWebview: 0, patchedShared: 0, droppedInterface: 0, unresolved: 0 };
function addUndirected(a, b, w) {
  if (a === b) return;
  const k = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
  edgeW.set(k, (edgeW.get(k) ?? 0) + w);
}
function addDirected(a, b) {
  if (a === b) return;
  if (!dirEdges.has(a)) dirEdges.set(a, new Set());
  dirEdges.get(a).add(b);
}
function keyForSymbol(sym) {
  if (!sym) return null;
  if (sym.flags & ts.SymbolFlags.Alias) {
    const aliased = checker.getAliasedSymbol(sym);
    return aliased ? keyForSymbol(aliased) : null;
  }
  for (const d of sym.declarations ?? []) {
    const sf = d.getSourceFile();
    if (prodFile(sf)) {
      const nm = funcNameOf(d, sf);
      if (nm) return `${rel(sf.fileName)}::${nm}`;
      // declared inside a prod function's scope or a class body we didn't key:
      if (nodes.has(`${rel(sf.fileName)}::${sym.name}`)) return `${rel(sf.fileName)}::${sym.name}`;
      return null;
    }
    // Interface/type member in prod? handled by caller (implementation retarget)
    if (sf && rel(sf.fileName).startsWith('src/')) return `__interface__::${sym.name}`;
  }
  return null; // libs, vscode, test files: outside the production graph
}
// interface member -> sole implementing class member (DI seam), else null
const implCache = new Map();
function retargetInterface(memberName) {
  if (implCache.has(memberName)) return implCache.get(memberName);
  const hits = [];
  for (const [key, n] of nodes) {
    const m = n.name.match(/^(\w+)#(.+)$/);
    if (m && m[2] === memberName) hits.push(key);
  }
  const r = hits.length === 1 ? hits[0] : null;
  implCache.set(memberName, r);
  return r;
}
for (const sf of files) {
  const enclosingKey = (n) => {
    for (let x = n; x; x = x.parent) {
      const nm = funcNameOf(x, sf);
      if (nm) return `${rel(sf.fileName)}::${nm}`;
    }
    return null;
  };
  const visit = (n) => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const src = enclosingKey(n);
      if (src && nodes.has(src)) {
        const callee = ts.isNewExpression(n) ? n.expression : n.expression;
        let sym = callee ? checker.getSymbolAtLocation(callee) : null;
        let target = keyForSymbol(sym);
        if (target === '__interface__::' + sym?.name) {
          const r = retargetInterface(sym.name);
          if (r) target = r;
          else { target = null; stats.droppedInterface++; }
        }
        if (target && nodes.has(target)) {
          addUndirected(src, target, 1);
          const ck = src < target ? `${src}\u0000${target}` : `${target}\u0000${src}`;
          callW.set(ck, (callW.get(ck) ?? 0) + 1);
          addDirected(src, target);
          stats.call++;
          if (nodes.get(src).file === nodes.get(target).file) stats.callSame++;
        } else if (!target) {
          stats.unresolved++;
          // fallback: sole production namer of this identifier
          const name = callee && ts.isIdentifier(callee) ? callee.text : null;
          if (name && byName.get(name)?.length === 1) {
            const t = byName.get(name)[0];
            if (t !== src) {
              addUndirected(src, t, 1);
              const ck = src < t ? `${src}\u0000${t}` : `${t}\u0000${src}`;
              callW.set(ck, (callW.get(ck) ?? 0) + 1);
              addDirected(src, t);
              stats.call++;
            }
          }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

// ---------- blind spot 1: webview message pairs (weight 0.5) ----------
const TYPE_RE = /(?:case\s+|type\s*[:=]==?\s*)['"]([\w./-]+)['"]/g;
const jsFiles = readdirSync('resources').filter((f) => f.endsWith('.js')).sort();
for (const jf of jsFiles) {
  const jsText = readFileSync(path.join('resources', jf), 'utf8');
  const jsTypes = new Set([...jsText.matchAll(TYPE_RE)].map((m) => m[1]));
  const pseudo = `resources/${jf}::__handler__`;
  const partners = new Map(); // ts function key -> shared type count
  for (const sf of files) {
    const text = sf.getFullText();
    const tsTypes = new Set([...text.matchAll(TYPE_RE)].map((m) => m[1]));
    let hit = false;
    for (const t of tsTypes) if (jsTypes.has(t)) { hit = true; break; }
    if (!hit) continue;
    // attribute to every keyed function in the view file that mentions any shared type
    const shared = new Set([...tsTypes].filter((t) => jsTypes.has(t)));
    const visit = (n) => {
      const nm = funcNameOf(n, sf);
      if (nm) {
        const key = `${rel(sf.fileName)}::${nm}`;
        const body = n.getFullText();
        for (const t of shared) if (body.includes(`'${t}'`) || body.includes(`"${t}"`) || body.includes(`\`${t}\``)) {
          partners.set(key, (partners.get(key) ?? 0) + 1);
          break;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  if (partners.size === 0 && jsTypes.size > 0) {
    // file-level pair edge as last resort: view TS file <-> js pseudo node
    const guess = `src/ui/${jf.replace(/\.js$/, 'View.ts')}::__view__`;
    if (jsTypes.size) { nodes.set(pseudo, { key: pseudo, file: `resources/${jf}`, name: '(webview)', line: 0 }); partners.set(guess, 1); }
  }
  for (const [k] of partners) {
    if (!nodes.has(k)) continue;
    if (!nodes.has(pseudo)) nodes.set(pseudo, { key: pseudo, file: `resources/${jf}`, name: '(webview)', line: 0 });
    addUndirected(k, pseudo, 0.5);
    stats.patchedWebview++;
  }
}

// ---------- blind spot 2: shared import symbols (weight 0.25) ----------
const sharedSymbolUsers = new Map(); // "moduleSym::propSym" -> Set(fnKey)
for (const sf of files) {
  const enclosingKey = (n) => {
    for (let x = n; x; x = x.parent) {
      const nm = funcNameOf(x, sf);
      if (nm) return `${rel(sf.fileName)}::${nm}`;
    }
    return null;
  };
  const local = new Map(); // local alias -> module symbol id
  for (const imp of sf.statements.filter(ts.isImportDeclaration)) {
    const modSym = checker.getSymbolAtLocation(imp.moduleSpecifier);
    if (!modSym) continue;
    const mods = checker.getExportsOfModule(modSym).map((s) => s.getName());
    for (const b of imp.importClause?.namedBindings ? [imp.importClause.namedBindings] : []) {
      if (ts.isNamedImports(b)) for (const e of b.elements) local.set(e.name.text, `${modSym.getName()}:${mods.includes(e.propertyName?.text ?? e.name.text) ? (e.propertyName?.text ?? e.name.text) : e.name.text}`);
    }
  }
  const perFn = new Map(); // fnKey -> Set(symbolId)
  const visit = (n) => {
    if (ts.isIdentifier(n) && local.has(n.text) && !ts.isImportSpecifier(n.parent) && !ts.isImportClause(n.parent)) {
      const k = enclosingKey(n);
      if (k && nodes.has(k)) {
        if (!perFn.has(k)) perFn.set(k, new Set());
        perFn.get(k).add(local.get(n.text));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  for (const [k, syms] of perFn) for (const s of syms) {
    if (!sharedSymbolUsers.has(s)) sharedSymbolUsers.set(s, new Set());
    sharedSymbolUsers.get(s).add(k);
  }
}
for (const users of [...sharedSymbolUsers.values()].sort((a, b) => a.size - b.size)) {
  if (users.size < 2 || users.size > HUB) continue;
  const arr = [...users].sort();
  for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) { addUndirected(arr[i], arr[j], 0.25); stats.patchedShared++; }
}

// ---------- metrics ----------
const W = (a, b) => { const k = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`; return edgeW.get(k) ?? 0; };
const deg = new Map(); // node -> weighted degree
for (const [k, w] of edgeW) { const [a, b] = k.split('\u0000'); deg.set(a, (deg.get(a) ?? 0) + w); deg.set(b, (deg.get(b) ?? 0) + w); }
let twoM = 0; for (const w of edgeW.values()) twoM += w;

// file aggregate graph
const fInt = new Map(); const fExt = new Map(); // "a\u0000b" sorted -> weight
const fileOfKey = new Map(); for (const [k, n] of nodes) fileOfKey.set(k, n.file);
for (const [k, w] of edgeW) {
  const [a, b] = k.split('\u0000');
  const fa = fileOfKey.get(a), fb = fileOfKey.get(b);
  if (!fa || !fb) continue;
  const kk = fa === fb ? fa : (fa < fb ? `${fa}\u0000${fb}` : `${fb}\u0000${fa}`);
  if (fa === fb) fInt.set(kk, (fInt.get(kk) ?? 0) + w);
  else fExt.set(kk, (fExt.get(kk) ?? 0) + w);
}
function modularity(communityOf) {
  let q = 0;
  const sumIn = new Map(); const sumTot = new Map();
  const seen = new Set();
  for (const [k] of edgeW) {
    const [a, b] = k.split('\u0000');
    for (const n of [a, b]) {
      if (seen.has(n)) continue;
      seen.add(n);
      const c = communityOf(n);
      sumTot.set(c, (sumTot.get(c) ?? 0) + (deg.get(n) ?? 0));
    }
  }
  for (const [k, w] of edgeW) {
    const [a, b] = k.split('\u0000');
    const ca = communityOf(a), cb = communityOf(b);
    if (ca === cb) sumIn.set(ca, (sumIn.get(ca) ?? 0) + 2 * w);
  }
  for (const c of sumTot.keys()) {
    const ein = sumIn.get(c) ?? 0, etot = sumTot.get(c);
    q += ein / twoM - (etot / twoM) ** 2;
  }
  return q;
}
const Q_now = modularity((k) => fileOfKey.get(k));
// deterministic greedy merge diagnostic (Clarblanque-style, alphabetical ties)
const comm = new Map(); for (const k of nodes.keys()) comm.set(k, k);
const cDeg = new Map(deg); const pairs = new Map();
for (const [k, w] of edgeW) { const [a, b] = k.split('\u0000'); const kk = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`; pairs.set(kk, w); }
function curDeg(c) { return cDeg.get(c) ?? 0; }
for (let pass = 0; pass < 8; pass++) {
  let merged = false;
  const cands = [...pairs.keys()].sort();
  for (const kk of cands) {
    const [x, y] = kk.split('\u0000').map((c) => find(c));
    if (x === y) continue;
    const w = pairWeight(x, y);
    if (w <= 0) continue;
    const gain = w - (curDeg(x) * curDeg(y)) / twoM;
    if (gain > 1e-9) { merge(x, y); merged = true; }
  }
  if (!merged) break;
}
function find(c) { let x = c; while (comm.get(x) !== x) x = comm.get(x); return x; }
function pairWeight(a, b) {
  let s = 0;
  for (const [k, w] of pairs) { const [u, v] = k.split('\u0000'); if ((find(u) === a && find(v) === b) || (find(u) === b && find(v) === a)) s += w; }
  return s;
}
function merge(a, b) {
  comm.set(b, a);
  cDeg.set(a, curDeg(a) + curDeg(b));
  cDeg.delete(b);
}
const Q_greedy = (() => { try { return modularity((k) => find(comm.get(k) ?? k)); } catch { return NaN; } })();

// SCC (iterative Tarjan, sorted order)
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
    if (ci === 0) { index.set(v, counter); low.set(v, counter++); stack.push(v); onStack.add(v); childLists.set(v, [...(dirEdges.get(v) ?? [])].sort()); }
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
const crossSccs = sccs.filter((c) => new Set(c.map((k) => fileOfKey.get(k))).size > 1);

// ---------- TOOLS profile (common-helpers exception, user ruling 2026-09-04) ----------
// A src/shared/ file whose helpers are consumed broadly and do NOT call each
// other is a TOOLBOX, not a misplaced cluster: high conductance is the design,
// and a general helper stays even while only one consumer uses it today
// (reusability is the point). The exemption must be EARNED, mechanically:
//   1. lives in src/shared/ (the DECLARED toolbox directory - no domain file
//      declares itself a toolbox after the fact)
//   2. stateless: no top-level let/var (a toolbox that holds state is a
//      domain module wearing a trenchcoat)
//   3. loosely self-coupled: internal call edges <= function count (tools that
//      mostly call each other are a cluster, not a toolbox)
//   4. broad consumers: >= 4 distinct consumer files (used-anywhere, proven)
// MOVE_GAIN inside a TOOLS file with >= 2 consumer files is SKIPPED (generality
// proven, helper stays). Single-consumer helpers stay NOMINATED with a flag -
// a machine can never prove a helper is general, only disprove laziness.
const toolsSet = new Set();
const toolsStats = [];
const sharedSrc = files.filter((sf) => rel(sf.fileName).startsWith('src/shared/'));
for (const sf of sharedSrc) {
  const f = rel(sf.fileName);
  const fns = [...nodes.values()].filter((n) => n.file === f).length;
  if (fns < 3) continue;
  let mutable = false;
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st) && !(st.declarationList.flags & ts.NodeFlags.Const)) { mutable = true; break; }
  }
  const internal = fInt.get(f) ?? 0;
  const consumers = new Set();
  for (const [k] of fExt) { const [a, b] = k.split('\u0000'); if (a === f) consumers.add(b); else if (b === f) consumers.add(a); }
  const shapeOk = !mutable && internal <= fns;
  toolsStats.push({ f, fns, internal, consumers: consumers.size, mutable, shapeOk, qualified: shapeOk && consumers.size >= 4 });
  if (shapeOk && consumers.size >= 4) toolsSet.add(f);
}
toolsStats.sort((a, b) => a.f.localeCompare(b.f));
const toolsSkipped = { count: 0 };

// move gain
const gains = [];
for (const [key, n] of nodes) {
  let home = 0; const ext = new Map();
  for (const [k, w] of edgeW) {
    const [a, b] = k.split('\u0000');
    let other = null;
    if (a === key) other = b; else if (b === key) other = a; else continue;
    const of = fileOfKey.get(other);
    if (of === n.file) home += w; else ext.set(of, (ext.get(of) ?? 0) + w);
  }
  const total = home + [...ext.values()].reduce((s, v) => s + v, 0);
  if (total < MIN_WEIGHT || ext.size === 0) continue;
  const [tf, tw] = [...ext.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0];
  // calibration: the top target must hold >= 1 REAL call edge, so shared-import
  // patches alone cannot nominate trivia (class getters etc.)
  let realToTarget = 0;
  for (const [k2, n2] of nodes) if (n2.file === tf) {
    const ck = key < k2 ? `${key}\u0000${k2}` : `${k2}\u0000${key}`;
    realToTarget += callW.get(ck) ?? 0;
  }
  if (realToTarget < 1) continue;
  if (tw / total >= MIN_SHARE && tw > home) {
    if (toolsSet.has(n.file) && ext.size >= 2) { toolsSkipped.count++; continue; }
    gains.push({ n, home, tf, tw, total, extFiles: ext.size, realToTarget, toolsHome: toolsSet.has(n.file) });
  }
}
gains.sort((a, b) => (b.tw / b.total) - (a.tw / a.total) || a.n.key.localeCompare(b.n.key));

// conductance per file
const fnCount = new Map(); for (const n of nodes.values()) fnCount.set(n.file, (fnCount.get(n.file) ?? 0) + 1);
const cond = [];
for (const f of fnCount.keys()) {
  let internal = fInt.get(f) ?? 0, cut = 0;
  for (const [k, w] of fExt) { const [a, b] = k.split('\u0000'); if (a === f || b === f) cut += w; }
  const vol = 2 * internal + cut;
  if ((fnCount.get(f) ?? 0) >= 3 && vol > 0) cond.push({ f, phi: cut / vol, internal, cut, fns: fnCount.get(f) });
}
cond.sort((a, b) => b.phi - a.phi || a.f.localeCompare(b.f));

// ---------- report ----------
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(3) : String(x));
if (TSV) {
  const rows = [];
  for (const g of gains.slice(0, TOP)) rows.push(['MOVE_GAIN', g.n.key, `${g.home}`, `extFiles=${g.extFiles}`, `${g.tf}=${g.tw}`, fmt(g.tw / g.total)].join('\t'));
  for (const t of toolsStats) if (t.qualified) rows.push(['TOOLS', t.f, `fns=${t.fns}`, `consumers=${t.consumers}`, `internal=${t.internal}`].join('\t'));
  for (const c of crossSccs) rows.push(['SCC_CROSS', [...new Set(c.map((k) => fileOfKey.get(k)))].sort().join(','), c.length, c.sort().join(' ')].join('\t'));
  for (const c of cond.slice(0, TOP)) rows.push(['CONDUCTANCE', c.f, fmt(c.phi), `cut=${c.cut}`, `fns=${c.fns}`].join('\t'));
  rows.push(['MODULARITY', `Q_now=${fmt(Q_now)}`, `Q_greedy=${fmt(Q_greedy)}`, `dQ=${fmt(Q_greedy - Q_now)}`].join('\t'));
  process.stdout.write(rows.join('\n') + '\n');
} else {
  console.log(`cluster-census: ${nodes.size} functions, ${edgeW.size} undirected edges (calls ${stats.call}, same-file ${stats.callSame}; patched: webview ${stats.patchedWebview}, shared-imports ${stats.patchedShared}; dropped-interface ${stats.droppedInterface}, external-or-unresolved call sites ${stats.unresolved})`);
  console.log('Reading guide: MOVE_GAIN extFiles=1 + home 0 = move candidate; extFiles>=2 with no home use = the module API is honest, usually keep.');
  console.log('Conductance is a conversation-starter: leaf/registry/library files are cut-heavy BY DESIGN.');
  console.log('TOOLS exception: a src/shared/ file that is stateless, loosely self-coupled and has >= 4 consumer files');
  console.log('  is a toolbox - cut-heavy by design, general helpers stay (single-consumer ones stay nominated: generality is a human call).');
  console.log('');
  console.log(`MOVE_GAIN candidates (share >= ${MIN_SHARE}, weight >= ${MIN_WEIGHT}): ${gains.length}${toolsSkipped.count ? `  (${toolsSkipped.count} toolbox helpers exempted: generality proven)` : ''}`);
  for (const g of gains.slice(0, TOP)) console.log(`  ${(g.tw / g.total).toFixed(2)}  ${g.n.key}  [home ${g.home}, ${g.extFiles} ext file(s)] -> ${g.tf} [${g.tw}]${g.toolsHome ? '  (TOOLS home: stays unless domain-coupled - rule generality)' : ''}`);
  console.log('');
  console.log('TOOLS profile (src/shared/ toolbox test: stateless, internal <= fns, consumers >= 4):');
  for (const t of toolsStats) {
    console.log(`  ${t.qualified ? '[TOOLS]    ' : '[not yet]  '}${t.f}  (${t.fns} fns, ${t.consumers} consumer file(s), internal ${t.internal}${t.mutable ? ', HAS MODULE STATE' : ''})`);
  }
  console.log('');
  console.log(`CROSS-FILE SCCs: ${crossSccs.length}`);
  for (const c of crossSccs) console.log(`  files: ${[...new Set(c.map((k) => fileOfKey.get(k)))].sort().join(', ')}\n    ${c.sort().join('\n    ')}`);
  console.log('');
  console.log(`MODULARITY: Q(current files) ${fmt(Q_now)}  Q(greedy reference) ${fmt(Q_greedy)}  dQ ${fmt(Q_greedy - Q_now)}  (diagnostic only)`);
  console.log('');
  console.log(`CONDUCTANCE (top ${Math.min(TOP, cond.length)}, files with >= 3 functions):`);
  for (const c of cond.slice(0, TOP)) console.log(`  ${fmt(c.phi)}  ${c.f}  (cut ${c.cut} / vol ${2 * c.internal + c.cut}, ${c.fns} fns)${toolsSet.has(c.f) ? ' [TOOLS - cut-heavy by design]' : ''}`);
}
