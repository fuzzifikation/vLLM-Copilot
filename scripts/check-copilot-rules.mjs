#!/usr/bin/env node
/**
 * Live Copilot-harness replacement audit — the live half of Copilot prompt drift
 * detection, and the only instrument that can see Microsoft change that prompt.
 *
 * Reads a system-message capture (written by `vllm-copilot.systemMessageCapture`
 * to .vllm/system-messages.json after an Agents-window turn) and checks every
 * `scope: "copilot"` rule against the REAL current harness prompt. Harness entries
 * are identified by wording that survived Microsoft's "Copilot CLI runtime" →
 * "Copilot SDK" rename (scripts/copilot-prompt-wording.mjs), so a rename can no
 * longer turn this audit into a green run that checked nothing:
 *
 *   DEAD ANCHOR  — the rule's `find` text is gone from the captured prompt.
 *                  Microsoft changed the Copilot harness prompt. Definitive drift:
 *                  fix the rule, then regenerate the reference (see docs). Exit 1.
 *   NOT FIRED    — the anchor text exists but the rule name is absent from the
 *                  capture's rulesApplied. Usually just means that persona was
 *                  not active during the capture. With --persona <file> it is a
 *                  hard failure instead (all rules of that persona + common
 *                  must fire on a harness prompt).
 *   DORMANT [--]  — the rule carries a `"wording"` tag and the capture is a
 *                  different one: the prompt moved, the rule did not. Informational,
 *                  never counted — presets support the CURRENT harness wording
 *                  only, so on a superseded capture this is what "your VS Code is
 *                  older" looks like (the personality genuinely does not apply
 *                  there). An UNTAGGED Copilot rule anchors boilerplate every
 *                  wording shares and is always checked.
 *
 * Usage:
 *   npm run check:copilot-rules                          # .vllm/system-messages.json
 *   node scripts/check-copilot-rules.mjs <capture.json>  # any capture file
 *   node scripts/check-copilot-rules.mjs --persona prompt-replacements/prompt-replacements-sarcastic-robot.json
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copilotPromptWording, MARKER_HINT } from './copilot-prompt-wording.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPL_DIR = path.join(ROOT, 'prompt-replacements');
// Harness-prompt detection lives in copilot-prompt-wording.mjs, shared with
// extract-copilot-reference.mjs: the old literal here was the string Microsoft
// renamed, and the auditor happily "found no harness messages" in a capture that
// was full of them.

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
const copilotEntries = entries.filter(e => copilotPromptWording(e.receivedContent));
if (copilotEntries.length === 0) {
  console.log(`No harness (Agents-window) prompt in ${path.relative(ROOT, capturePath)} — ${entries.length} other system message(s) seen.`);
  console.log(`Matched on: ${MARKER_HINT}`);
  console.log('Nothing to check: capture an Agents-window turn first. This is NOT a pass.');
  process.exit(0);
}

const personaPath = personaFlag
  ? path.resolve(ROOT, personaFlag)
  : null;
const personaBase = personaPath ? path.basename(personaPath) : null;

/** All Copilot-harness rules: common always; personas when no --persona given (advisory) or just that one (strict). */
const loadRules = (file) => {
  const obj = JSON.parse(readFileSync(file, 'utf8'));
  return (Array.isArray(obj) ? obj : obj.rules).filter(r => r.scope === 'copilot');
};
const commonCopilot = loadRules(path.join(REPL_DIR, 'prompt-replacements-common.json'));
const personaFiles = readdirSync(REPL_DIR)
  .filter(f => f.endsWith('.json') && f !== 'prompt-replacements-common.json')
  .filter(f => (personaBase ? f === personaBase : true));
const personaCopilot = personaFiles.flatMap(f => loadRules(path.join(REPL_DIR, f)).map(r => ({ ...r, file: f })));
const strict = !!personaBase;

// ── Check ───────────────────────────────────────────────────────────
let dead = 0;
let dormant = 0;
let strictMiss = 0;
const firedNames = new Set(copilotEntries.flatMap(e => e.rulesApplied ?? []));
const anchorIn = (find) => copilotEntries.some(e => e.receivedContent.includes(find));
/** Which harness wording this capture carries; preset rules tagged for the other
 *  one are dormant here, not dead — both wordings are live in the wild. */
const gen = copilotPromptWording(copilotEntries[0].receivedContent);

const report = (rules, { strictMode }) => {
  for (const r of rules) {
    const present = anchorIn(r.find);
    const fired = firedNames.has(r.ruleName);
    const label = `${r.ruleName}${r.file ? ` (${r.file.replace('prompt-replacements-', '').replace('.json', '')})` : ''}`;
    const target = r.wording;
    if (target && target !== gen) {
      dormant++;
      console.log(`  [--]   ${label} — written for the "${target}" harness wording, this capture is "${gen}" (dormant, not dead)`);
      continue;
    }
    if (!present) {
      dead++;
      console.log(`  [DEAD] ${label} — anchor text MISSING from the captured "${gen}" harness prompt (Microsoft drift)`);
    } else if (!fired) {
      if (strictMode) { strictMiss++; console.log(`  [MISS] ${label} — anchor present but rule did not fire`); }
      else console.log(`  [no]   ${label} — anchor alive, not in rulesApplied (fine if that persona was not active)`);
    } else {
      console.log(`  [OK]   ${label}`);
    }
  }
};

console.log(`[Copilot-harness rule audit] ${copilotEntries.length} harness message(s) from ${path.relative(ROOT, capturePath)} — wording: "${gen}"`);
console.log('Common Copilot-harness rules:');
report(commonCopilot, { strictMode: strict });
console.log(`Persona Copilot-harness rules${strict ? ` (${personaBase}, strict)` : ' (all personas, advisory)'}:`);
report(personaCopilot, { strictMode: strict });

console.log(`\nResult: ${dead} dead anchor(s), ${strictMiss} missed fire(s), ${dormant} dormant variant(s) for the other harness wording${strict ? '' : ' (advisory mode: misses ignored)'}.`);
if (dead || strictMiss) {
  console.log('Dead anchor: verify with a fresh capture, update the rule, then regenerate');
  console.log('scripts/copilot-prompt-reference.txt (scripts/extract-copilot-reference.mjs) and run npm test.');
}
process.exit(dead || strictMiss ? 1 : 0);
