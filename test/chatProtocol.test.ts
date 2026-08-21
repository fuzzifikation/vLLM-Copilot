import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkResponseContentType } from '../src/provider/chatProtocol.js';

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('checkResponseContentType', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts an SSE content type without error', async () => {
    const r = new Response('data: {}', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    await expect(checkResponseContentType(r)).resolves.toBeUndefined();
  });

  it('throws on a JSON body without an error envelope', async () => {
    await expect(checkResponseContentType(jsonResponse({ ok: true }))).rejects.toThrow(/unexpected JSON response/);
  });

  it('throws the simple server error message', async () => {
    const r = jsonResponse({ error: { message: 'This model maximum context length is 4096 tokens' } });
    await expect(checkResponseContentType(r)).rejects.toThrow(
      'Server error (mid-stream): This model maximum context length is 4096 tokens'
    );
  });

  it('recovers the real reason from an OpenRouter error.metadata.raw envelope', async () => {
    const r = jsonResponse({
      error: {
        message: 'Provider returned error',
        metadata: { raw: 'Rate limit exceeded for the provider deepseek' },
      },
    });
    await expect(checkResponseContentType(r)).rejects.toThrow(/Rate limit exceeded for the provider deepseek/);
  });

  it('throws a string-form error', async () => {
    const r = jsonResponse({ error: 'internal server error' });
    await expect(checkResponseContentType(r)).rejects.toThrow('Server error (mid-stream): internal server error');
  });

  it('throws HTML bodies as a reverse-proxy error', async () => {
    const r = new Response('<html><body>Gateway Timeout</body></html>', {
      status: 502,
      headers: { 'content-type': 'text/html' },
    });
    await expect(checkResponseContentType(r)).rejects.toThrow(/HTML instead of SSE stream/);
  });
});
