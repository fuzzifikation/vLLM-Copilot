import { describe, it, expect, afterEach } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'node:fs/promises';
import { applyPromptReplacements, loadPromptReplacements, loadPersonalityMeta } from '../src/promptReplacer.js';

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
