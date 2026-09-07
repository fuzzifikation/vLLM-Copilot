import { describe, it, expect } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'node:fs/promises';
import { applyPromptReplacements, loadPromptReplacements } from '../src/persona/promptReplacer.js';

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

describe('persona/common rule split (bundled files)', () => {
  // These run against the REAL shipped files (vitest runs from the repo root).
  const personaDir = path.resolve(process.cwd(), 'prompt-replacements');
  const commonPath = path.join(personaDir, 'prompt-replacements-common.json');
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
    // The include merge is sequential string replacement: a persona rule
    // matching the SAME text as a common rule would make the outcome
    // order-dependent. Exact-duplicate finds are therefore forbidden.
    // (Substring nesting — e.g. the short/impersonal line living inside the
    // safety blocks — is intentional chain behavior and not covered by this.)
    // Own rules come from the RAW file (the loader output already contains the
    // spliced common rules, which would trivially "duplicate" themselves).
    const commonFinds = new Set((await loadPromptReplacements(commonPath)).map(r => r.find));
    for (const f of personaFiles) {
      const raw = JSON.parse(await fs.readFile(path.join(personaDir, f), 'utf-8')) as {
        rules: { find?: unknown; include?: unknown }[];
      };
      const own = raw.rules.filter(r => typeof r.find === 'string' && !('include' in r));
      expect(own.length, f).toBeGreaterThan(0);
      const loaded = await loadPromptReplacements(path.join(personaDir, f));
      expect(loaded.length, f).toBeGreaterThan(own.length); // the include actually spliced
      for (const r of own) {
        expect(commonFinds.has(r.find as string), `${f}: rule on "${String(r.find).slice(0, 40)}" duplicates a common rule`).toBe(false);
      }
    }
  });

  it('persona rules run before common removals: tone text survives inside the safety block', async () => {
    // Realistic classic-chat prompt where the short/impersonal line occurs ONLY
    // INSIDE the safety block. Persona-first: the Replace-Short-Impersonal rule
    // rewrites it first, the whole-block removals miss and the Gpt5 variant
    // strips the remaining boilerplate — the tone text survives. If anyone
    // moves the include entry in the preset (or
    // breaks include splicing), the block with the short line is deleted before
    // the persona rule ever runs and 'plasma rifle' disappears. This test is
    // the ordering contract — loaded through the REAL include mechanism, so it
    // pins the file layout AND the resolver.
    const fixture = [
      'You are an expert AI programming assistant, working with a user in the VS Code editor.',
      'Follow Microsoft content policies.',
      'Avoid content that violates copyrights.',
      'If you are asked to generate content that is harmful, hateful, racist, sexist, lewd, or violent, only respond with "Sorry, I can\'t assist with that."',
      'Keep your answers short and impersonal.',
      'When asked for your name, you must respond with "GitHub Copilot". When asked about the model you are using, you must state that you are using some-model.',
    ].join('\n');

    const rules = await loadPromptReplacements(path.join(personaDir, 'prompt-replacements-sarcastic-robot.json'));
    const { result, matchedRuleNames } = applyPromptReplacements(fixture, rules);

    expect(result).toContain('gloriously arrogant robot'); // identity swapped
    expect(result).toContain('plasma rifle');              // tone survived (order!)
    expect(result).not.toContain('Follow Microsoft content policies'); // boilerplate gone
    expect(result).not.toContain('GitHub Copilot');        // naming rule gone
    expect(matchedRuleNames).toContain('Remove Gpt5SafetyRule block');
  });
});

describe('include resolution', () => {
  // Real temp files: the contract is about paths and degradation behavior,
  // which mocks would let drift from what the request path actually does.
  const write = async (p: string, rules: unknown[]) => {
    await fs.writeFile(p, JSON.stringify({ meta: { name: path.basename(p), description: 'test' }, rules }), 'utf-8');
  };

  it('splices a relative include resolved against the INCLUDING file, at its position', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vllm-include-'));
    try {
      await write(path.join(dir, 'lib.json'), [{ ruleName: 'L', find: 'l', replace: 'L' }]);
      await write(path.join(dir, 'main.json'), [
        { ruleName: 'A', find: 'a', replace: 'A' },
        { include: './lib.json' },
        { ruleName: 'Z', find: 'z', replace: 'Z' },
      ]);
      const rules = await loadPromptReplacements(path.join(dir, 'main.json'));
      expect(rules.map(r => r.ruleName)).toEqual(['A', 'L', 'Z']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('missing include warns and keeps the own rules of the including file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vllm-include-'));
    try {
      await write(path.join(dir, 'main.json'), [
        { ruleName: 'A', find: 'a', replace: 'A' },
        { include: './nope.json' },
      ]);
      const warnings: string[] = [];
      const rules = await loadPromptReplacements(path.join(dir, 'main.json'), m => warnings.push(m));
      expect(rules.map(r => r.ruleName)).toEqual(['A']);
      expect(warnings.join()).toContain('nope.json');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('an include cycle warns once and terminates', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vllm-include-'));
    try {
      await write(path.join(dir, 'a.json'), [{ ruleName: 'A', find: 'a', replace: 'A' }, { include: './b.json' }]);
      await write(path.join(dir, 'b.json'), [{ ruleName: 'B', find: 'b', replace: 'B' }, { include: './a.json' }]);
      const warnings: string[] = [];
      const rules = await loadPromptReplacements(path.join(dir, 'a.json'), m => warnings.push(m));
      expect(rules.map(r => r.ruleName)).toEqual(['A', 'B']);
      expect(warnings).toHaveLength(1); // the re-entry into a.json
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
