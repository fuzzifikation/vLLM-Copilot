import { describe, it, expect } from 'vitest';
import { mergeAuthHeaders } from '../src/state/config.js';

/**
 * Tests for the header-merge helper behind the "Update Auth" command.
 *
 * The critical regression: updating auth used to REPLACE each model's whole
 * requestHeaders object, so rotating only the API key silently deleted existing
 * custom headers (e.g. CF-Access proxy headers) — the same class of silent data
 * loss as the focus-loss bug. New behavior merges: a non-empty key sets
 * Authorization, entered headers merge on top, and fields left empty keep their
 * current value.
 */

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
