#!/usr/bin/env node
/**
 * Extract the CLI-prompt anchor regions from a system-message capture.
 *
 * The Agents-window (Copilot CLI runtime) system prompt is ~41 KB, of which
 * only a handful of regions are relevant to our prompt replacements: the
 * identity opener, the code-change rules, the security block, the commit
 * trailer, the gh-CLI preference, the style block and the closing tone line.
 * Everything else (tool schemas, the embedded workspace instructions, the
 * volatile session-context manifest) is user- or session-specific noise that
 * must NOT end up in a checked-in drift reference.
 *
 * Output: a small plain-text reference (default scripts/cli-prompt-reference.txt)
 * containing exactly those regions, plus human-readable region markers.
 * The drift canary (check-prompt-drift.mjs) verifies every `scope: "cli"` rule
 * find against this file instead of live GitHub (the CLI prompt source is not
 * public). When personalities act weird in the Agents window: enable
 * `vllm-copilot.systemMessageCapture`, run one Agents-window turn, re-run this
 * script against the new capture, and `git diff` the reference.
 *
 * Usage:
 *   node scripts/extract-cli-reference.mjs [capture.json] [out.txt]
 * Default capture: .vllm/system-messages.json in this workspace (written by
 * `vllm-copilot.systemMessageCapture` after an Agents-window turn).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CAPTURE = process.argv[2] ?? path.join(ROOT, '.vllm', 'system-messages.json');
const OUT = process.argv[3] ?? path.join(ROOT, 'scripts', 'cli-prompt-reference.txt');

/** Regions we anchor rules on: [label, startMarker, endMarker, includeEndMarker]. */
const REGIONS = [
  // NOTE: the <style> block is nested INSIDE <code_change_instructions> upstream, so the
  // code region below is anchored on the INNER rules block only — anchoring on the outer
  // tag would swallow the style region and duplicate it in the reference.
  ['identity-opener', null, '\n\n', 'line0'],
  ['code-change-rules', '<rules_for_code_changes>', '</rules_for_code_changes>', true],
  ['security-block', '<prohibited_actions>', '</prohibited_actions>', true],
  ['git-commit-trailer', '<git_commit_trailer>', '</git_commit_trailer>', true],
  ['gh-cli-preference', '<gh_cli_preference>', '</gh_cli_preference>', true],
  ['style-block', '<style>', '</style>', true],
];
/** Fixed closing tone line (matched verbatim by persona tail rules). */
const TAIL = 'Respond concisely to the user, but be thorough in your work.';

function extractRegions(text) {
  const out = {};
  for (const [label, startMark, endMark, mode] of REGIONS) {
    let region;
    if (mode === 'line0') {
      // The opener is the first paragraph: text before the first blank line.
      const idx = text.indexOf(endMark);
      if (idx === -1) throw new Error(`no paragraph break found (region ${label})`);
      region = text.slice(0, idx);
    } else {
      const s = text.indexOf(startMark);
      const e = text.indexOf(endMark, s);
      if (s === -1 || e === -1) throw new Error(`region ${label}: markers not found`);
      region = text.slice(s, e + endMark.length);
    }
    out[label] = region;
  }
  // Tail must exist verbatim somewhere (it is a lone closing line).
  const tailCount = text.split(TAIL).length - 1;
  if (tailCount < 1) throw new Error(`tail line not found in capture`);
  out['tone-tail'] = TAIL;
  return out;
}

const raw = JSON.parse(readFileSync(CAPTURE, 'utf8'));
const allEntries = Array.isArray(raw) ? raw : [raw];
if (allEntries.length === 0) throw new Error('capture file contains no entries');

// A capture holds every system message seen while systemMessageCapture was on:
// classic Copilot chat turns, CLI (Agents-window) turns, anything else. Only the
// CLI runtime prompt is anchored here, so non-CLI entries are ignored — without
// this filter a session that used classic chat before the Agents turn puts a
// classic system message at entries[0] and every marker lookup fails.
const CLI_MARKER = 'using Copilot CLI runtime';
const entries = allEntries.filter((e) => (e.receivedContent || '').includes(CLI_MARKER));
if (entries.length === 0) {
  throw new Error(
    `no capture entry contains "${CLI_MARKER}" — the capture holds no Agents-window (CLI runtime) ` +
    'turn. Enable vllm-copilot.systemMessageCapture, run one Agents-window turn, and re-run.'
  );
}
if (entries.length < allEntries.length) {
  console.log(`filtered ${allEntries.length - entries.length} non-CLI capture entry(ies)`);
}

const first = extractRegions(entries[0].receivedContent);
for (let i = 1; i < entries.length; i++) {
  const other = extractRegions(entries[i].receivedContent);
  for (const label of Object.keys(first)) {
    if (other[label] !== first[label]) {
      throw new Error(`region "${label}" differs between capture entries 0 and ${i} — prompt changed mid-capture, re-capture cleanly`);
    }
  }
}

const header = [
  '# CLI prompt anchor regions — extracted from a systemMessageCapture of Agents-window turns',
  '# (all capture entries byte-identical in these regions; see file history for provenance).',
  '# Generated by scripts/extract-cli-reference.mjs. Do not hand-edit.',
  '# Checked by scripts/check-prompt-drift.mjs against every rule with "scope": "cli".',
  '',
].join('\n');
const body = Object.entries(first)
  .map(([label, text]) => `# ---- region: ${label} ----\n${text}`)
  .join('\n\n');
writeFileSync(OUT, header + body + '\n', 'utf8');
console.log(`Wrote ${path.relative(ROOT, OUT)}: ${Object.keys(first).length} regions from ${entries.length} capture entries`);
for (const [label, text] of Object.entries(first)) {
  console.log(`  ${label}: ${text.length} chars`);
}
