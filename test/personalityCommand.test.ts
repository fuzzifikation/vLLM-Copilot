import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { personalityApplicableTo } from '../src/commands.js';
import { registerSetModelPersonalityCommand } from '../src/commands/personality.js';
import * as configStore from '../src/configStore.js';
import * as personalityStore from '../src/personalityStore.js';
import type { ModelConfig } from '../src/config.js';

/**
 * Server-less models must never reach saveModelConfig from the personality
 * command: the config matcher requires both id and server ref, so without a
 * resolvable ref the store falls through to its append branch and writes a
 * duplicate entry into settings.json (verified bug, fixed as step 0a of the
 * refactor plan; the ref now also has to RESOLVE against the registry).
 */
const SERVERS = [{ id: 'srv', serverUrl: 'http://x:8000' }];

describe('personalityApplicableTo', () => {
  it('rejects a model without a server ref (prevents duplicate append)', () => {
    const result = personalityApplicableTo({ id: 'm', displayName: 'M' } as ModelConfig, SERVERS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no resolvable server');
  });

  it('rejects a blank/whitespace-only server ref', () => {
    expect(personalityApplicableTo({ id: 'm', server: '   ' } as ModelConfig, SERVERS).ok).toBe(false);
  });

  it('rejects a model whose server ref dangles', () => {
    expect(personalityApplicableTo({ id: 'm', server: 'ghost' } as ModelConfig, SERVERS).ok).toBe(false);
  });

  it('accepts a model with a resolvable server ref', () => {
    expect(personalityApplicableTo({ id: 'm', server: 'srv' } as ModelConfig, SERVERS).ok).toBe(true);
  });

  it('uses displayName then id in the warning label', () => {
    const byDisplay = personalityApplicableTo({ id: 'm', displayName: 'My Model' } as ModelConfig, SERVERS);
    if (!byDisplay.ok) expect(byDisplay.reason).toContain('My Model');
    const byId = personalityApplicableTo({ id: 'm' } as ModelConfig, SERVERS);
    if (!byId.ok) expect(byId.reason).toContain('"m"');
  });
});
