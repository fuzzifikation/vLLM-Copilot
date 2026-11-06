/**
 * Parity fixture generator (unifiedmixers/gateway plan § Build order):
 * exports argument repair and request/stream behavior as JSON with a
 * sha256 manifest, so the gateway's differential check consumes the
 * artifact — never this checkout.
 *
 * The oracle is the extension's own `parseToolCallArgs`: every input is
 * run through the real ladder (JSON.parse → jsonrepair →
 * best-effort-json-parser). Expected values are therefore this
 * implementation's output, verbatim — the gateway matches the extension,
 * never the other way around.
 *
 * Normal run (`npm test`): regenerate and require byte-identical
 * equality with the committed artifacts — the drift gate: any change to
 * the ladder reddens the suite until the fixtures are re-exported.
 * Export run (`npm run parity:export`): rewrite `parity/` artifacts.
 */
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parseToolCallArgs } from '../src/core/request/sseParser.js';
import { ChatTransport } from '../src/core/request/chatTransport.js';
import { createExecutionState, executeChatRequest, isAttemptCompletionEvent } from '../src/core/request/execute.js';
import type { ServerType } from '../src/core/config/serverCore.js';
import type { OpenAIChatMessage, StreamEvent } from '../src/core/types.js';

const DIR = path.resolve(import.meta.dirname, '..', 'parity');
const FIXTURES_FILE = 'parity-fixtures.json';
const MANIFEST_FILE = 'MANIFEST.json';
const SCENARIOS_FILE = 'parity-scenarios.json';

/**
 * Representative model-output probes from test/messageConverter.test.ts,
 * the gateway's transcription, and review regressions. Strings are
 * compared after JSON transport, so what matters is the decoded value.
 */
const INPUTS: string[] = [
  // empty and strict shapes
  '',
  '{}',
  '{"path":"foo.ts"}',
  '{"a": 1, "b": 2}',
  // structure and quoting damage (jsonrepair tier)
  '{ path: \'foo.ts\', nested: { arr: [1, 2,], } }',
  '{ cmd: \'ls\', flag: True, none: None }',
  '{ \'msg\': \'she said "hi"\' }',
  '{"a": 1 "b": 2}',
  '{"a": [1, 2,],}',
  '{"n": 12.}',
  '{ "x": NaN, "y": Infinity, "z": undefined }',
  '{ greeting: hello }',
  '{key: [value1, value2]}',
  '{message: hello world}',
  '{tags: [hello world]}',
  '{"a":',
  '{"a":, "b":2}',
  '{"text":"emoji \\ud83d\\ude00",}',
  '{"a":1,,}',
  '{ , }',
  '{"k":"v" ',
  '{"k": "v",}',
  // truncation (best-effort tier)
  '{"path":"/foo',
  '{"path":"foo.ts","content":"def hello():\n    print(',
  '{"broken": {"inner": [{"x"',
  '{"a": [1, [2, [3,',
  // literals and non-objects: null by contract, never {} never {_raw}
  '[1,2]',
  '42',
  'null',
  'true',
  '"a string"',
  "'single'",
  // characters that break naive repairers
  '{"text": "caf\\u00e9 \\ud55c"}',
  '{"text": "emoji \\ud83d\\ude00"}',
  '{"multi": "line\nbreak"}',
  '\u0000\u0001\u0002',
  // deep but valid
  '{"a": {"b": {"c": [1, {"d": [true, {"e": "f"}]}]}}}',
];

const EXPORT = process.env.PARITY_EXPORT === '1';

const event = (delta: object, finish?: string): string =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }] })}\n\n`;
const done = 'data: [DONE]\n\n';
const answer = event({ content: 'answer' }) + event({}, 'stop') +
  'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' + done;
const user: OpenAIChatMessage[] = [{ role: 'user', content: 'hi' }];
const scenarios: {
  name: string;
  serverType: ServerType;
  attempts: string[];
  options?: Record<string, unknown>;
}[] = [
  { name: 'clean', serverType: 'vllm', attempts: [answer] },
  { name: 'empty-nudge', serverType: 'vllm', attempts: [event({}, 'stop') + done, answer] },
  { name: 'colon-continuation', serverType: 'vllm', attempts: [
    event({ content: 'Steps:' }) + event({}, 'stop') + done, answer,
  ] },
  { name: 'silent-error-replay', serverType: 'vllm', attempts: [
    'data: {"error":{"message":"retry me"}}\n\n', answer,
  ] },
  { name: 'non-vllm-colon', serverType: 'openrouter', attempts: [
    event({ content: 'Steps:' }) + event({}, 'stop') + done,
  ] },
  { name: 'openrouter-stripping', serverType: 'openrouter', attempts: [answer],
    options: { continue_final_message: true, add_generation_prompt: false } },
  { name: 'ollama-stripping', serverType: 'ollama', attempts: [answer],
    options: { continue_final_message: true, add_generation_prompt: false, tool_choice: 'auto' } },
  { name: 'fragmented-tool', serverType: 'vllm', attempts: [
    event({ tool_calls: [{ index: 0, id: 'call_probe', type: 'function',
      function: { name: 'read', arguments: '{"path":' } }] }) +
    event({ tool_calls: [{ index: 0, function: { arguments: '"file"}' } }] }, 'tool_calls') + done,
  ] },
  { name: 'empty-tool', serverType: 'vllm', attempts: [
    event({ tool_calls: [{ index: 0, id: 'call_empty', type: 'function',
      function: { name: 'list', arguments: '' } }] }) + event({}, 'tool_calls') + done,
  ] },
  { name: 'clean-eof', serverType: 'vllm', attempts: [event({ content: 'tail' }).trimEnd()] },
  { name: 'reasoning-alias', serverType: 'vllm', attempts: [
    event({ content: 'answer', reasoning_content: 'thought' }) + event({}, 'stop') + done,
  ] },
];

async function buildScenarios(): Promise<string> {
  const cases = [];
  const log = { appendLine: (_line: string): void => {} };
  for (const scenario of scenarios) {
    const requests: unknown[] = [];
    let attempt = 0;
    vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit): Promise<Response> => {
      if (attempt >= scenario.attempts.length) throw new Error(`unexpected retry in ${scenario.name}`);
      if (typeof init.body !== 'string') throw new Error('expected JSON request body');
      requests.push(JSON.parse(init.body));
      return new Response(scenario.attempts[attempt++], {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    try {
      const transport = new ChatTransport(log);
      const state = createExecutionState(0);
      const chunks: StreamEvent[] = [];
      for await (const chunk of executeChatRequest({
        transport: {
          chatCompletionStream: (...args) => transport.stream(...args),
        },
        modelId: 'test-model', vllmModelId: 'wire-model',
        openaiMessages: user, mergedOptions: scenario.options ?? {},
        serverConfig: {
          serverType: scenario.serverType, serverUrl: 'http://parity.invalid',
          requestHeaders: {}, initialResponseTimeoutMs: 0, streamInactivityTimeout: 0,
        },
        maxRetries: 1, signal: new AbortController().signal, log,
        limits: { wireModelId: 'wire-model', maxInputTokens: 1024, maxOutputTokens: 1024 },
      }, state)) {
        // Boundary markers (completion, restart) carry no StreamEvent fields;
        // the fixture response is built from content/reasoning/tool data only.
        if (!isAttemptCompletionEvent(chunk) && !('attemptRestart' in chunk)) chunks.push(chunk);
      }
      const response = {
        content: chunks.map((chunk) => chunk.content).join(''),
        reasoning: chunks.map((chunk) => chunk.reasoning_content ?? '').join(''),
        toolCalls: chunks.flatMap((chunk) => chunk.finishedToolCalls),
        finishReason: chunks.filter((chunk) => chunk.finishReason).pop()?.finishReason ?? null,
        usage: chunks.filter((chunk) => chunk.usage).pop()?.usage ?? null,
      };
      cases.push({ ...scenario, messages: user, expect: { requests, response } });
    } finally {
      vi.unstubAllGlobals();
    }
  }
  return JSON.stringify({
    format: 1,
    oracle: 'ChatTransport + executeChatRequest',
    note: 'Single-choice deterministic scenarios with fixed tool IDs. Times and accounting records are excluded.',
    cases,
  }, null, 2) + '\n';
}

function ladder(input: string): object | null {
  return parseToolCallArgs({ id: 'parity', name: 'probe', arguments: input });
}

function buildFixtures(): string {
  const cases = INPUTS.map((input) => ({ input, expect: ladder(input) }));
  return (
    JSON.stringify(
      {
        format: 1,
        oracle: 'src/core/request/sseParser.ts::parseToolCallArgs',
        note: 'Pinned VALUE, not tier label (gateway tiers are its own honest account). null = unparseable: the extension returns null, the gateway reports Unparseable.',
        cases,
      },
      null,
      2,
    ) + '\n'
  );
}

describe('parity fixtures (repair ladder export)', () => {
  const json = buildFixtures();
  const sha256 = createHash('sha256').update(json).digest('hex');

  it('the ladder never throws and only yields objects or null', () => {
    for (const input of INPUTS) {
      const out = ladder(input);
      const ok = out === null || (typeof out === 'object' && !Array.isArray(out));
      expect(ok, `input ${JSON.stringify(input)} gave ${JSON.stringify(out)}`).toBe(true);
    }
  });

  it('original vitest pins still hold (messageConverter.test.ts set)', () => {
    expect(ladder('')).toEqual({});
    expect(ladder('{}')).toEqual({});
    expect(ladder('{"a":1}')).toEqual({ a: 1 });
    expect(ladder('{"path":"/foo')).not.toBeNull();
    const truncated = ladder('{"path":"foo.ts","content":"def hello():\n    print(');
    expect((truncated as { path?: string }).path).toBe('foo.ts');
    expect(String((truncated as { content?: string }).content)).toContain('def hello');
    expect(ladder('\u0000\u0001\u0002')).toBeNull();
    expect(ladder('[1,2]')).toBeNull();
  });

  if (EXPORT) {
    it('exports parity artifacts', async () => {
      const scenarioJson = await buildScenarios();
      mkdirSync(DIR, { recursive: true });
      writeFileSync(path.join(DIR, FIXTURES_FILE), json);
      const manifest = {
        [FIXTURES_FILE]: { sha256, cases: INPUTS.length, format: 1 },
        [SCENARIOS_FILE]: {
          sha256: createHash('sha256').update(scenarioJson).digest('hex'),
          cases: scenarios.length, format: 1,
        },
      };
      writeFileSync(path.join(DIR, SCENARIOS_FILE), scenarioJson);
      writeFileSync(path.join(DIR, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
    });
  } else {
    it('committed artifacts match the current ladder (run npm run parity:export after intentional changes)', async () => {
      const fixturesPath = path.join(DIR, FIXTURES_FILE);
      expect(existsSync(fixturesPath), `missing ${FIXTURES_FILE}`).toBe(true);
      expect(readFileSync(fixturesPath, 'utf8')).toBe(json);
      const manifestPath = path.join(DIR, MANIFEST_FILE);
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
        string,
        { sha256: string }
      >;
      expect(manifest[FIXTURES_FILE].sha256).toBe(sha256);
      const scenarioJson = await buildScenarios();
      expect(readFileSync(path.join(DIR, SCENARIOS_FILE), 'utf8')).toBe(scenarioJson);
      expect(manifest[SCENARIOS_FILE].sha256).toBe(createHash('sha256').update(scenarioJson).digest('hex'));
    });
  }
});
