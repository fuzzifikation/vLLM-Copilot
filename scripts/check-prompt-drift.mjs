#!/usr/bin/env node
/**
 * Prompt drift canary for the bundled personalities.
 *
 * The personality presets in prompt-replacements/ apply exact-substring find/replace
 * rules against Copilot's *hidden* system-prompt boilerplate. Microsoft edits that
 * boilerplate without notice, and when a `find` string stops matching the rule
 * silently no-ops (the personality "works" but the boilerplate it was meant to strip
 * stays in). This script catches that drift by comparing the presets against the
 * current VS Code prompt source on GitHub (microsoft/vscode).
 *
 * Two signals, each answering a different question:
 *
 *   1. RULE MATCH — does each preset `find` still exist in the current source?
 *      Prose is extracted from the .tsx source (JSX text nodes, whitespace-insensitive
 *      via @babel/parser) or .ts source (string literal values), then each `find` is
 *      matched with whitespace collapsed. A DEAD rule means that exact text is gone —
 *      the rule will no longer apply in production.
 *
 *   2. SHA CANARY — did any watched source file change since the last manual review?
 *      The script pins the GitHub blob SHA of each watched file. Any change fires a
 *      warning even if individual `find` strings happen to survive (e.g. a wording
 *      change elsewhere in the same file, or a rename).
 *
 * IMPORTANT: this is a CANARY, not proof. The definitive re-verification after it
 * fires is a fresh `systemMessageCapture` run in VS Code and checking the rendered
 * system messages in .vllm/system-messages.json.
 *
 * Usage:
 *   npm run check:prompt-drift            # check (exit 1 on drift/failure)
 *   node scripts/check-prompt-drift.mjs --update-baseline   # pin current SHAs after a manual review
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const REPL_DIR = path.join(ROOT, 'prompt-replacements');
const THIS_FILE = fileURLToPath(import.meta.url);

const { parse } = createRequire(import.meta.url)('@babel/parser');

/**
 * Watched VS Code prompt source files. `kind`:
 *   - 'jsx'  → extract JSX text nodes (the rendered prose)
 *   - 'text' → extract string-literal values (runtime-generated prompt text)
 * The `.ts`/`.tsx` path is relative to the microsoft/vscode repo root.
 */
const WATCHED_FILES = [
  { label: 'safetyRules.tsx',               repoPath: 'extensions/copilot/src/extension/prompts/node/base/safetyRules.tsx',                      kind: 'jsx' },
  { label: 'copilotIdentity.tsx',           repoPath: 'extensions/copilot/src/extension/prompts/node/base/copilotIdentity.tsx',                  kind: 'jsx' },
  { label: 'agentPrompt.tsx',               repoPath: 'extensions/copilot/src/extension/prompts/node/agent/agentPrompt.tsx',                      kind: 'jsx' },
  { label: 'defaultAgentInstructions.tsx',  repoPath: 'extensions/copilot/src/extension/prompts/node/agent/defaultAgentInstructions.tsx',         kind: 'jsx' },
  { label: 'openai/defaultOpenAIPrompt.tsx',repoPath: 'extensions/copilot/src/extension/prompts/node/agent/openai/defaultOpenAIPrompt.tsx',        kind: 'jsx' },
  { label: 'promptVariablesService.ts',     repoPath: 'extensions/copilot/src/extension/prompt/vscode-node/promptVariablesService.ts',            kind: 'text' },
];

// GitHub blob SHAs captured 2026-08-06. Update after every manual re-verification
// (see --update-baseline below). If a watched file's SHA differs, the file changed.
// eslint-disable-next-line max-len
/*baseline:start*/
const BASELINE = {
  'safetyRules.tsx': '7ecef64b69f9b3d69b90ca09a6b6ea186af08e88',
  'copilotIdentity.tsx': '5a25066c49f5878ea09ea8e22cadeb7a3d038edc',
  'agentPrompt.tsx': 'ef7f92fedb3844189167ba31413f04be8c5c632e',
  'defaultAgentInstructions.tsx': '782f35c152f37d83f52c44b223f99c4f93309d67',
  'openai/defaultOpenAIPrompt.tsx': '4fbcbe0d95691a8d0ee9c96673bfeae87981f703',
  'promptVariablesService.ts': 'c2b23c9fb3c3b193a8179b04de3f34d20dbfd46a',
};
/*baseline:end*/

// ── Canonicalization ────────────────────────────────────────────────

/** Collapse all whitespace — matches any formatting (newlines, <br /> spacing, indentation). */
const collapse = (s) => s.replace(/\s+/g, '');

/** Generic AST walk. */
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((n) => walk(n, visit)); return; }
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' || key === 'trailingComments') continue;
    walk(node[key], visit);
  }
}

/** Extract rendered prose from a .tsx source file: all JSX text nodes, whitespace-collapsed. */
function extractJsxText(src) {
  const ast = parse(src, { sourceType: 'module', plugins: ['jsx', 'typescript', 'decorators-legacy'] });
  const parts = [];
  walk(ast, (n) => { if (n.type === 'JSXText') parts.push(n.value); });
  return collapse(parts.join(' '));
}

/** Extract string-literal values from a .ts source file (covers runtime-generated prompt text). */
function extractStringLiterals(src) {
  const ast = parse(src, { sourceType: 'module', plugins: ['typescript', 'decorators-legacy'] });
  const parts = [];
  walk(ast, (n) => {
    if (n.type === 'StringLiteral') parts.push(n.value);
    else if (n.type === 'TemplateLiteral') for (const q of n.quasis) parts.push(q.value.cooked ?? q.value.raw);
  });
  return collapse(parts.join(' '));
}

// ── GitHub ──────────────────────────────────────────────────────────

/** Fetch one file via the GitHub contents API (returns sha + base64 content together). */
async function fetchFromGithub(repoPath) {
  const url = `https://api.github.com/repos/microsoft/vscode/contents/${repoPath}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'vllm-copilot-drift-canary', 'Accept': 'application/vnd.github+json' } });
  if (res.status === 404) return { ok: true, missing: true, sha: null, content: null };
  if (!res.ok) {
    const detail = await res.text().then((t) => t.slice(0, 200)).catch(() => '');
    throw new Error(`GitHub API ${res.status} for ${repoPath}: ${detail}`);
  }
  const json = await res.json();
  return { ok: true, missing: false, sha: json.sha, content: Buffer.from(json.content, 'base64').toString('utf8') };
}

// ── Loading presets ─────────────────────────────────────────────────

/** Load all distinct find strings from the shipped prompt-replacements files. */
function loadPresetFinds() {
  const finds = [];
  const seen = new Set();
  for (const file of readdirSorted(REPL_DIR).filter((f) => f.endsWith('.json'))) {
    const obj = JSON.parse(readFileSync(path.join(REPL_DIR, file), 'utf8'));
    const rules = Array.isArray(obj) ? obj : obj.rules;
    for (const r of rules) {
      if (typeof r?.find !== 'string' || !r.find) continue;
      const key = collapse(r.find);
      if (seen.has(key)) continue;
      seen.add(key);
      finds.push({ ruleName: r.ruleName || '(unnamed)', find: r.find, file });
    }
  }
  return finds;
}

function readdirSorted(dir) {
  return readdirSync(dir).sort();
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const updateBaseline = process.argv.includes('--update-baseline');

  // 1. Fetch all watched files from GitHub.
  const fetched = [];
  let fetchError = null;
  for (const f of WATCHED_FILES) {
    try {
      fetched.push({ ...f, ...(await fetchFromGithub(f.repoPath)) });
    } catch (err) {
      fetchError = err;
      fetched.push({ ...f, ok: false, error: err.message, missing: false, sha: null, content: null });
    }
  }

  if (fetchError) {
    console.error(`\n[ERROR] Could not reach GitHub: ${fetchError.message}\n`);
    process.exitCode = 1;
    return;
  }

  // 2. Build canonical source text per file.
  const canonical = new Map();
  const parseFailures = [];
  for (const f of fetched) {
    if (f.missing || f.error) continue;
    try {
      canonical.set(f.label, f.kind === 'jsx' ? extractJsxText(f.content) : extractStringLiterals(f.content));
    } catch (err) {
      parseFailures.push(`${f.label}: ${err.message}`);
    }
  }

  // 3. Rule-match: does every preset find still exist somewhere in the source?
  const finds = loadPresetFinds();
  let deadRules = 0;
  const lines = [];
  for (const f of finds) {
    const key = collapse(f.find);
    const matchedIn = [...canonical.entries()].filter(([, text]) => text.includes(key)).map(([label]) => label);
    if (matchedIn.length) {
      lines.push(`  [OK]   ${f.ruleName}  (${matchedIn.join(', ')})`);
    } else {
      deadRules++;
      lines.push(`  [DEAD] ${f.ruleName}  -- NOT FOUND in current source`);
      lines.push(`      find: ${JSON.stringify(f.find.length > 120 ? f.find.slice(0, 120) + '...' : f.find)}`);
    }
  }

  // 4. SHA canary: did any watched file change since the baseline?
  const changedFiles = fetched.filter((f) => !f.missing && f.sha && BASELINE[f.label] && BASELINE[f.label] !== f.sha);
  const missingFiles = fetched.filter((f) => f.missing);

  // ── Output ────────────────────────────────────────────────────────
  const date = new Date().toISOString().slice(0, 10);
  console.log(`\n[Prompt drift canary - ${date}]`);
  console.log('Watched source: microsoft/vscode (main)\n');

  console.log(`RULES (${finds.length} distinct find strings across ${readdirSorted(REPL_DIR).filter(f => f.endsWith('.json')).length} files):`);
  console.log(lines.join('\n') || '  (none)');

  console.log('\nSHA CANARY (did a watched file change since the baseline?):');
  const shaLine = (f) => {
    if (f.missing) return `  [MISSING] ${f.label} -- renamed/moved/deleted?`;
    if (!BASELINE[f.label]) return `  [NEW]     ${f.label} -- no baseline pinned`;
    return BASELINE[f.label] === f.sha
      ? `  [OK]   ${f.label} (unchanged)`
      : `  [CHANGED] ${f.label} -- ${f.sha.slice(0, 12)}...`;
  };
  for (const f of fetched) console.log(shaLine(f));

  if (parseFailures.length) {
    console.log('\nPARSE WARNINGS (text extraction skipped; rules matching only in these files may false-flag):');
    for (const p of parseFailures) console.log(`  [SKIP] ${p}`);
  }

  const problems = deadRules + changedFiles.length + missingFiles.length;
  console.log(`\nResult: ${deadRules} dead rule(s), ${changedFiles.length} changed file(s), ${missingFiles.length} missing file(s).`);
  if (problems === 0) {
    console.log('All good - presets match the current Microsoft prompt source.');
  } else {
    console.log('Re-verify against a fresh systemMessageCapture, then run with --update-baseline to pin the new SHAs.');
    process.exitCode = 1;
  }

  // 5. Optional: pin the current SHAs as the new baseline (after manual review).
  // SHA drift itself must NOT block re-pinning: clearing drifted SHAs is the
  // entire purpose of this flag (the old `problems === 0` gate could only ever
  // fire when nothing had changed, i.e. never). Dead rules or missing files DO
  // block: those are real breakage to fix before re-baselining.
  if (updateBaseline && deadRules === 0 && missingFiles.length === 0) {
    const newMap = {};
    for (const f of fetched) if (!f.missing && f.sha) newMap[f.label] = f.sha;
    const block = Object.entries(newMap)
      .map(([k, v]) => `  '${k}': '${v}',`)
      .join('\n');
    const script = readFileSync(THIS_FILE, 'utf8');
    const replaced = script.replace(/\/\*baseline:start\*\/[\s\S]*?\/\*baseline:end\*\//, `/*baseline:start*/\nconst BASELINE = {\n${block}\n};\n/*baseline:end*/`);
    writeFileSync(THIS_FILE, replaced, 'utf8');
    console.log('\nBaseline updated in scripts/check-prompt-drift.mjs.');
  }
}

main().catch((err) => {
  console.error(`\n[ERROR] ${err.stack || err.message}\n`);
  process.exitCode = 1;
});
