import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';
import {
  messageToText,
  convertMessages,
  parseToolCallArgs,
} from '../src/provider/messageConverter.js';

// Helpers to build messages with the mocked vscode classes.
function userMsg(content: any[]): vscode.LanguageModelChatRequestMessage {
  return { role: vscode.LanguageModelChatMessageRole.User, content, name: undefined } as any;
}
function asstMsg(content: any[]): vscode.LanguageModelChatRequestMessage {
  return { role: vscode.LanguageModelChatMessageRole.Assistant, content, name: undefined } as any;
}

// U4: the per-role convert functions folded into convertMessages' dispatch
// branches; these aliases keep the branch pins readable.
const convertAsst = (content: any[]) => convertMessages([asstMsg(content)]);
const convertUser = (content: any[]) => convertMessages([userMsg(content)]);
/** Tool-result content as it reaches the wire (extractToolResultContent is now private). */
const toolContent = (part: any) => (convertUser([part])[0] as any).content;

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

describe('convertMessages — assistant branch', () => {
  it('returns a text-only assistant message', () => {
    const result = convertAsst([
      new vscode.LanguageModelTextPart('hi'),
    ]);
    expect(result).toEqual([{ role: 'assistant', content: 'hi' }]);
  });

  it('joins multiple text parts with newlines', () => {
    const result = convertAsst([
      new vscode.LanguageModelTextPart('line 1'),
      new vscode.LanguageModelTextPart('line 2'),
    ])[0]!;
    expect(result.content).toBe('line 1\nline 2');
  });

  it('emits tool_calls with stringified arguments', () => {
    const result = convertAsst([
      new vscode.LanguageModelToolCallPart('call_1', 'readFile', { path: '/foo' }),
    ])[0]!;
    expect(result.role).toBe('assistant');
    expect(result.content).toBe('');
    expect(result.tool_calls).toHaveLength(1);
    expect(result.tool_calls![0]).toEqual({
      id: 'call_1',
      type: 'function',
      function: { name: 'readFile', arguments: '{"path":"/foo"}' },
    });
  });

  it('emits both text and tool_calls when present', () => {
    const result = convertAsst([
      new vscode.LanguageModelTextPart('Let me check that.'),
      new vscode.LanguageModelToolCallPart('c1', 'readFile', { path: '/a' }),
    ])[0]!;
    expect(result.content).toBe('Let me check that.');
    expect(result.tool_calls).toHaveLength(1);
  });

  it('uses empty string content when only tool_calls present', () => {
    const result = convertAsst([
      new vscode.LanguageModelToolCallPart('c1', 'foo', {}),
    ])[0]!;
    expect(result.content).toBe('');
  });

  it('forwards host-supplied thinking history as structured reasoning', () => {
    const result = convertAsst([
      new vscode.LanguageModelThinkingPart('first '),
      new vscode.LanguageModelThinkingPart(['step', ' two']),
      new vscode.LanguageModelTextPart('answer'),
    ]);
    expect(result).toEqual([{
      role: 'assistant',
      content: 'answer',
      reasoning: 'first step two',
    }]);
  });

  it('keeps a thinking-only historical assistant message', () => {
    const result = convertAsst([
      new vscode.LanguageModelThinkingPart('reasoning'),
    ]);
    expect(result).toEqual([{
      role: 'assistant',
      content: '',
      reasoning: 'reasoning',
    }]);
  });
});

describe('convertMessages — user branch', () => {
  it('returns a single user message with a text string for a single text part', () => {
    const result = convertUser([
      new vscode.LanguageModelTextPart('hello'),
    ]);
    expect(result).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('returns a content array when multiple parts present', () => {
    const result = convertUser([
      new vscode.LanguageModelTextPart('hello'),
      new vscode.LanguageModelTextPart('world'),
    ]);
    expect(result).toHaveLength(1);
    expect(Array.isArray(result[0].content)).toBe(true);
    expect(result[0].content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
    ]);
  });

  it('emits tool results BEFORE the user text (correct roundtrip order)', () => {
    const toolResult = new vscode.LanguageModelToolResultPart('call_1', [new vscode.LanguageModelTextPart('file contents')]);
    const result = convertUser([
      new vscode.LanguageModelTextPart('thanks'),
      toolResult,
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: 'file contents' });
    expect(result[1]).toEqual({ role: 'user', content: 'thanks' });
  });

  it('returns only tool messages when only tool results present', () => {
    const tr = new vscode.LanguageModelToolResultPart('c1', [new vscode.LanguageModelTextPart('data')]);
    const result = convertUser([tr]);
    expect(result).toEqual([{ role: 'tool', tool_call_id: 'c1', content: 'data' }]);
  });

  it('emits an empty user message when the message has no parts', () => {
    // The never-empty guard: an empty user message must still emit a message
    // so the request isn't dropped by strict servers.
    expect(convertUser([])).toEqual([{ role: 'user', content: '' }]);
  });

  it('encodes image parts as image_url with data URI', () => {
    const imgBytes = new Uint8Array([0xff, 0xd8, 0xff]); // JPEG SOI
    const img = new vscode.LanguageModelDataPart(imgBytes, 'image/jpeg');
    const result = convertUser([
      new vscode.LanguageModelTextPart('describe this'),
      img,
    ]);
    expect(result).toHaveLength(1);
    const content = result[0].content;
    expect(Array.isArray(content)).toBe(true);
    const imageContent = (content as any[]).find((c: any) => c.type === 'image_url');
    expect(imageContent).toBeTruthy();
    expect(imageContent.image_url.url).toMatch(/^data:image\/jpeg;base64,/);
    expect(imageContent.image_url.url).toContain('/9j/'); // base64 of FFD8FF
  });

  it('produces an exact data URI for known bytes', () => {
    // Absorbed from the deleted imagePartToDataUri unit test: exact bytes ->
    // exact base64, verified through the wire path.
    const img = new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png');
    const content = convertUser([img])[0].content as any[];
    expect(content[0].image_url.url).toBe('data:image/png;base64,AQID');
  });

  it('does not treat non-image data parts as images', () => {
    // Absorbed from the deleted isImagePart unit test: a JSON data part is
    // silently dropped (not sent as text, not sent as image).
    const jsonPart = new vscode.LanguageModelDataPart(new Uint8Array([1]), 'application/json');
    expect(convertUser([jsonPart])).toEqual([{ role: 'user', content: '' }]);
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

describe('tool result content extraction (private, via convertMessages tool role)', () => {
  it('joins array-of-text-parts with newlines', () => {
    const part = new vscode.LanguageModelToolResultPart('id1', [
      new vscode.LanguageModelTextPart('a'),
      new vscode.LanguageModelTextPart('b'),
    ]);
    expect(toolContent(part)).toBe('a\nb');
  });

  it('JSON-stringifies unknown content types in arrays', () => {
    const part = new vscode.LanguageModelToolResultPart('id1', [{ foo: 'bar' }]);
    expect(toolContent(part)).toBe('{"foo":"bar"}');
  });

  it('does NOT filter objects that have mimeType but no $mid (legitimate tool output)', () => {
    // A file-info tool might return {name, mimeType, size} — this must pass through.
    const fileInfo = { name: 'image.png', mimeType: 'image/png', size: 1024 };
    const part = new vscode.LanguageModelToolResultPart('id1', [fileInfo]);
    expect(toolContent(part)).toBe(JSON.stringify(fileInfo));
  });

  it('handles bare string elements in content array', () => {
    const part = new vscode.LanguageModelToolResultPart('id1', ['just a string']);
    expect(toolContent(part)).toBe('just a string');
  });

  it('filters out LanguageModelDataPart (cache_control metadata) from arrays', () => {
    const cacheControl = new vscode.LanguageModelDataPart(new TextEncoder().encode('ephemeral'), 'cache_control');
    const part = new vscode.LanguageModelToolResultPart('id1', [
      new vscode.LanguageModelTextPart('tool output'),
      cacheControl,
    ]);
    expect(toolContent(part)).toBe('tool output');
  });

  it('filters out raw VS Code protocol objects with $mid (plain-object metadata leak)', () => {
    // VS Code may pass metadata as a plain object (not a LanguageModelDataPart instance)
    // with internal properties like $mid and mimeType. These must not reach the model.
    const rawBlob = { $mid: 24, mimeType: 'cache_control', data: 'ZXBoZW1lcmFs' };
    const part = new vscode.LanguageModelToolResultPart('id1', [
      new vscode.LanguageModelTextPart('tool output'),
      rawBlob,
    ]);
    expect(toolContent(part)).toBe('tool output');
  });

  it('filters out LanguageModelDataPart when it is the only element in the array', () => {
    const cacheControl = new vscode.LanguageModelDataPart(new TextEncoder().encode('ephemeral'), 'cache_control');
    const part = new vscode.LanguageModelToolResultPart('id1', [cacheControl]);
    expect(convertUser([part])).toEqual([{ role: 'tool', tool_call_id: 'id1', content: '' }]);
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
    expect(toolContent(part)).toBe('result: 42\nmore data');
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

