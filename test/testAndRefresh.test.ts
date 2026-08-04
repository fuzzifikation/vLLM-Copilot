import { describe, it, expect } from 'vitest';
import { serverFingerprint, groupModelsByServer } from '../src/commands.js';
import type { ModelConfig } from '../src/config.js';

describe('serverFingerprint', () => {
  it('produces same fingerprint for same URL + headers', () => {
    const a = serverFingerprint('http://host:8000', { Authorization: 'Bearer x', 'X-Custom': 'val' });
    const b = serverFingerprint('http://host:8000', { 'X-Custom': 'val', Authorization: 'Bearer x' });
    expect(a).toBe(b);
  });

  it('differs when URL changes', () => {
    const a = serverFingerprint('http://a:8000', {});
    const b = serverFingerprint('http://b:8000', {});
    expect(a).not.toBe(b);
  });

  it('differs when headers change', () => {
    const a = serverFingerprint('http://host:8000', { Authorization: 'Bearer x' });
    const b = serverFingerprint('http://host:8000', { Authorization: 'Bearer y' });
    expect(a).not.toBe(b);
  });

  it('stably serialises empty headers', () => {
    const a = serverFingerprint('http://host:8000', {});
    const b = serverFingerprint('http://host:8000', {});
    expect(a).toBe(b);
  });
});

describe('groupModelsByServer', () => {
  // Mock helpers passed as arguments.
  const resolveServer = (m: ModelConfig) => ({
    serverUrl: (m.serverUrl || '').replace(/\/+$/, ''),
    requestHeaders: (m as any)._headers ?? {},
  });
  const resolveId = (m: ModelConfig) => m.id;

  it('groups models sharing the same URL and headers', () => {
    const models: ModelConfig[] = [
      { id: 'm1', serverUrl: 'http://s:8000' },
      { id: 'm2', serverUrl: 'http://s:8000' },
    ];
    const groups = groupModelsByServer(models, resolveServer, resolveId);
    expect(groups).toHaveLength(1);
    expect(groups[0].models).toHaveLength(2);
  });

  it('separates models with different URLs', () => {
    const models: ModelConfig[] = [
      { id: 'm1', serverUrl: 'http://a:8000' },
      { id: 'm2', serverUrl: 'http://b:8000' },
    ];
    const groups = groupModelsByServer(models, resolveServer, resolveId);
    expect(groups).toHaveLength(2);
  });

  it('separates models with same URL but different headers', () => {
    const models: ModelConfig[] = [
      { id: 'm1', serverUrl: 'http://s:8000', _headers: { 'X-Key': 'a' } },
      { id: 'm2', serverUrl: 'http://s:8000', _headers: { 'X-Key': 'b' } },
    ] as any;
    const groups = groupModelsByServer(models, resolveServer, resolveId);
    expect(groups).toHaveLength(2);
  });

  it('normalises URL differences via the resolver (trailing slash)', () => {
    const resolveServerStrip = (m: ModelConfig) => ({
      serverUrl: (m.serverUrl || '').replace(/\/+$/, ''),
      requestHeaders: {},
    });
    const models: ModelConfig[] = [
      { id: 'a', serverUrl: 'http://s:8000' },
      { id: 'b', serverUrl: 'http://s:8000/' },
    ];
    const groups = groupModelsByServer(models, resolveServerStrip, resolveId);
    expect(groups).toHaveLength(1);
  });

  it('gives each model without a serverUrl its own group', () => {
    const models: ModelConfig[] = [
      { id: 'no-url-1' },
      { id: 'no-url-2' },
    ];
    const groups = groupModelsByServer(models, resolveServer, resolveId);
    expect(groups).toHaveLength(2);
    for (const g of groups) {
      expect(g.serverUrl).toBe('');
      expect(g.models).toHaveLength(1);
    }
  });

  it('mixes serverful and serverless models correctly', () => {
    const models: ModelConfig[] = [
      { id: 'm1', serverUrl: 'http://s:8000' },
      { id: 'no-url' },
      { id: 'm2', serverUrl: 'http://s:8000' },
    ];
    const groups = groupModelsByServer(models, resolveServer, resolveId);
    // Two groups: one for the server, one for the serverless model
    const serverGroup = groups.find(g => g.serverUrl !== '');
    const noUrlGroup = groups.find(g => g.serverUrl === '');
    expect(serverGroup?.models).toHaveLength(2);
    expect(noUrlGroup?.models).toHaveLength(1);
  });
});
