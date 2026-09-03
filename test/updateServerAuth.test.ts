import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as vscode from 'vscode';
import { ConfigurationTarget } from 'vscode';
import { mergeAuthHeaders } from '../src/config.js';
import { registerUpdateServerAuthCommand } from '../src/commands.js';

/**
 * Tests for the "Update Auth" command and its header-merge helper.
 *
 * The critical regression: updating auth used to REPLACE each model's whole
 * requestHeaders object, so rotating only the API key silently deleted existing
 * custom headers (e.g. CF-Access proxy headers) — the same class of silent data
 * loss as the focus-loss bug. New behavior merges: a non-empty key sets
 * Authorization, entered headers merge on top, and fields left empty keep their
 * current value.
 */

const output = { appendLine: vi.fn(), show: vi.fn() } as any;
const provider = { clearCache: vi.fn() } as any;

/** A spyable WorkspaceConfiguration serving models plus an optional server registry. */
function makeConfig(models: any[], servers: any[] = []): any {
  return {
    get: vi.fn((k: string) => (k === 'models' ? models : k === 'servers' ? servers : undefined)),
    has: () => false,
    update: vi.fn(async () => {}),
    inspect: () => undefined,
  };
}

describe('mergeAuthHeaders', () => {
  it('returns the same reference when nothing is entered (no-op)', () => {
    const existing = { Authorization: 'Bearer old', 'X-API-Key': 'x' };
    expect(mergeAuthHeaders(existing, {})).toBe(existing);
  });

  it('keeps existing custom headers when only the API key changes', () => {
    const existing = { Authorization: 'Bearer old', 'CF-Access-Client-Id': 'id', 'CF-Access-Client-Secret': 'secret' };
    expect(mergeAuthHeaders(existing, { Authorization: 'Bearer new' })).toEqual({
      Authorization: 'Bearer new',
      'CF-Access-Client-Id': 'id',
      'CF-Access-Client-Secret': 'secret',
    });
  });

  it('keeps the existing key when only custom headers are entered', () => {
    const existing = { Authorization: 'Bearer old' };
    expect(mergeAuthHeaders(existing, { 'X-API-Key': 'custom' })).toEqual({
      Authorization: 'Bearer old',
      'X-API-Key': 'custom',
    });
  });

  it('overwrites a colliding header name', () => {
    const existing = { 'X-API-Key': 'old' };
    expect(mergeAuthHeaders(existing, { 'X-API-Key': 'new' })).toEqual({ 'X-API-Key': 'new' });
  });

  it('creates headers from scratch when there were none', () => {
    expect(mergeAuthHeaders(undefined, { Authorization: 'Bearer new' })).toEqual({ Authorization: 'Bearer new' });
  });

  it('returns the same reference when incoming values match existing (no spurious write)', () => {
    const existing = { Authorization: 'Bearer same' };
    expect(mergeAuthHeaders(existing, { Authorization: 'Bearer same' })).toBe(existing);
  });
});
