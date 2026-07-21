import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { FileLogger } from '../src/logger.js';

/**
 * Minimal stub of vscode.ExtensionContext that satisfies FileLogger.
 */
function makeContext(storage: string): any {
  return {
    globalStorageUri: { fsPath: storage },
    extensionPath: storage,
  };
}

describe('FileLogger', () => {
  let tmp: string;
  let logger: FileLogger;
  let logFile: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vllm-logger-test-'));
    logger = new FileLogger(makeContext(tmp));
    logger.init();
    logFile = logger.getLogFilePath()!;
  });

  afterEach(async () => {
    await logger.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function readLog(): Promise<string> {
    await logger.close();
    return fs.readFileSync(logFile, 'utf8');
  }

  it('writes a session-start banner with a full timestamp (not just YYYY-MM-DD)', async () => {
    const stamp = path.basename(logFile);
    expect(stamp).toMatch(/^vllm-copilot-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}\.log$/);
  });

  it('logs URL query strings as-is (no redaction - expert debug tool)', async () => {
    logger.logRequest('GET', 'https://host/api?Authorization=Bearer-abc&api_key=SECRET1&q=1');
    const content = await readLog();
    expect(content).toContain('Authorization=Bearer-abc');
    expect(content).toContain('api_key=SECRET1');
  });

  it('logs request headers as-is (no redaction - expert debug tool)', async () => {
    logger.logRequest('POST', 'https://host/api', {
      Authorization: 'Bearer xyz',
      api_key: 'sek1',
      safe_header: 'visible',
    });
    const content = await readLog();
    expect(content).toContain('HEADERS');
    expect(content).toContain('"Authorization":"Bearer xyz"');
    expect(content).toContain('"api_key":"sek1"');
    expect(content).toContain('"safe_header":"visible"');
  });

  it('logs request body as-is (no redaction - expert debug tool)', async () => {
    logger.logRequest('POST', 'https://host/api', undefined, {
      Authorization: 'Bearer xyz',
      api_key: 'sek1',
      password: 'p@ss',
      nested: { authorization: 'Bearer nested', safe: 'visible' },
      normal_field: 'visible-value',
    });
    const content = await readLog();
    expect(content).toContain('BODY');
    expect(content).toContain('"Authorization":"Bearer xyz"');
    expect(content).toContain('"api_key":"sek1"');
    expect(content).toContain('"password":"p@ss"');
    expect(content).toContain('"authorization":"Bearer nested"');
    expect(content).toContain('"safe":"visible"');
    expect(content).toContain('"normal_field":"visible-value"');
  });

  it('logs response body as-is (no redaction - expert debug tool)', async () => {
    logger.logResponse(200, 'https://host/api', undefined, { api_key: 'leak', items: [1, 2, 3] });
    const content = await readLog();
    expect(content).toContain('"api_key":"leak"');
    expect(content).toContain('"items":[1,2,3]');
  });

  it('truncates very long bodies', async () => {
    const big = 'x'.repeat(10_000);
    logger.logRequest('POST', 'https://host/api', undefined, { data: big });
    const content = await readLog();
    expect(content).toContain('truncated');
    expect(content.length).toBeLessThan(8_000);
  });

  it('isActive() reflects open/closed state', async () => {
    expect(logger.isActive()).toBe(true);
    logger.close();
    expect(logger.isActive()).toBe(false);
  });

  it('survives nested arrays in body', async () => {
    logger.logRequest('POST', 'https://host/api', undefined, { arr: [{ token: 'sek' }, { safe: 'ok' }] });
    const content = await readLog();
    expect(content).toContain('"token":"sek"');
    expect(content).toContain('"safe":"ok"');
  });
});

describe('FileLogger when disabled', () => {
  it('returns null log file path when init was never called', async () => {
    const logger = new FileLogger(makeContext('/tmp/never-written'));
    expect(logger.getLogFilePath()).toBeNull();
    expect(logger.isActive()).toBe(false);
    // These should all be no-ops, not throw
    logger.logRequest('GET', 'https://host');
    logger.logResponse(200, 'https://host');
    logger.logStreamChunk(1, 'x');
    logger.logStreamFinish('stop');
    logger.close();
  });
});
