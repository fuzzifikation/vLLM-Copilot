// extract-ts.mjs — canonical function-call-graph extractor for TypeScript/JS projects.
// Part of the portable structural-review toolchain (analyze.mjs is the
// language-agnostic metric engine; this script only produces the canonical
// graph JSON that engine reads).
//
// usage: node extract-ts.mjs [--project=DIR] [--tsconfig=tsconfig.json]
//        [--tsconfig-extra=test/tsconfig.json] [--src=src/] [--out=.tools/structural/graph.json]
//        [--shared-imports=1] [--webview-dir=resources] [--hub=15]
//
// --src:      comma-separated path prefixes counted as production code (rest
//             of the tsconfig file list, libs, tests are excluded from nodes).
// --shared-imports: blind-spot patch, weight 0.25 edges between functions that
//             import the same module symbol (hub symbols > --hub skipped so
//             wire-type hubs cannot fake a merge-everything attractor).
// --webview-dir: blind-spot patch, weight 0.5 edges between TS functions and
//             assets/*.js pseudo-nodes sharing message-type string literals.
//
// Determinism: sorted file order, sorted node/edge output, stable tie-breaks.
// Run twice and byte-diff before trusting any report. Requires `typescript`
// resolvable from the project (devDependency - every TS project has one);
// fallback: `npm i --prefix .tools/structural typescript` then rerun.

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const argVal = (name, dflt) => {
  const a = argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : dflt;
};
const PROJECT = argVal('project', '.');
const TSCONFIG = argVal('tsconfig', 'tsconfig.json');
const TSCONFIG_EXTRA = argVal('tsconfig-extra', '');
const SRC_PREFIXES = argVal('src', 'src/').split(',').map((s) => s.trim()).filter(Boolean);
const OUT = argVal('out', path.join('.tools', 'structural', 'graph.json'));
const PATCH_SHARED = argVal('shared-imports', '0') === '1';
const WEBVIEW_DIR = argVal('webview-dir', '');
const HUB = parseInt(argVal('hub', '15'), 10);

process.chdir(PROJECT);
const requireFrom = (base) => createRequire(path.join(process.cwd(), base, 'noop.js'));
let ts;
for (const base of ['.', path.join('.tools', 'structural')]) {
  try {
    const m = await import(pathToFileURL(requireFrom(base).resolve('typescript')).href);
    ts = m.default ?? m;
    break;
  } catch { /* try next base */ }
}
if (!ts) throw new Error("typescript not resolvable from the project or .tools/structural - run: npm i --prefix .tools/structural typescript");
const norm = (f) => f.split(path.sep).join('/').replaceAll('\\', '/');
const rel = (f) => norm(path.relative(process.cwd(), f));
const isProd = (f) => SRC_PREFIXES.some((p) => f.startsWith(p));

function parsedConfig(p) {
  return ts.getParsedCommandLineOfConfigFile(p, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} });
}
const srcCfg = parsedConfig(TSCONFIG);
if (!srcCfg) throw new Error(`cannot parse ${TSCONFIG}`);
const extra = TSCONFIG_EXTRA && ts.sys.fileExists(TSCONFIG_EXTRA) ? parsedConfig(TSCONFIG_EXTRA) : null;
const rootNames = [...new Set([...srcCfg.fileNames, ...(extra ? extra.fileNames : [])].map(norm))];
const program = ts.createProgram(rootNames, srcCfg.options);
const checker = program.getTypeChecker();
const prodFile = (sf) => sf && !sf.isDeclarationFile && isProd(rel(sf.fileName));

// ---------- nodes ----------
const nodes = new Map();
const byName = new Map();
const methodIds = new Set(); // ids whose name is "Class#member": passed as values, not called directly
function addNode(sf, name, declNode) {
  const file = rel(sf.fileName);
  const key = `${file}::${name}`;
  if (nodes.has(key)) return key;
  if (name.includes('#')) methodIds.add(key);
  const { line } = sf.getLineAndCharacterOfPosition(declNode.getStart());
  nodes.set(key, { id: key, file, name, line: line + 1 });
  if (!byName.has(name)) byName.set(name, []);
  byName.get(name).push(key);
  return key;
}
function funcNameOf(decl) {
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
const files = program.getSourceFiles().filter(prodFile).sort((a, b) => rel(a.fileName).localeCompare(rel(b.fileName)));
for (const sf of files) {
  const visit = (n) => { const nm = funcNameOf(n); if (nm) addNode(sf, nm, n); ts.forEachChild(n, visit); };
  visit(sf);
}

// ---------- edges ----------
// Canonical schema keeps TRUTH: calls are DIRECTED (SCC needs direction),
// patches (blind-spot glue) are undirected low-weight pairs.
const callDir = new Map(); // "from\0to" -> count
const patchU = new Map(); // "a\0b" sorted -> weight
const stats = { call: 0, callSame: 0, patchedWebview: 0, patchedShared: 0, patchedRefs: 0, droppedInterface: 0, unresolved: 0 };
function addCall(a, b) {
  if (a === b || !nodes.has(a) || !nodes.has(b)) return;
  const k = `${a}\u0000${b}`;
  callDir.set(k, (callDir.get(k) ?? 0) + 1);
}
function addPatch(a, b, w) {
  if (a === b || !nodes.has(a) || !nodes.has(b)) return;
  const k = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
  patchU.set(k, (patchU.get(k) ?? 0) + w);
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
      const nm = funcNameOf(d);
      if (nm) return `${rel(sf.fileName)}::${nm}`;
      if (nodes.has(`${rel(sf.fileName)}::${sym.name}`)) return `${rel(sf.fileName)}::${sym.name}`;
      return null;
    }
    if (sf && isProd(rel(sf.fileName))) return `__interface__::${sym.name}`;
  }
  return null;
}
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
      const nm = funcNameOf(x);
      if (nm) return `${rel(sf.fileName)}::${nm}`;
    }
    return null;
  };
  const visit = (n) => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const src = enclosingKey(n);
      if (src && nodes.has(src)) {
        let sym = n.expression ? checker.getSymbolAtLocation(n.expression) : null;
        let target = keyForSymbol(sym);
        if (target === `__interface__::${sym?.name}`) {
          const r = retargetInterface(sym.name);
          if (r) target = r;
          else { target = null; stats.droppedInterface++; }
        }
        if (target && nodes.has(target)) {
          addCall(src, target);
          stats.call++;
          if (nodes.get(src).file === nodes.get(target).file) stats.callSame++;
        } else if (!target) {
          stats.unresolved++;
          const name = n.expression && ts.isIdentifier(n.expression) ? n.expression.text : null;
          if (name && byName.get(name)?.length === 1) {
            const t = byName.get(name)[0];
            if (t !== src) { addCall(src, t); stats.call++; }
          }
        }
      }
    } else if (
      // blind spot 3: callbacks/functions passed by REFERENCE, never called here.
      // Referencing a known function without calling it means someone else will
      // call it dynamically: emit weak patch glue (0.25) so rent and placement
      // see the relationship without polluting true call direction (SCC/cycles).
      // Methods (Class#member) are the dynamic-dispatch surface by design, so
      // references to them are normal OOP, not glue: skipped.
      ts.isIdentifier(n) &&
      !ts.isCallExpression(n.parent) && !ts.isNewExpression(n.parent) &&
      !ts.isPropertyAccessExpression(n.parent) &&
      !ts.isDeclaration(n.parent) &&
      !ts.isPropertyAssignment(n.parent) &&
      !ts.isPropertySignature(n.parent) &&
      !ts.isImportSpecifier(n.parent) && !ts.isImportClause(n.parent) &&
      !ts.isExportSpecifier(n.parent) &&
      !(ts.isVariableDeclaration(n.parent) && n.parent.name === n) &&
      !(ts.isParameter(n.parent) && n.parent.name === n)
    ) {
      const src = enclosingKey(n);
      if (src && nodes.has(src)) {
        const target = keyForSymbol(checker.getSymbolAtLocation(n));
        if (target && nodes.has(target) && target !== src && !methodIds.has(target)) {
          addPatch(src, target, 0.25);
          stats.patchedRefs++;
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

// ---------- blind spot 1: message-passing pairs (webview etc.), weight 0.5 ----------
if (WEBVIEW_DIR) {
  // matches `case 't'`, `type: 't'`, `type = 't'`, `type == 't'`, `type === 't'`
  // (the common postMessage literal shape `{ type: 't' }` needs the bare-colon arm)
  const TYPE_RE = /(?:case\s+|type\s*:?={0,2}\s*)['"]([\w./-]+)['"]/g;
  const assetFiles = readdirSync(WEBVIEW_DIR).filter((f) => f.endsWith('.js')).sort();
  for (const jf of assetFiles) {
    const jsText = readFileSync(path.join(WEBVIEW_DIR, jf), 'utf8');
    const jsTypes = new Set([...jsText.matchAll(TYPE_RE)].map((m) => m[1]));
    const pseudo = `${WEBVIEW_DIR}/${jf}::__handler__`;
    const partners = new Map();
    for (const sf of files) {
      const text = sf.getFullText();
      const tsTypes = new Set([...text.matchAll(TYPE_RE)].map((m) => m[1]));
      const shared = new Set([...tsTypes].filter((t) => jsTypes.has(t)));
      if (shared.size === 0) continue;
      const visit = (n) => {
        const nm = funcNameOf(n);
        if (nm) {
          const key = `${rel(sf.fileName)}::${nm}`;
          const body = n.getFullText();
          for (const t of shared) {
            if (body.includes(`'${t}'`) || body.includes(`"${t}"`) || body.includes(`\`${t}\``)) {
              partners.set(key, (partners.get(key) ?? 0) + 1);
              break;
            }
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    if (partners.size === 0) continue;
    if (!nodes.has(pseudo)) {
      nodes.set(pseudo, { id: pseudo, file: `${WEBVIEW_DIR}/${jf}`, name: '(handler)', line: 0 });
    }
    for (const k of partners.keys()) { addPatch(k, pseudo, 0.5); stats.patchedWebview++; }
  }
}

// ---------- blind spot 2: shared import symbols, weight 0.25 ----------
if (PATCH_SHARED) {
  const users = new Map(); // "module::export" -> Set(fnKey)
  for (const sf of files) {
    const enclosingKey = (n) => {
      for (let x = n; x; x = x.parent) {
        const nm = funcNameOf(x);
        if (nm) return `${rel(sf.fileName)}::${nm}`;
      }
      return null;
    };
    const local = new Map();
    for (const imp of sf.statements.filter(ts.isImportDeclaration)) {
      const modSym = checker.getSymbolAtLocation(imp.moduleSpecifier);
      if (!modSym) continue;
      const exported = new Set(checker.getExportsOfModule(modSym).map((s) => s.getName()));
      const b = imp.importClause?.namedBindings;
      if (b && ts.isNamedImports(b)) {
        for (const e of b.elements) {
          const propName = e.propertyName?.text ?? e.name.text;
          if (exported.has(propName)) local.set(e.name.text, `${modSym.getName()}:${propName}`);
        }
      }
    }
    const perFn = new Map();
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
      if (!users.has(s)) users.set(s, new Set());
      users.get(s).add(k);
    }
  }
  for (const set of [...users.values()].sort((a, b) => a.size - b.size)) {
    if (set.size < 2 || set.size > HUB) continue;
    const arr = [...set].sort();
    for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) { addPatch(arr[i], arr[j], 0.25); stats.patchedShared++; }
  }
}

// ---------- file metadata (state test for the TOOLS profile) ----------
const fileMeta = [];
for (const sf of files) {
  let mutable = false;
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st) && !(st.declarationList.flags & ts.NodeFlags.Const)) { mutable = true; break; }
  }
  const f = rel(sf.fileName);
  fileMeta.push({ path: f, mutable, fns: [...nodes.values()].filter((n) => n.file === f).length });
}

// ---------- emit canonical JSON ----------
const callList = [];
for (const [k, w] of callDir) {
  const [from, to] = k.split('\u0000');
  callList.push({ from, to, w });
}
callList.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
const patchList = [];
for (const [k, w] of patchU) {
  const [a, b] = k.split('\u0000');
  patchList.push({ a, b, w });
}
patchList.sort((a, b) => a.a.localeCompare(b.a) || a.b.localeCompare(b.b));
const nodeList = [...nodes.values()].sort((x, y) => x.id.localeCompare(y.id));
fileMeta.sort((a, b) => a.path.localeCompare(b.path));
const graph = {
  meta: {
    extractor: 'extract-ts', tsVersion: ts.version, project: path.basename(path.resolve('.')),
    srcPrefixes: SRC_PREFIXES, patches: { sharedImports: PATCH_SHARED, messageDir: WEBVIEW_DIR || null, hub: HUB },
    stats,
  },
  nodes: nodeList,
  calls: callList,
  patches: patchList,
  files: fileMeta,
};
mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(graph, null, 1));
console.log(`extract-ts: ${nodeList.length} nodes, ${callList.length} call pairs, ${patchList.length} patch pairs -> ${OUT}`);
console.log(`stats: ${JSON.stringify(stats)}`);
