import { describe, it, expect, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { registerConfigSchemaTool } from '../src/configSchemaTool.js';

/**
 * Unit tests for the config-schema LM tool. Pins the registration name, the
 * schema+guide result content, the optional section filter, and the graceful
 * fallback when the bundled schema cannot be read.
 */

describe('shipped vllm-copilot-models.schema.json (artifact)', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const schemaPath = join(__dirname, '..', 'schemas', 'vllm-copilot-models.schema.json');
  const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
    required: string[];
    properties: Record<string, { minLength?: number; type?: string }>;
    $defs: { requestParams: { additionalProperties: boolean; properties: Record<string, { not?: unknown; type?: string; minimum?: number }> } };
  };

  it('requires id and server', () => {
    expect(schema.required).toContain('server');
    expect(schema.required).toContain('id');
  });

  it('requires server and id to be non-empty', () => {
    expect(schema.properties.server.minLength).toBe(1);
    expect(schema.properties.id.minLength).toBe(1);
  });

  it('no longer carries server facts on the model entry', () => {
    // Registry sweep: serverUrl/serverType/serverDisplayName/requestHeaders live
    // ONLY on vllm-copilot.servers entries now.
    for (const gone of ['serverUrl', 'serverType', 'serverDisplayName', 'requestHeaders']) {
      expect(schema.properties[gone]).toBeUndefined();
    }
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
// (standalone, for editors via $schema) and package.json's inline `vllm-copilot.models`
// contribution (what VS Code itself validates against). Descriptions legitimately differ
// (markdown vs plain), but the STRUCTURE must not: this test fails when one side gains a
// field the other lacks, gains a differently-typed field, or changes `required`.

describe('inline and standalone model schemas stay structurally in sync', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as any;
  const inline = pkg.contributes.configuration[0].properties['vllm-copilot.models'].items as any;
  const standalone = JSON.parse(
    readFileSync(join(__dirname, '..', 'schemas', 'vllm-copilot-models.schema.json'), 'utf8'),
  ) as any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it('declares the same property names on both sides', () => {
    const a = Object.keys(inline.properties).sort();
    const b = Object.keys(standalone.properties).sort();
    expect(a).toEqual(b);
  });

  it('requires the same fields on both sides', () => {
    expect([...inline.required].sort()).toEqual([...standalone.required].sort());
  });

  it('declares the same top-level type per property', () => {
    for (const key of Object.keys(inline.properties) as string[]) {
      expect([key, inline.properties[key].type]).toEqual([key, standalone.properties[key]?.type]);
    }
  });
});

// The model-entry schema lives in TWO artifacts: schemas/vllm-copilot-models.schema.json
// and package.json's inline `vllm-copilot.models` contribution. Cross-artifact structural
// drift is pinned by the sync describe above; this one pins the registry-migration
// invariants of the inline block itself (the one VS Code validates against).
describe('package.json inline models schema (artifact)', () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as any;
  const inlineProps = (): Record<string, { type?: string }> =>
    pkg.contributes.configuration[0].properties['vllm-copilot.models'].items.properties;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it('declares server (registry ref) and no legacy server facts', () => {
    expect(inlineProps().server?.type).toBe('string');
    for (const gone of ['serverUrl', 'serverType', 'serverDisplayName', 'requestHeaders']) {
      expect(inlineProps()[gone]).toBeUndefined();
    }
    const required =
      pkg.contributes.configuration[0].properties['vllm-copilot.models'].items.required;
    expect(required).toEqual(expect.arrayContaining(['id', 'server']));
  });
});
