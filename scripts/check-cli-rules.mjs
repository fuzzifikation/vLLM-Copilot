#!/usr/bin/env node
/**
 * Live CLI replacement audit — the live half of CLI prompt drift detection.
 *
 * Reads a system-message capture (written by `vllm-copilot.systemMessageCapture`
 * to .vllm/system-messages.json after an Agents-window turn) and checks every
 * `scope: "cli"` rule against the REAL current CLI prompt:
 *
 *   DEAD ANCHOR  — the rule's `find` text is gone from the captured prompt.
 *                  Microsoft changed the CLI prompt. Definitive drift: fix the
 *                  rule, then regenerate the reference (see docs). Exit 1.
 *   NOT FIRED    — the anchor text exists but the rule name is absent from the
 *                  capture's rulesApplied. Usually just means that persona was
 *                  not active during the capture. With --persona <file> it is a
 *                  hard failure instead (all rules of that persona + common
 *                  must fire on a CLI prompt).
 *
 * Usage:
 *   npm run check:cli-rules                          # .vllm/system-messages.json
 *   node scripts/check-cli-rules.mjs <capture.json>  # any capture file
 *   node scripts/check-cli-rules.mjs --persona prompt-replacements/prompt-replacements-sarcastic-robot.json
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPL_DIR = path.join(ROOT, 'prompt-replacements');
const CLI_MARKER = 'using Copilot CLI runtime'; // identifies CLI-runtime messages

// ── Args ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const personaFlag = argv.includes('--persona') ? argv[argv.indexOf('--persona') + 1] : null;
const captureArg = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--persona');
const capturePath = captureArg ?? path.join(ROOT, '.vllm', 'system-messages.json');

// ── Load ────────────────────────────────────────────────────────────
if (!existsSync(capturePath)) {
  console.error(`Capture not found: ${capturePath}`);
  console.error('Enable vllm-copilot.systemMessageCapture, run one Agents-window turn, retry.');
  process.exit(1);
}
const entries = (() => {
  const raw = JSON.parse(readFileSync(capturePath, 'utf8'));
  return Array.isArray(raw) ? raw : [raw];
})();
const cliEntries = entries.filter(e => typeof e.receivedContent === 'string' && e.receivedContent.includes(CLI_MARKER));
if (cliEntries.length === 0) {
  console.log(`No CLI-runtime messages in ${path.relative(ROOT, capturePath)} (${entries.length} classic entries).`);
  console.log('Nothing to check — capture an Agents-window turn first.');
  process.exit(0);
}

const personaPath = personaFlag
  ? path.resolve(ROOT, personaFlag)
  : null;
const personaBase = personaPath ? path.basename(personaPath) : null;

/** All CLI-scoped rules: common always; personas when no --persona given (advisory) or just that one (strict). */
const loadRules = (file) => {
  const obj = JSON.parse(readFileSync(file, 'utf8'));
  return (Array.isArray(obj) ? obj : obj.rules).filter(r => r.scope === 'cli');
};
const commonCli = loadRules(path.join(REPL_DIR, 'prompt-replacements-common.json'));
const personaFiles = readdirSync(REPL_DIR)
  .filter(f => f.endsWith('.json') && f !== 'prompt-replacements-common.json')
  .filter(f => (personaBase ? f === personaBase : true));
const personaCli = personaFiles.flatMap(f => loadRules(path.join(REPL_DIR, f)).map(r => ({ ...r, file: f })));
const strict = !!personaBase;

// ── Check ───────────────────────────────────────────────────────────
let dead = 0;
let strictMiss = 0;
const firedNames = new Set(cliEntries.flatMap(e => e.rulesApplied ?? []));
const anchorIn = (find) => cliEntries.some(e => e.receivedContent.includes(find));

const report = (rules, { strictMode }) => {
  for (const r of rules) {
    const present = anchorIn(r.find);
    const fired = firedNames.has(r.ruleName);
    const label = `${r.ruleName}${r.file ? ` (${r.file.replace('prompt-replacements-', '').replace('.json', '')})` : ''}`;
    if (!present) {
      dead++;
      console.log(`  [DEAD] ${label} — anchor text MISSING from the captured CLI prompt (Microsoft drift)`);
    } else if (!fired) {
      if (strictMode) { strictMiss++; console.log(`  [MISS] ${label} — anchor present but rule did not fire`); }
      else console.log(`  [no]   ${label} — anchor alive, not in rulesApplied (fine if that persona was not active)`);
    } else {
      console.log(`  [OK]   ${label}`);
    }
  }
};

console.log(`[CLI rule audit] ${cliEntries.length} CLI message(s) from ${path.relative(ROOT, capturePath)}`);
console.log('Common CLI rules:');
report(commonCli, { strictMode: strict });
console.log(`Persona CLI rules${strict ? ` (${personaBase}, strict)` : ' (all personas, advisory)'}:`);
report(personaCli, { strictMode: strict });

console.log(`\nResult: ${dead} dead anchor(s), ${strictMiss} missed fire(s)${strict ? '' : ' (advisory mode: misses ignored)'}.`);
if (dead || strictMiss) {
  console.log('Dead anchor: verify with a fresh capture, update the rule, then regenerate');
  console.log('scripts/cli-prompt-reference.txt (scripts/extract-cli-reference.mjs) and run npm test.');
}
process.exit(dead || strictMiss ? 1 : 0);
