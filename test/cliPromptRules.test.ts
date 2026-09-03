/**
 * CLI all-fire contract (static half of CLI drift detection).
 *
 * The Agents-window (Copilot CLI runtime) prompt is a different surface from
 * classic Copilot chat, and its source is not public. Rules anchored on it are
 * tagged `"scope": "cli"` in the replacement files. Unlike classic rules (which
 * may legitimately no-op on other surfaces), CLI-scoped rules have an ALL-FIRE
 * contract: every one of them must match the known CLI prompt exactly once.
 * A rule that stopped matching means the checked-in anchor reference went stale
 * — regenerate it per docs/custom-system-prompt.md ("CLI prompt drift").
 *
 * The live half (detecting Microsoft changing the prompt upstream) is manual:
 * `npm run check:cli-rules` against a fresh systemMessageCapture.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'path';
import { applyPromptReplacements, getBundledCommonReplacementsPath } from '../src/persona/promptReplacer.js';

interface RawRule { ruleName?: string; find: string; replace: string; scope?: string }

const commonPath = getBundledCommonReplacementsPath();
const personaDir = path.dirname(commonPath);
const referencePath = path.resolve(personaDir, '..', 'scripts', 'cli-prompt-reference.txt');
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
const commonCli = commonRules.filter(r => r.scope === 'cli');

describe('CLI all-fire contract (vs checked-in anchor reference)', () => {
  it('reference file exists and carries the CLI anchor regions', () => {
    expect(reference).toContain('region: identity-opener');
    expect(reference).toContain('Copilot CLI runtime');
  });

  for (const file of personaFiles) {
    const short = file.replace('prompt-replacements-', '').replace('.json', '');
    describe(short, () => {
      const rules = rawRules(path.join(personaDir, file));
      const cliRules = rules.filter(r => r.scope === 'cli');

      if (file.includes('raw')) {
        it('raw ships only CLI removals — identity opener and tone line (no voice injected)', () => {
          expect(cliRules.map(r => r.ruleName)).toEqual([
            'Remove CLI tone instruction (CLI)',
            'Remove CLI identity opener (CLI)',
          ]);
          expect(cliRules.every(r => r.replace === '')).toBe(true);
        });
      }

      it('every CLI rule anchors exactly once in the reference', () => {
        for (const r of [...cliRules, ...commonCli]) {
          expect(countOccurrences(reference, r.find), `${r.ruleName} occurrences`).toBe(1);
        }
      });

      it('all CLI rules fire in the persona+common chain and the invariants hold', () => {
        const { result, matchedRuleNames } = applyPromptReplacements(reference, [...rules, ...commonRules]);
        const expected = [...cliRules, ...commonCli].map(r => r.ruleName ?? '(unnamed)');
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
        expect(result).not.toContain('you must state that you are an AI assistant using Copilot CLI');
        // Code-change rules are rewritten (report-but-don't-fix), not deleted.
        expect(result).toContain('<rules_for_code_changes>');
        expect(result).toContain('an unverified "it works" is a guess');
        // Voice personas swap the CLI opener into their own voice and own the tail.
        // (Raw has no CLI rules at all: the neutral tail line survives there by design.)
        if (!file.includes('raw')) {
          const personaVoice = cliRules.find(r => r.ruleName === 'CLI Identity')!.replace;
          expect(result).toContain(personaVoice.slice(0, 48));
          expect(result).toContain('<personalityGuidelines>');
          expect(result).toContain('<personalityReminder>');
          expect(result).not.toContain('Respond concisely to the user, but be thorough in your work.');
        }
      });
    });
  }
});
