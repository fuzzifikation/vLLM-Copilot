// rent-census.mjs — function-level enforcement of the reuse-or-absorb law
// (docs/complexity-audit.md, pass 2; copilot-instructions.md rule 7).
//
// A named thing pays rent only if it is genuinely large OR has >= 2
// production callers. Tests are NOT customers (user ruling 2026-09-03).
// This script does NOT judge "large" (per-case ruling) — it counts rent
// mechanically and highlights what deserves a verdict:
//
//   DEAD            zero references anywhere
//   TEST_ONLY       exported, zero production callers, tests use it -> un-export or delete
//   ABSORB_SMALL    exactly one production call site and small (<= --max-small lines)
//   INTERNAL_SINGLE private helper with exactly one in-file caller -> absorb into it
//   CHAIN           same-file single-caller chains -> collapse candidates (listed at bottom)
//   BIG_SINGLE      one production caller but sizeable -> human per-case verdict
//   REUSED          >= 2 production modules -> pays rent
//
// Test helpers (test/** minus *.test.ts minus __mocks__) are censused with
// suites as customers: TESTHELPER_SINGLE (one suite -> inline it), TESTHELPER_DEAD.
// resources/*.js and scripts/*.mjs get a NAIVE same-file scan (no type
// checker there, name matching only; treat as hints).
//
// Knob: --max-small=N (default 24) only controls ABSORB_SMALL highlighting,
// it is not a keep-threshold. --fail-on=dead exits 1 when DEAD/TESTHELPER_DEAD exist.
// --tsv gives machine-readable output for before/after diffs of amputation commits.
//
// Known tolerance: JSDoc @link and import-without-use count as references
// (over-counting consumers is the safe direction for an absorb-tripwire).

import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const argVal = (name, dflt) => {
  const a = argv.find((s) => s.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : dflt;
};
const TSV = argv.includes('--tsv');
const MAX_SMALL = parseInt(argVal('max-small', '24'), 10);
const FAIL_ON = argVal('fail-on', '');

const cwd = process.cwd();
const norm = (f) => f.split(path.sep).join('/').replaceAll('\\', '/');
const rel = (f) => norm(path.relative(cwd, f));
const isTestPath = (f) => f.startsWith('test/');

function parsedConfig(p) {
  return ts.getParsedCommandLineOfConfigFile(p, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} });
}
const srcCfg = parsedConfig('tsconfig.json');
const testCfg = parsedConfig('test/tsconfig.json');
if (!srcCfg) throw new Error('cannot parse tsconfig.json');
const rootNames = [...new Set([...srcCfg.fileNames, ...(testCfg ? testCfg.fileNames : [])].map((f) => norm(f)))];
const program = ts.createProgram(rootNames, srcCfg.options);
const checker = program.getTypeChecker();

// ---------- targets: module-level named things ----------
const targets = [];
const passThroughFiles = [];

function enclosingLabel(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (ts.isClassDeclaration(n) && n.name) return n.name.text;
    if (ts.isMethodDeclaration(n) && n.name) return n.name.getText();
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
      const init = n.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return n.name.text;
    }
  }
  return '(module scope)';
}

function addTarget(node, sf, exported, kind) {
  const nameNode = ts.isVariableDeclaration(node) ? node.name : node.name;
  if (!nameNode || !ts.isIdentifier(nameNode)) return;
  const s = ts.getLineAndCharacterOfPosition(sf, node.getStart());
  const e = ts.getLineAndCharacterOfPosition(sf, node.getEnd());
  targets.push({
    name: nameNode.text,
    kind,
    file: rel(sf.fileName),
    line: s.line + 1,
    lines: e.line - s.line + 1,
    exported,
    symbol: checker.getSymbolAtLocation(nameNode),
    selfStart: node.getStart(),
    selfEnd: node.getEnd(),
    prodSites: [], // {file, label} cross-file production references
    testSites: [], // {file, label} references from test/**
    internal: [], // in-file caller labels (excluding self subtree)
  });
}

for (const f of rootNames) {
  const sf = program.getSourceFile(f);
  if (!sf || sf.isDeclarationFile) continue;
  const file = rel(sf.fileName);
  if (!(file.startsWith('src/') || isTestPath(file))) continue;
  if (isTestPath(file) && (/\.test\.ts$/.test(file) || file.includes('__mocks__'))) continue; // suites are customers; mocks are aliased
  for (const stmt of sf.statements) {
    const exported = !!(ts.canHaveModifiers(stmt) && (ts.getModifiers(stmt) || []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
    if (ts.isFunctionDeclaration(stmt) && stmt.name) addTarget(stmt, sf, exported, 'fn');
    else if (ts.isClassDeclaration(stmt) && stmt.name) addTarget(stmt, sf, exported, 'class');
    else if (ts.isInterfaceDeclaration(stmt) && stmt.name) addTarget(stmt, sf, exported, 'iface');
    else if (ts.isTypeAliasDeclaration(stmt) && stmt.name) addTarget(stmt, sf, exported, 'type');
    else if (ts.isVariableStatement(stmt))
      for (const d of stmt.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)))
          addTarget(d, sf, exported, 'fn');
  }
  if (!isTestPath(file)) {
    const decls = sf.statements.filter(
      (s) =>
        ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s) ||
        ts.isTypeAliasDeclaration(s) || ts.isVariableStatement(s) || ts.isEnumDeclaration(s)
    );
    const reexports = sf.statements.filter((s) => ts.isExportDeclaration(s) && (s.moduleSpecifier || s.moduleReference)).length;
    if (decls.length === 0 && reexports > 0) passThroughFiles.push(file);
  }
}

// ---------- reference scan over the whole program ----------
const bySymbol = new Map();
for (const t of targets) if (t.symbol) bySymbol.set(t.symbol, t);

function resolveAlias(sym) {
  let s = sym;
  for (let i = 0; i < 5 && s && s.flags & ts.SymbolFlags.Alias; i++) {
    const a = checker.getAliasedSymbol(s);
    if (!a || a === s) break;
    s = a;
  }
  return s;
}

for (const sf of program.getSourceFiles()) {
  if (sf.isDeclarationFile) continue;
  const file = rel(sf.fileName);
  if (!(file.startsWith('src/') || isTestPath(file))) continue;
  const refIsTest = isTestPath(file);
  const visit = (node) => {
    if (ts.isIdentifier(node)) {
      const sym = checker.getSymbolAtLocation(node);
      if (sym) {
        const t = bySymbol.get(resolveAlias(sym));
        if (t) {
          if (t.file === file) {
            const pos = node.getStart();
            if (pos < t.selfStart || pos > t.selfEnd) t.internal.push(enclosingLabel(node));
          } else if (refIsTest) {
            t.testSites.push({ file, label: enclosingLabel(node) });
          } else {
            t.prodSites.push({ file, label: enclosingLabel(node) });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// ---------- verdicts ----------
const ENTRY = /^(activate|deactivate)$/;
const CONTRACT = (t) => t.kind === 'iface' || t.kind === 'type' || (t.kind === 'class' && /Error$/.test(t.name));
// Contracts (interfaces, type aliases, error classes) are not called, they are
// NAMED. One external namer plus in-file composition is normal for a shared
// type; they get CONTRACT_* flags so function-level absorb rules stay honest.
for (const t of targets) {
  const prodMods = new Set(t.prodSites.map((s) => s.file));
  const testMods = new Set(t.testSites.map((s) => s.file));
  const testHelper = isTestPath(t.file);
  const internalOnly = t.prodSites.length === 0 && t.testSites.length === 0;
  if (ENTRY.test(t.name)) t.flag = 'ENTRY';
  else if (prodMods.size === 0 && testMods.size === 0 && t.internal.length === 0)
    t.flag = CONTRACT(t) ? 'CONTRACT_DEAD' : 'DEAD';
  else if (testHelper) {
    if (testMods.size === 0) t.flag = 'TESTHELPER_DEAD';
    else if (testMods.size === 1) t.flag = 'TESTHELPER_SINGLE';
    else t.flag = 'REUSED';
  } else if (CONTRACT(t)) {
    if (prodMods.size === 0) t.flag = t.exported ? 'CONTRACT_TEST_ONLY' : 'CONTRACT_INTERNAL';
    else if (prodMods.size === 1) t.flag = 'CONTRACT_SINGLE';
    else t.flag = 'REUSED';
  } else if (prodMods.size === 0) t.flag = t.exported ? 'TEST_ONLY' : 'INTERNAL_DEAD';
  else if (prodMods.size === 1) {
    const only = t.prodSites.find((s) => !isTestPath(s.file));
    t.onlyCaller = `${only.file}::${only.label}`;
    t.flag = t.lines <= MAX_SMALL ? 'ABSORB_SMALL' : 'BIG_SINGLE';
  } else t.flag = 'REUSED';
  if (internalOnly && !t.flag.startsWith('CONTRACT') && !testHelper) {
    if (t.internal.length === 1) t.flag = 'INTERNAL_SINGLE';
    else if (t.internal.length >= 2) t.flag = t.lines > MAX_SMALL ? 'REUSED' : 'INTERNAL_MULTI';
  }
  t.prodN = prodMods.size;
  t.testN = testMods.size;
}

// ---------- same-file absorb chains (collapse candidates) ----------
const targetByNameInFile = new Map();
for (const t of targets) targetByNameInFile.set(`${t.file}::${t.name}`, t);
const chainEdges = new Map(); // callerName -> calleeName (same file, callee has only that caller)
for (const t of targets) {
  if (t.file.startsWith('src/') && t.prodN === 0 && t.testN === 0 && t.internal.length === 1) {
    const caller = t.internal[0];
    if (caller !== '(module scope)' && caller !== t.name) {
      const callerT = targetByNameInFile.get(`${t.file}::${caller}`);
      if (callerT) chainEdges.set(`${t.file}::${t.name}`, `${t.file}::${caller}`);
    }
  }
}
const chains = [];
for (const start of chainEdges.keys()) {
  if ([...chainEdges.values()].includes(start)) continue; // not the head
  const chain = [start];
  let cur = start;
  while (chainEdges.has(cur) && chain.length < 20) {
    cur = chainEdges.get(cur);
    chain.push(cur);
  }
  if (chain.length >= 2) chains.push(chain);
}

// ---------- naive JS pass (resources/*.js, scripts/*.mjs) ----------
const jsHints = [];
const jsFiles = [
  ...readdirSync('resources').filter((f) => f.endsWith('.js')).map((f) => `resources/${f}`),
  ...readdirSync('scripts').filter((f) => f.endsWith('.mjs')).map((f) => `scripts/${f}`),
];
for (const file of jsFiles) {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true, file.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.JS);
  const fns = [];
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name)
      fns.push({
        name: stmt.name.text,
        start: stmt.getStart(sf),
        end: stmt.getEnd(),
        lines:
          ts.getLineAndCharacterOfPosition(sf, stmt.getEnd()).line -
          ts.getLineAndCharacterOfPosition(sf, stmt.getStart()).line +
          1,
      });
    else if (ts.isVariableStatement(stmt))
      for (const d of stmt.declarationList.declarations)
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)))
          fns.push({ name: d.name.text, start: stmt.getStart(sf), end: stmt.getEnd(), lines: ts.getLineAndCharacterOfPosition(sf, stmt.getEnd()).line - ts.getLineAndCharacterOfPosition(sf, stmt.getStart()).line + 1 });
  }
  for (const fn of fns) {
    let caller = null;
    let count = 0;
    const scan = (node, inFn) => {
      if (ts.isIdentifier(node) && node.text === fn.name) {
        const pos = node.getStart(sf);
        if (pos < fn.start || pos > fn.end) {
          count++;
          caller = inFn || '(top level)';
        }
      }
      let nextIn = inFn;
      if ((ts.isFunctionDeclaration(node) || (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))) && node.name && ts.isIdentifier(node.name) && node.name.text !== fn.name) {
        const outer = node.parent && ts.isVariableDeclarationList(node.parent) ? node.parent.parent.parent : node.parent;
        nextIn = node.name.text;
      }
      ts.forEachChild(node, (c) => scan(c, nextIn));
    };
    for (const stmt of sf.statements) scan(stmt, null);
    const isEventHandler = /^(on|handle)/.test(fn.name);
    if (count === 0 && !isEventHandler) jsHints.push(`${file}::${fn.name} (${fn.lines} lines) - no in-file caller found (exported to HTML? check webview)`);
    else if (count === 1 && fn.lines <= MAX_SMALL) jsHints.push(`${file}::${fn.name} (${fn.lines} lines) - single caller: ${caller}`);
  }
}

// ---------- output ----------
const flagOrder = ['CONTRACT_DEAD', 'DEAD', 'INTERNAL_DEAD', 'TESTHELPER_DEAD', 'TEST_ONLY', 'TESTHELPER_SINGLE', 'ABSORB_SMALL', 'INTERNAL_SINGLE', 'CONTRACT_TEST_ONLY', 'CONTRACT_SINGLE', 'BIG_SINGLE', 'CONTRACT_INTERNAL', 'INTERNAL_MULTI', 'ENTRY', 'REUSED'];
const SECTIONS = ['CONTRACT_DEAD', 'DEAD', 'INTERNAL_DEAD', 'TESTHELPER_DEAD', 'TEST_ONLY', 'TESTHELPER_SINGLE', 'ABSORB_SMALL', 'INTERNAL_SINGLE', 'CONTRACT_TEST_ONLY', 'CONTRACT_SINGLE', 'BIG_SINGLE'];
const label = (t) => `${t.name} (${t.kind}) ${t.file}:${t.line}, ${t.lines}L`;
const callerInfo = (t) => t.onlyCaller || (t.internal.length ? `internal:${t.internal[0]}` : t.testSites.length ? `test:${[...new Set(t.testSites.map((s) => s.file))].join(',')}` : '-');

if (TSV) {
  console.log('flag\tname\tfile\tline\tlines\tprodMods\ttestFiles\tonlyCaller');
  for (const t of targets)
    console.log([t.flag, t.name, t.file, t.line, t.lines, t.prodN, t.testN, callerInfo(t)].join('\t'));
} else {
  console.log(`# Rent census (law: >=2 prod callers OR genuinely large; tests are not customers)`);
  console.log(`# files: src/** + test helpers via tsconfig | ABSORB_SMALL size knob: ${MAX_SMALL}L (highlight only, not a keep-threshold)`);
  console.log(`# targets: ${targets.length}\n`);
  const counts = {};
  for (const t of targets) counts[t.flag] = (counts[t.flag] || 0) + 1;
  console.log('## summary\n');
  for (const f of flagOrder) if (counts[f]) console.log(`- ${f}: ${counts[f]}`);
  for (const f of Object.keys(counts)) if (!flagOrder.includes(f)) console.log(`- ${f}: ${counts[f]}`);
  if (passThroughFiles.length) console.log(`- PASS_THROUGH_FILE: ${passThroughFiles.length}`);
  for (const t of targets) if (t.flag === 'ABSORB_SMALL') t.chainMember = [...chainEdges.keys()].includes(`${t.file}::${t.name}`);
  for (const f of SECTIONS) {
    const rows = targets.filter((t) => t.flag === f);
    if (!rows.length) continue;
    console.log(`\n## ${f} (${rows.length})\n`);
    for (const t of rows)
      console.log(`- ${label(t)} | prod:${t.prodN} test:${t.testN} int:${t.internal.length} | ${callerInfo(t)}${t.chainMember ? ' [CHAIN]' : ''}`);
  }
  if (passThroughFiles.length) {
    console.log(`\n## PASS_THROUGH_FILE (${passThroughFiles.length})\n`);
    for (const f of passThroughFiles) console.log(`- ${f} (re-export facade, no own declarations)`);
  }
  if (chains.length) {
    console.log(`\n## same-file collapse chains (${chains.length}) — single-caller chains, law says collapse into one function, re-split only reused steps\n`);
    for (const c of chains) console.log(`- ${c.join(' <- ')}`);
  }
  if (jsHints.length) {
    console.log(`\n## JS heuristic (resources/*.js, scripts/*.mjs - naive name match, verify before acting) (${jsHints.length})\n`);
    for (const h of jsHints) console.log(`- ${h}`);
  }
}

if (FAIL_ON === 'dead') {
  const deadly = targets.filter((t) => t.flag === 'DEAD' || t.flag === 'INTERNAL_DEAD' || t.flag === 'TESTHELPER_DEAD');
  if (deadly.length) {
    console.error(`\nrent-census FAIL: ${deadly.length} dead named thing(s)`);
    process.exit(1);
  }
}
