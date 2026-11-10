/**
 * Copilot-harness all-fire contract (static half of Copilot prompt drift detection).
 *
 * Copilot drives two prompt surfaces. The Local harness (VS Code's own prompt
 * assembly, main window) has public source; the Copilot harness (Agent Host, Agents
 * window — the prompt the code long called "CLI") does not. Rules targeting the
 * Copilot harness are tagged `"scope": "copilot"`; Local-harness rules carry no
 * `scope` key. Unlike Local rules (which may legitimately no-op on the other
 * surface), Copilot-harness rules have an ALL-FIRE contract: every one of them must
 * match the checked-in reference prompt exactly once. A rule that stopped matching
 * means the anchor reference went stale — regenerate it with
 * `npm run extract:copilot-reference` after a fresh capture.
 *
 * Microsoft renames this prompt's boilerplate ("Copilot CLI runtime" → "Copilot
 * SDK", 2026-11). Presets follow the CURRENT wording only: a rule anchored on
 * wording-specific text is tagged `"wording": "sdk"`, an untagged Copilot rule
 * anchors text every generation shares. When the wording moves, the anchored rules
 * are re-anchored in the same unit and the reference is regenerated — superseded
 * wording is deleted, never accumulated (owner ruling 2026-11-10).
 *
 * The live half (detecting Microsoft changing the prompt upstream) is manual:
 * `npm run check:copilot-rules` against a fresh systemMessageCapture.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'path';
import { applyPromptReplacements } from '../src/core/personality/promptReplacer.js';

interface RawRule { ruleName?: string; find: string; replace: string; scope?: string; wording?: string }

// Vitest runs from the repo root.
const personaDir = path.resolve(process.cwd(), 'prompt-replacements');
const commonPath = path.join(personaDir, 'prompt-replacements-common.json');
const referencePath = path.resolve(personaDir, '..', 'scripts', 'copilot-prompt-reference.txt');
const personaFiles = [
  'prompt-replacements-critical-senior.json',
  'prompt-replacements-raw.json',
  'prompt-replacements-sarcastic-robot.json',
  'prompt-replacements-spartan.json',
  'prompt-replacements-supportive-mentor.json',
];

const rawRules = (file: string): RawRule[] => {
  const obj = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return Array.isArray(obj) ? obj : obj.rules;
};

const countOccurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

// EOL-normalize: rule `find` strings come from JSON (`\n` escapes, always LF)
// and must match the reference byte-for-byte, but a Windows checkout with
// core.autocrlf=true can materialize the reference with CRLF. Without this
// normalization the multi-line finds match 0 times and the suite fails on a
// pristine checkout. (.gitattributes pins LF; this is the belt-and-braces.)
const reference = fs.readFileSync(referencePath, 'utf-8').replace(/\r\n/g, '\n');
const commonRules = rawRules(commonPath);
const commonCopilot = commonRules.filter(r => r.scope === 'copilot');

describe('Copilot-harness all-fire contract (vs checked-in anchor reference)', () => {
  it('reference file exists and carries the current harness wording', () => {
    expect(reference).toContain('region: identity-opener');
    expect(reference).toContain('Copilot SDK');
  });

  it('only the current harness wording is tagged', () => {
    // Superseded wordings are not supported: their rules are deleted with the
    // reference text, so a "wording": "cli" rule here means someone re-accumulated
    // history the owner already ruled out (docs/code-review.md).
    for (const file of [commonPath, ...personaFiles.map(f => path.join(personaDir, f))]) {
      for (const rule of rawRules(file).filter(r => r.scope === 'copilot')) {
        expect([undefined, 'sdk'], `${path.basename(file)} :: ${rule.ruleName} harness tag`)
          .toContain(rule.wording);
      }
    }
  });

  for (const file of personaFiles) {
    const short = file.replace('prompt-replacements-', '').replace('.json', '');
    describe(short, () => {
      const rules = rawRules(path.join(personaDir, file));
      const copilotRules = rules.filter(r => r.scope === 'copilot');

      if (file.includes('raw')) {
        it('raw ships only harness removals — identity opener and tone line (no voice injected)', () => {
          expect(copilotRules.map(r => r.ruleName)).toEqual([
            'Remove CLI tone instruction (CLI)',
            'Remove CLI identity opener (CLI)',
          ]);
          expect(copilotRules.every(r => r.replace === '')).toBe(true);
        });
      }

      it('every Copilot rule anchors exactly once in the reference', () => {
        for (const r of [...copilotRules, ...commonCopilot]) {
          expect(countOccurrences(reference, r.find), `${r.ruleName} occurrences`).toBe(1);
        }
      });

      it('all Copilot rules fire in the persona+common chain and the invariants hold', () => {
        const { result, matchedRuleNames } = applyPromptReplacements(reference, [...rules, ...commonRules]);
        const expected = [...copilotRules, ...commonCopilot].map(r => r.ruleName ?? '(unnamed)');
        for (const name of expected) {
          expect(matchedRuleNames, `rule "${name}" must fire`).toContain(name);
        }
        // Security philosophy: prohibited_actions replaced by user-owned protocol.
        expect(result).not.toContain('<prohibited_actions>');
        expect(result).toContain('<security_protocol>');
        expect(result).toContain("decisions belong to the user");
        // No self-assigned co-author credit survives.
        expect(result).not.toContain('Co-authored-by');
        // The bash assumption is fixed.
        expect(result).not.toContain('via bash');
        expect(result).toContain('in the terminal over MCP tools');
        // Identity re-registration is gone; no Copilot naming remains.
        expect(result).not.toContain('you must state that you are an AI assistant using Copilot SDK');
        // Code-change rules are rewritten (report-but-don't-fix), not deleted.
        expect(result).toContain('<rules_for_code_changes>');
        expect(result).toContain('an unverified "it works" is a guess');
        // Voice personas swap the harness opener into their own voice and own the tail.
        // (Raw carries removals only: the neutral tail line survives there by design.)
        if (!file.includes('raw')) {
          const personaVoice = copilotRules.find(r => r.ruleName === 'CLI Identity')!.replace;
          expect(result).toContain(personaVoice.slice(0, 48));
          expect(result).toContain('<personalityGuidelines>');
          expect(result).toContain('<personalityReminder>');
          expect(result).not.toContain('Respond concisely to the user, but be thorough in your work.');
        }
      });
    });
  }
});
