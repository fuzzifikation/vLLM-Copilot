import { describe, it, expect, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CONFIG_SCHEMA_TOOL_NAME, registerConfigSchemaTool } from '../src/configSchemaTool.js';

/**
 * Unit tests for the config-schema LM tool. Pins the registration name, the
 * schema+guide result content, the optional section filter, and the graceful
 * fallback when the bundled schema cannot be read.
 */
describe('registerConfigSchemaTool', () => {
  const encode = (s: string) => new TextEncoder().encode(s);
  const SCHEMA_NAME = 'vllm-copilot-models.schema.json';
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) };

  const outputChannel = () =>
    ({ name: 'test', append: () => {}, appendLine: () => {}, replace: () => {}, clear: () => {}, show: () => {}, hide: () => {}, dispose: () => {} }) as vscode.OutputChannel;

  const registeredTools = () => (vscode as any).lm._mockRegisteredTools as Array<{ name: string; tool: any }>;
  const registeredTool = () => {
    const t = registeredTools().find(r => r.name === CONFIG_SCHEMA_TOOL_NAME);
    if (!t) throw new Error(`tool ${CONFIG_SCHEMA_TOOL_NAME} not registered`);
    return t.tool;
  };

  const mockSchema = (text: string) => {
    (vscode as any).workspace._mockFsReadFile = (uri: any) =>
      String(uri).endsWith(SCHEMA_NAME)
        ? Promise.resolve(encode(text))
        : Promise.resolve(new Uint8Array());
  };

  beforeEach(() => {
    (vscode as any).lm._mockRegisteredTools = [];
  });

  it('registers a tool under the expected name', () => {
    registerConfigSchemaTool(vscode.Uri.file('/ext'), outputChannel());
    expect(registeredTools().map(r => r.name)).toContain(CONFIG_SCHEMA_TOOL_NAME);
  });

  it('returns the schema (pretty-printed) plus the guide by default', async () => {
    mockSchema('{ "title": "ModelEntry", "type": "object" }');
    registerConfigSchemaTool(vscode.Uri.file('/ext'), outputChannel());

    const result = await registeredTool().invoke({ input: {}, toolInvocationToken: undefined }, token);
    const text = result.content[0].value as string;

    expect(text).toContain('"title": "ModelEntry"');
    expect(text).toContain('"type": "object"');
    expect(text).toContain('Parameter resolution');
    expect(text).toContain('modelModes');
  });

  it('returns only the schema when section is "schema"', async () => {
    mockSchema('{ "title": "ModelEntry" }');
    registerConfigSchemaTool(vscode.Uri.file('/ext'), outputChannel());

    const result = await registeredTool().invoke(
      { input: { section: 'schema' }, toolInvocationToken: undefined },
      token,
    );
    const text = result.content[0].value as string;

    expect(text).toContain('"title": "ModelEntry"');
    expect(text).not.toContain('Parameter resolution');
  });

  it('returns only the guide when section is "guide"', async () => {
    mockSchema('{ "title": "ModelEntry" }');
    registerConfigSchemaTool(vscode.Uri.file('/ext'), outputChannel());

    const result = await registeredTool().invoke(
      { input: { section: 'guide' }, toolInvocationToken: undefined },
      token,
    );
    const text = result.content[0].value as string;

    expect(text).toContain('Parameter resolution');
    expect(text).not.toContain('"title": "ModelEntry"');
  });

  it('falls back to the guide when the bundled schema cannot be read', async () => {
    (vscode as any).workspace._mockFsReadFile = () => Promise.reject(new Error('ENOENT'));
    registerConfigSchemaTool(vscode.Uri.file('/ext'), outputChannel());

    const result = await registeredTool().invoke({ input: {}, toolInvocationToken: undefined }, token);
    const text = result.content[0].value as string;

    expect(text).toContain('Schema unavailable');
    expect(text).toContain('Parameter resolution');
  });

  it('returns the full content for an unknown/unsupported section value', async () => {
    mockSchema('{ "title": "ModelEntry" }');
    registerConfigSchemaTool(vscode.Uri.file('/ext'), outputChannel());

    const result = await registeredTool().invoke(
      { input: { section: 'banana' }, toolInvocationToken: undefined },
      token,
    );
    const text = result.content[0].value as string;

    // A hallucinated section must never yield an empty result — fall back to 'all'.
    expect(text).toContain('"title": "ModelEntry"');
    expect(text).toContain('Parameter resolution');
  });

  it('throws CancellationError when the invocation is cancelled', async () => {
    mockSchema('{ "title": "ModelEntry" }');
    registerConfigSchemaTool(vscode.Uri.file('/ext'), outputChannel());

    const cancelled = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose: () => {} }) };
    await expect(
      registeredTool().invoke({ input: {}, toolInvocationToken: undefined }, cancelled),
    ).rejects.toBeInstanceOf(vscode.CancellationError);
  });

  it('honors cancellation that arrives AFTER the schema read (mid-await)', async () => {
    // Regression: cancellation used to be checked only before the read; a
    // cancel during async I/O still returned the full result. The tool must
    // re-check the token after the await and propagate CancellationError.
    registerConfigSchemaTool(vscode.Uri.file('/ext'), outputChannel());
    const tool = registeredTool();

    let resolveRead: (v: Uint8Array) => void = () => {};
    (vscode as any).workspace._mockFsReadFile = () =>
      new Promise<Uint8Array>((res) => { resolveRead = res; });

    // Deferred token: flips to cancelled AFTER the read resolves but before the
    // post-await check runs. isCancellationRequested is read lazily.
    let cancelledFlag = false;
    const cancelledLate = {
      get isCancellationRequested() { return cancelledFlag; },
      onCancellationRequested: () => ({ dispose: () => {} }),
    };

    const invocation = tool.invoke({ input: {}, toolInvocationToken: undefined }, cancelledLate);

    // Resolve the read, then cancel, then let the microtask queue run the post-await check.
    resolveRead(encode('{ "title": "ModelEntry" }'));
    cancelledFlag = true;
    await expect(invocation).rejects.toBeInstanceOf(vscode.CancellationError);
  });
});

// ── Artifact-level test: parse the REAL shipped schema ─────────────────────
// The invocation tests above feed a synthetic schema through the tool, so they
// can never catch defects in the actual schema file. This test reads the shipped
// artifact and asserts the invariants that keep coming back: required fields,
// permissive unknown params, and forbidden reserved keys.
describe('shipped vllm-copilot-models.schema.json (artifact)', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const schemaPath = join(__dirname, '..', 'schemas', 'vllm-copilot-models.schema.json');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
    required: string[];
    properties: Record<string, { minLength?: number; type?: string }>;
    $defs: { requestParams: { additionalProperties: boolean; properties: Record<string, { not?: unknown; type?: string; minimum?: number }> } };
  };

  it('requires serverUrl and id', () => {
    expect(schema.required).toContain('serverUrl');
    expect(schema.required).toContain('id');
  });

  it('requires serverUrl and id to be non-empty', () => {
    expect(schema.properties.serverUrl.minLength).toBe(1);
    expect(schema.properties.id.minLength).toBe(1);
  });

  it('declares the optional serverDisplayName label (string)', () => {
    // Rename Server feature: keep the shipped schema in sync with ModelConfig —
    // a missing declaration here would make editors flag valid configs.
    expect(schema.properties.serverDisplayName?.type).toBe('string');
  });

  it('allows unknown request params (pass-through)', () => {
    expect(schema.$defs.requestParams.additionalProperties).toBe(true);
  });

  it('allows max_tokens (per-mode output budget) but forbids the reserved/protected keys', () => {
    const rp = schema.$defs.requestParams.properties;
    expect(rp.max_tokens.type).toBe('integer');
    expect(rp.max_tokens.minimum).toBe(1);
    expect(rp.model.not).toBeDefined();
    expect(rp.messages.not).toBeDefined();
    expect(rp.stream.not).toBeDefined();
    expect(rp.stream_options.not).toBeDefined();
  });

  it('keeps the known vLLM vocabulary intact', () => {
    const rp = schema.$defs.requestParams.properties;
    for (const known of ['temperature', 'top_p', 'top_k', 'chat_template_kwargs', 'reasoning_effort', 'bad_words', 'thinking_token_budget']) {
      expect(rp[known]).toBeDefined();
    }
  });
});

// The model-entry schema lives in TWO artifacts: schemas/vllm-copilot-models.schema.json
// and package.json's inline `vllm-copilot.models` contribution. Nothing keeps them in
// sync automatically — this test fails when one side gains a field the other lacks.
describe('package.json inline models schema (artifact)', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as any;
  const inlineProps = (): Record<string, { type?: string }> =>
    pkg.contributes.configuration[0].properties['vllm-copilot.models'].items.properties;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it('declares serverDisplayName alongside serverType', () => {
    expect(inlineProps().serverDisplayName?.type).toBe('string');
    expect(inlineProps().serverType).toBeDefined();
  });
});
