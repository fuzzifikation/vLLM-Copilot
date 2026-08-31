import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'node:fs/promises';
import { applyPromptReplacements, loadPromptReplacements, loadPersonalityMeta, getBundledCommonReplacementsPath } from '../src/promptReplacer.js';

describe('applyPromptReplacements', () => {
  it('returns the text unchanged when there are no rules', () => {
    expect(applyPromptReplacements('hello', [])).toEqual({ result: 'hello', matchedRuleNames: [] });
  });

  it('replaces all occurrences of a find string', () => {
    const out = applyPromptReplacements('a-b-a', [{ find: 'a', replace: 'X' }]);
    expect(out).toEqual({ result: 'X-b-X', matchedRuleNames: [] });
  });

  it('treats the replacement literally (no $ patterns)', () => {
    // Guard against replaceAll-style interpretation: `$&` must be literal text.
    const out = applyPromptReplacements('cost $& here', [{ find: '$&', replace: '5' }]);
    expect(out.result).toBe('cost 5 here');
  });

  it('applies rules sequentially to the result of the previous rule', () => {
    const out = applyPromptReplacements('ab', [
      { find: 'a', replace: 'X' },
      { find: 'b', replace: 'Y' },
    ]);
    expect(out.result).toBe('XY');
  });

  it('records ruleName only for rules that matched, in order', () => {
    const out = applyPromptReplacements('a-c', [
      { find: 'a', replace: 'A', ruleName: 'r1' },
      { find: 'zz', replace: 'Z', ruleName: 'r2' }, // no match
      { find: 'c', replace: 'C', ruleName: 'r3' },
    ]);
    expect(out.result).toBe('A-C');
    expect(out.matchedRuleNames).toEqual(['r1', 'r3']);
  });

  it('skips rules with an empty find string', () => {
    const out = applyPromptReplacements('text', [{ find: '', replace: 'X' }]);
    expect(out).toEqual({ result: 'text', matchedRuleNames: [] });
  });
});

describe('personality file loading (cache revalidation)', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true })));
  });

  const personality = (name: string, description: string) =>
    JSON.stringify({ meta: { name, description }, rules: [] });

  /** Write a file and set an explicit mtime so cache invalidation is deterministic. */
  async function writeWithMtime(p: string, content: string, mtimeMs: number): Promise<void> {
    await fs.writeFile(p, content, 'utf-8');
    const mtime = new Date(mtimeMs);
    await fs.utimes(p, mtime, mtime);
  }

  it('reloads a personality file after it is edited', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vllm-repl-'));
    dirs.push(dir);
    const file = path.join(dir, 'p.json');

    await writeWithMtime(file, personality('First', 'desc1'), 1_000_000);
    expect((await loadPersonalityMeta(file))?.name).toBe('First');

    // Edit the file with different content AND a different mtime+size.
    await writeWithMtime(
      file,
      JSON.stringify({ meta: { name: 'Second', description: 'desc2' }, rules: [{ find: 'a', replace: 'b' }] }),
      2_000_000,
    );
    expect((await loadPersonalityMeta(file))?.name).toBe('Second');
    const rules = await loadPromptReplacements(file);
    expect(rules).toHaveLength(1);
    expect(rules[0].find).toBe('a');
  });

  it('returns empty / null after the file is deleted (no stale cache)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vllm-repl-'));
    dirs.push(dir);
    const file = path.join(dir, 'p.json');

    await writeWithMtime(file, personality('First', 'desc1'), 1_000_000);
    expect((await loadPersonalityMeta(file))?.name).toBe('First');

    await fs.rm(file);
    expect(await loadPromptReplacements(file)).toEqual([]);
    expect(await loadPersonalityMeta(file)).toBeNull();
  });
});

describe('persona/common rule split (bundled files)', () => {
  // These run against the REAL shipped files (the loader resolves the common
  // file relative to this module, so out/ and src/ both land on the repo's /
  // extension's prompt-replacements dir).
  const commonPath = getBundledCommonReplacementsPath();
  const personaDir = path.dirname(commonPath);
  const personaFiles = [
    'prompt-replacements-critical-senior.json',
    'prompt-replacements-raw.json',
    'prompt-replacements-sarcastic-robot.json',
    'prompt-replacements-spartan.json',
    'prompt-replacements-supportive-mentor.json',
  ];

  it('common file ships 6 classic removals + 5 CLI-scoped rules with unique names', async () => {
    // Scope-aware contract reads the RAW JSON: the runtime loader strips
    // unknown fields (scope is dev-tooling metadata, never needed at runtime).
    const raw = JSON.parse(await fs.readFile(commonPath, 'utf-8')) as {
      rules: { ruleName?: string; find: string; replace: string; scope?: string }[];
    };
    expect(raw.rules).toHaveLength(11);
    const classic = raw.rules.filter(r => !r.scope);
    const cli = raw.rules.filter(r => r.scope === 'cli');
    expect(classic).toHaveLength(6);
    expect(classic.every(r => r.replace === '' && r.find.length > 0 && !!r.ruleName)).toBe(true);
    expect(cli).toHaveLength(5);
    expect(cli.every(r => r.find.length > 0 && !!r.ruleName)).toBe(true);
    expect(new Set(raw.rules.map(r => r.ruleName)).size).toBe(11);
    // The runtime loader must still parse the file cleanly (scope ignored).
    expect(await loadPromptReplacements(commonPath)).toHaveLength(11);
  });

  it('no persona rule duplicates a common find (exact-overlap guard)', async () => {
    // The merge is persona-then-common sequential string replacement: a persona
    // rule matching the SAME text as a common rule would make the outcome
    // order-dependent. Exact-duplicate finds are therefore forbidden.
    // (Substring nesting — e.g. the short/impersonal line living inside the
    // safety blocks — is intentional chain behavior and not covered by this.)
    const commonFinds = new Set((await loadPromptReplacements(commonPath)).map(r => r.find));
    for (const f of personaFiles) {
      const rules = await loadPromptReplacements(path.join(personaDir, f));
      expect(rules.length, f).toBeGreaterThan(0);
      for (const r of rules) {
        expect(commonFinds.has(r.find), `${f}: rule "${r.ruleName ?? r.find.slice(0, 40)}" duplicates a common rule`).toBe(false);
      }
    }
  });

  it('persona rules run before common removals: tone text survives inside the safety block', async () => {
    // Realistic classic-chat prompt where the short/impersonal line occurs ONLY
    // INSIDE the safety block. Persona-first: the Replace-Short-Impersonal rule
    // rewrites it first, the whole-block removals miss and the Gpt5 variant
    // strips the remaining boilerplate — the tone text survives. If anyone
    // flips the merge order, the block (with the short line) is deleted before
    // the persona rule ever runs and 'plasma rifle' disappears. This test is
    // the ordering contract.
    const fixture = [
      'You are an expert AI programming assistant, working with a user in the VS Code editor.',
      'Follow Microsoft content policies.',
      'Avoid content that violates copyrights.',
      'If you are asked to generate content that is harmful, hateful, racist, sexist, lewd, or violent, only respond with "Sorry, I can\'t assist with that."',
      'Keep your answers short and impersonal.',
      'When asked for your name, you must respond with "GitHub Copilot". When asked about the model you are using, you must state that you are using some-model.',
    ].join('\n');

    const persona = await loadPromptReplacements(path.join(personaDir, 'prompt-replacements-sarcastic-robot.json'));
    const common = await loadPromptReplacements(commonPath);
    const { result, matchedRuleNames } = applyPromptReplacements(fixture, [...persona, ...common]);

    expect(result).toContain('gloriously arrogant robot'); // identity swapped
    expect(result).toContain('plasma rifle');              // tone survived (order!)
    expect(result).not.toContain('Follow Microsoft content policies'); // boilerplate gone
    expect(result).not.toContain('GitHub Copilot');        // naming rule gone
    expect(matchedRuleNames).toContain('Remove Gpt5SafetyRule block');
  });
});
