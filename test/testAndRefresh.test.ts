import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { groupModelsByServer, registerTestAndRefreshModelsCommand } from '../src/commands/testAndRefresh.js';
import * as diagnostics from '../src/diagnostics.js';
import type { ModelConfig } from '../src/config.js';

describe('groupModelsByServer', () => {
  it('groups models sharing the same server entry', () => {
    const models: ModelConfig[] = [
      { id: 'm1', server: 'srv' },
      { id: 'm2', server: 'srv' },
    ];
    const groups = groupModelsByServer(models, [{ id: 'srv', serverUrl: 'http://s:8000' }]);
    expect(groups).toHaveLength(1);
    expect(groups[0].models).toHaveLength(2);
  });

  it('separates models on different server entries', () => {
    const models: ModelConfig[] = [
      { id: 'm1', server: 'a' },
      { id: 'm2', server: 'b' },
    ];
    const groups = groupModelsByServer(models, [
      { id: 'a', serverUrl: 'http://a:8000' },
      { id: 'b', serverUrl: 'http://b:8000' },
    ]);
    expect(groups).toHaveLength(2);
  });

  it('separates entries on one URL that use different headers', () => {
    const models: ModelConfig[] = [
      { id: 'm1', server: 's1' },
      { id: 'm2', server: 's2' },
    ];
    const groups = groupModelsByServer(models, [
      { id: 's1', serverUrl: 'http://srv:8000', requestHeaders: { 'X-Key': 'a' } },
      { id: 's2', serverUrl: 'http://srv:8000', requestHeaders: { 'X-Key': 'b' } },
    ]);
    expect(groups).toHaveLength(2);
  });

  it('keeps two entries for one URL as two groups (entry id is the identity)', () => {
    // Even when two entries' URL spellings normalize to the same server, they
    // are separate registry entries — separate identities, separate probes.
    // (Redundant, yes: `validateConfig` warns about it. Deduplicating here
    // would resurrect the fingerprint grouping this design retired.)
    const models: ModelConfig[] = [
      { id: 'a', server: 'e1' },
      { id: 'b', server: 'e2' },
    ];
    const groups = groupModelsByServer(models, [
      { id: 'e1', serverUrl: 'http://s:8000' },
      { id: 'e2', serverUrl: 'http://s:8000/v1/' },
    ]);
    expect(groups).toHaveLength(2);
    // Each group carries the URL the probe fetches through — canonical, so the
    // caller doesn't have to normalize again.
    for (const g of groups) expect(g.serverUrl).toBe('http://s:8000');
  });

  it('gives each model with an unresolvable server ref its own group', () => {
    const models: ModelConfig[] = [
      { id: 'no-url-1', server: 'gone' },
      { id: 'no-url-2', server: 'gone' },
    ];
    const groups = groupModelsByServer(models, []);
    expect(groups).toHaveLength(2);
    for (const g of groups) {
      expect(g.serverUrl).toBe('');
      expect(g.models).toHaveLength(1);
    }
  });

  it('mixes resolvable and dangling models correctly', () => {
    const models: ModelConfig[] = [
      { id: 'm1', server: 'srv' },
      { id: 'no-url', server: 'gone' },
      { id: 'm2', server: 'srv' },
    ];
    const groups = groupModelsByServer(models, [{ id: 'srv', serverUrl: 'http://s:8000' }]);
    // Two groups: one for the server, one for the dangling model
    const serverGroup = groups.find(g => g.serverUrl !== '');
    const noUrlGroup = groups.find(g => g.serverUrl === '');
    expect(serverGroup?.models).toHaveLength(2);
    expect(noUrlGroup?.models).toHaveLength(1);
  });
});
