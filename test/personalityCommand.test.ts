import { describe, it, expect } from 'vitest';
import { personalityApplicableTo } from '../src/commands.js';
import type { ModelConfig } from '../src/config.js';

/**
 * Server-less models must never reach saveModelConfig from the personality
 * command: the config matcher requires both id and serverUrl, so without a
 * serverUrl the store falls through to its append branch and writes a duplicate
 * entry into settings.json (verified bug, fixed as step 0a of the refactor plan).
 */
describe('personalityApplicableTo', () => {
  it('rejects a model without a serverUrl (prevents duplicate append)', () => {
    const result = personalityApplicableTo({ id: 'm', displayName: 'M' } as ModelConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no serverUrl');
  });

  it('rejects a blank/whitespace-only serverUrl', () => {
    expect(personalityApplicableTo({ id: 'm', serverUrl: '   ' } as ModelConfig).ok).toBe(false);
  });

  it('accepts a model with a serverUrl', () => {
    expect(personalityApplicableTo({ id: 'm', serverUrl: 'http://x:8000' } as ModelConfig).ok).toBe(true);
  });

  it('uses displayName then id in the warning label', () => {
    const byDisplay = personalityApplicableTo({ id: 'm', displayName: 'My Model' } as ModelConfig);
    if (!byDisplay.ok) expect(byDisplay.reason).toContain('My Model');
    const byId = personalityApplicableTo({ id: 'm' } as ModelConfig);
    if (!byId.ok) expect(byId.reason).toContain('"m"');
  });
});
