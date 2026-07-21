import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  messageToText,
  convertMessages,
  convertAssistantMessage,
  convertUserMessage,
  extractToolResultContent,
  parseToolCallArgs,
  formatError,
  serializeError,
  describeError,
  isGracefulTermination,
  isImagePart,
  imagePartToDataUri,
} from '../src/messageConverter.js';

// Helpers to build messages with the mocked vscode classes.
function userMsg(content: any[]): vscode.LanguageModelChatRequestMessage {
  return { role: vscode.LanguageModelChatMessageRole.User, content, name: undefined } as any;
}
function asstMsg(content: any[]): vscode.LanguageModelChatRequestMessage {
  return { role: vscode.LanguageModelChatMessageRole.Assistant, content, name: undefined } as any;
}

describe('messageToText', () => {
  it('joins multiple text parts with newlines', () => {
    const msg = userMsg([
      new vscode.LanguageModelTextPart('hello'),
      new vscode.LanguageModelTextPart('world'),
    ]);
    expect(messageToText(msg)).toBe('hello\nworld');
  });

  it('extracts tool call name and serialized input', () => {
    const msg = asstMsg([
      new vscode.LanguageModelToolCallPart('id1', 'readFile', { path: '/foo' }),
    ]);
    const text = messageToText(msg);
    expect(text).toContain('readFile');
    expect(text).toContain('"path":"/foo"');
  });

  it('extracts text from a tool result with array content', () => {
    const result = new vscode.LanguageModelToolResultPart('id1', [
      new vscode.LanguageModelTextPart('result line 1'),
      'plain string',
    ]);
    const msg = userMsg([result]);
    const text = messageToText(msg);
    expect(text).toContain('result line 1');
    expect(text).toContain('plain string');
  });

  it('extracts text from a tool result with text-part content', () => {
    const result = new vscode.LanguageModelToolResultPart('id1', [new vscode.LanguageModelTextPart('just a string')]);
    expect(messageToText(userMsg([result]))).toBe('just a string');
  });

  it('survives non-serializable tool call input', () => {
    const circular: any = { a: 1 };
    circular.self = circular;
    const msg = asstMsg([
      new vscode.LanguageModelToolCallPart('id1', 'tool', circular),
    ]);
    // Should not throw; should still include the tool name.
    const text = messageToText(msg);
    expect(text).toContain('tool');
  });
});

describe('convertAssistantMessage', () => {
  it('returns a text-only assistant message', () => {
    const result = convertAssistantMessage(asstMsg([
      new vscode.LanguageModelTextPart('hi'),
    ]));
    expect(result).toEqual({ role: 'assistant', content: 'hi' });
  });

  it('joins multiple text parts with newlines', () => {
    const result = convertAssistantMessage(asstMsg([
      new vscode.LanguageModelTextPart('line 1'),
      new vscode.LanguageModelTextPart('line 2'),
    ]));
    expect(result.content).toBe('line 1\nline 2');
  });

  it('emits tool_calls with stringified arguments', () => {
    const result = convertAssistantMessage(asstMsg([
      new vscode.LanguageModelToolCallPart('call_1', 'readFile', { path: '/foo' }),
    ]));
    expect(result.role).toBe('assistant');
    expect(result.content).toBe('');
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls[0]).toEqual({
      id: 'call_1',
      type: 'function',
      function: { name: 'readFile', arguments: '{"path":"/foo"}' },
    });
  });

  it('emits both text and tool_calls when present', () => {
    const result = convertAssistantMessage(asstMsg([
      new vscode.LanguageModelTextPart('Let me check that.'),
      new vscode.LanguageModelToolCallPart('c1', 'readFile', { path: '/a' }),
    ]));
    expect(result.content).toBe('Let me check that.');
    expect(result.tool_calls).toHaveLength(1);
  });

  it('uses empty string content when only tool_calls present', () => {
    const result = convertAssistantMessage(asstMsg([
      new vscode.LanguageModelToolCallPart('c1', 'foo', {}),
    ]));
    expect(result.content).toBe('');
  });

  it('forwards host-supplied thinking history as structured reasoning', () => {
    const result = convertAssistantMessage(asstMsg([
      new vscode.LanguageModelThinkingPart('first '),
      new vscode.LanguageModelThinkingPart(['step', ' two']),
      new vscode.LanguageModelTextPart('answer'),
    ]));
    expect(result).toEqual({
      role: 'assistant',
      content: 'answer',
      reasoning: 'first step two',
    });
  });

  it('keeps a thinking-only historical assistant message', () => {
    const result = convertAssistantMessage(asstMsg([
      new vscode.LanguageModelThinkingPart('reasoning'),
    ]));
    expect(result).toEqual({
      role: 'assistant',
      content: '',
      reasoning: 'reasoning',
    });
  });
});

describe('convertUserMessage', () => {
  it('returns a single user message with a text string for a single text part', () => {
    const result = convertUserMessage(userMsg([
      new vscode.LanguageModelTextPart('hello'),
    ]));
    expect(result).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('returns a content array when multiple parts present', () => {
    const result = convertUserMessage(userMsg([
      new vscode.LanguageModelTextPart('hello'),
      new vscode.LanguageModelTextPart('world'),
    ]));
    expect(result).toHaveLength(1);
    expect(Array.isArray(result[0].content)).toBe(true);
    expect(result[0].content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ]);
  });

  it('emits tool results BEFORE the user text (correct roundtrip order)', () => {
    const toolResult = new vscode.LanguageModelToolResultPart('call_1', [new vscode.LanguageModelTextPart('file contents')]);
    const result = convertUserMessage(userMsg([
      new vscode.LanguageModelTextPart('thanks'),
      toolResult,
    ]));
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'file contents' });
    expect(result[1]).toEqual({ role: 'user', content: 'thanks' });
  });

  it('returns only tool messages when only tool results present', () => {
    const tr = new vscode.LanguageModelToolResultPart('c1', [new vscode.LanguageModelTextPart('data')]);
    const result = convertUserMessage(userMsg([tr]));
    expect(result).toEqual([{ role: 'tool', tool_call_id: 'c1', content: 'data' }]);
  });

  it('encodes image parts as image_url with data URI', () => {
    const imgBytes = new Uint8Array([0xff, 0xd8, 0xff]); // JPEG SOI
    const img = new vscode.LanguageModelDataPart(imgBytes, 'image/jpeg');
    const result = convertUserMessage(userMsg([
      new vscode.LanguageModelTextPart('describe this'),
      img,
    ]));
    expect(result).toHaveLength(1);
    const content = result[0].content;
    expect(Array.isArray(content)).toBe(true);
    const imageContent = content.find((c: any) => c.type === 'image_url');
    expect(imageContent).toBeTruthy();
    expect(imageContent.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(imageContent.image_url.url).toContain('/9j/'); // base64 of FFD8FF
  });
});

describe('convertMessages', () => {
  it('preserves historical reasoning through the public message conversion path', () => {
    const result = convertMessages([
      userMsg([new vscode.LanguageModelTextPart('follow up')]),
      asstMsg([
        new vscode.LanguageModelThinkingPart('prior reasoning'),
        new vscode.LanguageModelTextPart('prior answer'),
      ]),
    ]);
    expect(result).toEqual([
      { role: 'user', content: 'follow up' },
      { role: 'assistant', content: 'prior answer', reasoning: 'prior reasoning' },
    ]);
  });

  it('preserves a multi-turn tool roundtrip', () => {
    const messages = [
      userMsg([new vscode.LanguageModelTextPart('read foo.txt')]),
      asstMsg([new vscode.LanguageModelToolCallPart('call_1', 'readFile', { path: 'foo.txt' })]),
      userMsg([new vscode.LanguageModelToolResultPart('call_1', [new vscode.LanguageModelTextPart('foo contents')])]),

      asstMsg([new vscode.LanguageModelTextPart('It says: foo contents')]),
    ];
    const result = convertMessages(messages);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ role: 'user', content: 'read foo.txt' });
    expect(result[1].role).toBe('assistant');
    expect(result[1].tool_calls).toHaveLength(1);
    expect(result[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'foo contents' });
    expect(result[3]).toEqual({ role: 'assistant', content: 'It says: foo contents' });
  });

  it('skips assistant messages that produce null', () => {
    const result = convertMessages([asstMsg([])]);
    expect(result).toEqual([]);
  });

  it('merges multiple system messages into one at the beginning', () => {
    // Copilot can inject System-role messages at any position (e.g. agent instructions
    // mid-turn). Many vLLM chat templates (Qwen3, etc.) reject multiple system messages
    // or system messages after user/assistant turns, so we merge all system content
    // into a single message at index 0.
    const sysMsg = (text: string): vscode.LanguageModelChatRequestMessage =>
      ({ role: vscode.LanguageModelChatMessageRole.System, content: [new vscode.LanguageModelTextPart(text)], name: undefined } as any);

    const messages = [
      userMsg([new vscode.LanguageModelTextPart('hello')]),
      asstMsg([new vscode.LanguageModelTextPart('hi')]),
      sysMsg('injected agent instruction'),
      userMsg([new vscode.LanguageModelTextPart('follow up')]),
    ];
    const result = convertMessages(messages);
    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ role: 'system', content: 'injected agent instruction' });
    expect(result[1]).toEqual({ role: 'user', content: 'hello' });
    expect(result[2]).toEqual({ role: 'assistant', content: 'hi' });
    expect(result[3]).toEqual({ role: 'user', content: 'follow up' });
  });

  it('merges multiple system messages into a single system message', () => {
    const sysMsg = (text: string): vscode.LanguageModelChatRequestMessage =>
      ({ role: vscode.LanguageModelChatMessageRole.System, content: [new vscode.LanguageModelTextPart(text)], name: undefined } as any);

    const messages = [
      sysMsg('first system'),
      userMsg([new vscode.LanguageModelTextPart('hello')]),
      sysMsg('second system'),
    ];
    const result = convertMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'system', content: 'first system\n\nsecond system' });
    expect(result[1]).toEqual({ role: 'user', content: 'hello' });
  });
});

describe('extractToolResultContent', () => {
  it('joins array-of-text-parts with newlines', () => {
    const part = new vscode.LanguageModelToolResultPart('id1', [
      new vscode.LanguageModelTextPart('a'),
      new vscode.LanguageModelTextPart('b'),
    ]);
    expect(extractToolResultContent(part)).toBe('a\nb');
  });

  it('JSON-stringifies unknown content types in arrays', () => {
    const part = new vscode.LanguageModelToolResultPart('id1', [{ foo: 'bar' }]);
    expect(extractToolResultContent(part)).toBe('{"foo":"bar"}');
  });

  it('does NOT filter objects that have mimeType but no $mid (legitimate tool output)', () => {
    // A file-info tool might return {name, mimeType, size} — this must pass through.
    const fileInfo = { name: 'image.png', mimeType: 'image/png', size: 1024 };
    const part = new vscode.LanguageModelToolResultPart('id1', [fileInfo]);
    expect(extractToolResultContent(part)).toBe(JSON.stringify(fileInfo));
  });

  it('handles bare string elements in content array', () => {
    const part = new vscode.LanguageModelToolResultPart('id1', ['just a string']);
    expect(extractToolResultContent(part)).toBe('just a string');
  });

  it('filters out LanguageModelDataPart (cache_control metadata) from arrays', () => {
    const cacheControl = new vscode.LanguageModelDataPart(new TextEncoder().encode('ephemeral'), 'cache_control');
    const part = new vscode.LanguageModelToolResultPart('id1', [
      new vscode.LanguageModelTextPart('tool output'),
      cacheControl,
    ]);
    expect(extractToolResultContent(part)).toBe('tool output');
  });

  it('filters out raw VS Code protocol objects with $mid (plain-object metadata leak)', () => {
    // VS Code may pass metadata as a plain object (not a LanguageModelDataPart instance)
    // with internal properties like $mid and mimeType. These must not reach the model.
    const rawBlob = { $mid: 24, mimeType: 'cache_control', data: 'ZXBoZW1lcmFs' };
    const part = new vscode.LanguageModelToolResultPart('id1', [
      new vscode.LanguageModelTextPart('tool output'),
      rawBlob,
    ]);
    expect(extractToolResultContent(part)).toBe('tool output');
  });

  it('filters out LanguageModelDataPart when it is the only element in the array', () => {
    const cacheControl = new vscode.LanguageModelDataPart(new TextEncoder().encode('ephemeral'), 'cache_control');
    const part = new vscode.LanguageModelToolResultPart('id1', [cacheControl]);
    expect(extractToolResultContent(part)).toBe('');
  });

  it('only preserves text parts when mixed with DataPart metadata', () => {
    const cacheControl = new vscode.LanguageModelDataPart(new TextEncoder().encode('ephemeral'), 'cache_control');
    const usageData = new vscode.LanguageModelDataPart(new TextEncoder().encode('{"prompt_tokens":10}'), 'application/json');
    const part = new vscode.LanguageModelToolResultPart('id1', [
      cacheControl,
      new vscode.LanguageModelTextPart('result: 42'),
      usageData,
      new vscode.LanguageModelTextPart('more data'),
    ]);
    expect(extractToolResultContent(part)).toBe('result: 42\nmore data');
  });
});

describe('parseToolCallArgs', () => {
  it('returns {} for empty arguments', () => {
    expect(parseToolCallArgs({ id: 'c1', name: 'tool', arguments: '' })).toEqual({});
    expect(parseToolCallArgs({ id: 'c1', name: 'tool', arguments: '{}' })).toEqual({});
  });

  it('parses valid JSON', () => {
    expect(parseToolCallArgs({ id: 'c1', name: 'tool', arguments: '{"a":1}' })).toEqual({ a: 1 });
  });

  it('repairs truncated JSON via jsonRepair', () => {
    const result = parseToolCallArgs({ id: 'c1', name: 'tool', arguments: '{"path":"/foo' });
    expect(result).not.toBeNull();
    expect(typeof (result as any).path).toBe('string');
  });

  it('recovers truncated string-value JSON via best-effort-json-parser', () => {
    // finish_reason: 'length' can cut a tool call mid-string-value, e.g.:
    //   {"path":"foo.ts","content":"def hello():\n    print(
    // jsonrepair throws on unterminated strings; best-effort-json-parser closes
    // them and preserves the partial content. This is the one case BYOK's
    // parser handles that jsonrepair doesn't.
    const truncated = '{"path":"foo.ts","content":"def hello():\n    print(';
    const result = parseToolCallArgs({ id: 'c1', name: 'edit_file', arguments: truncated });
    expect(result).not.toBeNull();
    expect((result as any).path).toBe('foo.ts');
    expect(typeof (result as any).content).toBe('string');
    expect((result as any).content).toContain('def hello');
  });

  it('returns null (not {} or { _raw }) on unrepairable garbage', () => {
    // Regression: previously returned { _raw: <garbage> } which would round-trip
    // back to the model as an invalid tool_call payload. Then changed to {} which
    // would call tools with empty args. Now returns null so caller can skip.
    const cb = vi.fn();
    const result = parseToolCallArgs({ id: 'c1', name: 'tool', arguments: '\x00\x01\x02' }, cb);
    expect(result).toBeNull();
  });

  it('invokes the onUnparseable callback when JSON cannot be parsed or repaired', () => {
    const cb = vi.fn();
    parseToolCallArgs({ id: 'c1', name: 'someTool', arguments: '\x00\x01\x02' }, cb);
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith('someTool', '\x00\x01\x02');
  });

  it('does NOT invoke the callback on a successful parse', () => {
    const cb = vi.fn();
    parseToolCallArgs({ id: 'c1', name: 'tool', arguments: '{"x":1}' }, cb);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe('isGracefulTermination', () => {
  it('recognizes TypeError: terminated (VS Code internal .terminate())', () => {
    expect(isGracefulTermination(new TypeError('terminated'))).toBe(true);
  });

  it('recognizes TypeError: terminated nested in a cause chain', () => {
    const inner = new TypeError('terminated');
    const outer = new Error('fetch failed', { cause: inner });
    expect(isGracefulTermination(outer)).toBe(true);
  });

  it('does NOT treat ERR_STREAM_PREMATURE_CLOSE as graceful', () => {
    // A premature close is a network/proxy drop, NOT an intentional .terminate().
    // Treating it as graceful would silently swallow a real failure. It must
    // surface to the user via formatError's premature-close branch instead.
    const err = Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
    expect(isGracefulTermination(err)).toBe(false);
  });

  it('does NOT treat bare ECONNRESET as graceful', () => {
    expect(isGracefulTermination(new Error('ECONNRESET'))).toBe(false);
  });

  it('does NOT treat string throws as graceful', () => {
    expect(isGracefulTermination('User cancelled')).toBe(false);
    expect(isGracefulTermination('Stream inactivity timeout (30000ms without data)')).toBe(false);
  });
});

describe('formatError', () => {
  it('maps ECONNREFUSED to a connection-help message', () => {
    expect(formatError(new Error('connect ECONNREFUSED 127.0.0.1:8000'))).toContain('Cannot connect');
  });

  it('maps fetch failed to the same connection-help message', () => {
    expect(formatError(new Error('fetch failed'))).toContain('Cannot connect');
  });

  it('maps 401 to an auth-help message', () => {
    expect(formatError(new Error('HTTP 401: Unauthorized'))).toContain('Authentication failed');
  });

  it('maps 429 to a rate-limit message', () => {
    expect(formatError(new Error('HTTP 429: Too Many Requests'))).toContain('Rate limited');
  });

  it('maps context length errors to a context-window message', () => {
    expect(formatError(new Error('Token exceeds max_model_len'))).toContain('Context window exceeded');
    expect(formatError(new Error('reached maximum context'))).toContain('Context window exceeded');
  });

  it('maps 524/504 Gateway Timeout to a reverse proxy timeout message', () => {
    expect(formatError(new Error('HTTP 524: Gateway Timeout'))).toContain('Reverse proxy timeout');
    expect(formatError(new Error('HTTP 504: Gateway Timeout'))).toContain('Reverse proxy timeout');
    expect(formatError(new Error('Gateway Timeout'))).toContain('Reverse proxy timeout');
  });

  it('maps connection-reset errors to mention proxy timeout', () => {
    expect(formatError(new Error('other side closed'))).toContain('proxy');
    expect(formatError(new Error('ECONNRESET'))).toContain('proxy');
    expect(formatError(new Error('socket hang up'))).toContain('proxy');
  });

  it('maps premature stream close to a targeted message', () => {
    // Node's fetch (undici) surfaces a mid-stream body close as code
    // ERR_STREAM_PREMATURE_CLOSE / message "Premature close" — distinct from a
    // user cancel or a graceful .terminate(). This happens when a reverse proxy
    // (Cloudflare, nginx, corporate gateway) drops the connection mid-stream or
    // the network drops. We map it to an actionable message instead of a
    // generic "Stream error during read" dump.
    const errWithCode = Object.assign(new Error('Premature close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
    expect(formatError(errWithCode)).toContain('prematurely');
    expect(formatError(errWithCode)).toContain('proxy');
    // The wrapped message from streamReader (loses the .code, keeps the text):
    expect(formatError(new Error('Connection closed prematurely by the network or a reverse proxy'))).toContain('prematurely');
  });

  it('maps abort to an aborted message', () => {
    expect(formatError(new Error('The operation was aborted'))).toContain('aborted');
    const abortErr = Object.assign(new Error('terminated'), { name: 'AbortError' });
    expect(formatError(abortErr)).toContain('aborted');
    expect(formatError(new Error('terminated'))).toContain('aborted');
    expect(formatError(new Error('Request cancelled by user'))).toContain('cancelled');
    expect(formatError(new Error('User cancelled'))).toContain('cancelled');
  });

  it('handles plain string throws (Node.js fetch abort returns string)', () => {
    expect(formatError('Stream inactivity timeout (30000ms without data)')).toContain('inactivity');
    expect(formatError('User cancelled')).toContain('cancelled');
  });

  it('serializes plain string throws', () => {
    expect(serializeError('Stream inactivity timeout (30000ms without data)')).toContain('Stream inactivity timeout');
    expect(serializeError('User cancelled')).toContain('User cancelled');
  });

  it('falls back to "Error: <msg>" for unknown messages', () => {
    expect(formatError(new Error('something exploded'))).toBe('Error: something exploded');
  });

  it('returns a generic message for non-Error values', () => {
    expect(formatError(null)).toBe('Unknown error occurred.');
    expect(formatError(undefined)).toBe('Unknown error occurred.');
  });
});

describe('describeError', () => {
  it('unwraps the cause chain that fetch() buries under "fetch failed"', () => {
    // undici shape: TypeError: fetch failed → cause carries the real TLS reason.
    const cause = new Error('unable to verify the first certificate');
    (cause as { code?: string }).code = 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
    const err = new TypeError('fetch failed', { cause });
    const out = describeError(err);
    expect(out).toContain('fetch failed');
    expect(out).toContain('unable to verify the first certificate');
    expect(out).toContain('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  });

  it('surfaces a nested code-only network cause (ECONNREFUSED)', () => {
    const inner = new Error('connect ECONNREFUSED 10.0.0.1:8080');
    (inner as { code?: string }).code = 'ECONNREFUSED';
    const err = new TypeError('fetch failed', { cause: inner });
    expect(describeError(err)).toContain('ECONNREFUSED');
  });

  it('passes plain string throws through unchanged', () => {
    expect(describeError('Request cancelled by user')).toBe('Request cancelled by user');
  });
});

describe('isImagePart / imagePartToDataUri', () => {
  it('returns true only for image/* data parts', () => {
    expect(isImagePart(new vscode.LanguageModelDataPart(new Uint8Array(), 'image/png'))).toBe(true);
    expect(isImagePart(new vscode.LanguageModelDataPart(new Uint8Array(), 'image/jpeg'))).toBe(true);
    expect(isImagePart(new vscode.LanguageModelDataPart(new Uint8Array(), 'application/json'))).toBe(false);
    expect(isImagePart(new vscode.LanguageModelTextPart('hi'))).toBe(false);
    expect(isImagePart(null)).toBe(false);
    expect(isImagePart(undefined)).toBe(false);
  });

  it('produces a valid data URI', () => {
    const uri = imagePartToDataUri(new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png'));
    expect(uri).toBe('data:image/png;base64,AQID');
  });
});
