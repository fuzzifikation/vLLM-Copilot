/**
 * Gate-2 fixtures. Every test names the breakage it catches; delete a test and
 * that named failure becomes shippable again. Backend: loopback wiretap mock,
 * never proof of real-backend compatibility (gate 4 owns that).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as core from 'vllm-copilot-core'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { createVllmcAdapter } from '../../dsh/plugin/adapter.js'
import { startDemoBackend } from './demo-backend.mjs'

const quietLog = { appendLine: () => {} }

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value) && !(value instanceof AbortSignal)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function buildSnapshot(baseUrl) {
  return {
    version: 1,
    config: {
      servers: [{ id: 's1', serverUrl: baseUrl, serverType: 'vllm', requestHeaders: { 'X-Test-Header': 'header-proof' } }],
      models: [
        {
          id: 'm1',
          server: 's1',
          vllmModelId: 'demo-model',
          displayName: 'Demo One',
          maxOutputTokens: 256,
          defaultParams: { temperature: 0.55, top_k: 20, chat_template_kwargs: { thinking: true } },
        },
        { id: 'cheap', server: 's1', vllmModelId: 'cheap-model', maxOutputTokens: 64 },
        {
          id: 'modes',
          server: 's1',
          vllmModelId: 'demo-model',
          maxOutputTokens: 128,
          defaultParams: { temperature: 0.55 },
          modelModes: { fast: { temperature: 0.2 }, smart: { temperature: 0.8 } },
          defaultMode: 'smart',
        },
      ],
    },
    defaultModelId: 'm1',
    aux: { 'session-title': { modelId: 'cheap', maxTokens: 64 } },
    maxRetries: 0,
  }
}

let backend
let outbox
let activeDir
let adapter

async function setup(snapshotMutate, extraDeps = {}) {
  const snapshot = buildSnapshot(backend.url)
  snapshotMutate?.(snapshot)
  adapter = createVllmcAdapter({ core, snapshot, deps: { outboxDir: outbox, activeDir, log: quietLog, ...extraDeps } })
}

function options(over = {}) {
  return deepFreeze({
    provider: 'vllmc',
    model: 'm1',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...over,
  })
}

async function collect(generator) {
  const chunks = []
  for await (const chunk of generator) chunks.push(chunk)
  return chunks
}

function userTurn(body) {
  return body.messages.find((m) => m.role === 'user')
}

beforeAll(async () => {
  backend = await startDemoBackend()
})
afterAll(async () => {
  await backend.close()
})
beforeEach(() => {
  backend.reset()
  core.clearRuntimeLimitsCache()
  outbox = mkdtempSync(path.join(tmpdir(), 'vllmc-outbox-'))
  activeDir = mkdtempSync(path.join(tmpdir(), 'vllmc-active-'))
})
afterEach(() => {
  rmSync(outbox, { recursive: true, force: true })
  rmSync(activeDir, { recursive: true, force: true })
  adapter = undefined
})

describe('request ownership (ruling 6)', () => {
  it('catches unconfigured passthrough: our params, headers, and budget reach the wire; harness vocabulary does not', async () => {
    await setup()
    const frozen = options()
    const before = JSON.stringify(frozen.messages)
    await collect(adapter.stream(frozen))

    const { headers, body } = backend.requests.at(-1)
    expect(body.model).toBe('demo-model')
    expect(body.temperature).toBe(0.55)
    expect(body.top_k).toBe(20)
    expect(body.chat_template_kwargs).toEqual({ thinking: true })
    expect(body.max_tokens).toBe(256)
    expect(body.stream).toBe(true)
    expect(headers['x-test-header']).toBe('header-proof')
    expect('compat' in body).toBe(false)
    expect('store' in body).toBe(false)

    // The loop deep-freezes GenerateOptions: a mutating adapter would have
    // thrown on frozen input, and a referencing adapter would leak harness
    // object identity into the wire body.
    expect(JSON.stringify(frozen.messages)).toBe(before)
    expect(body.messages).not.toBe(frozen.messages)
    expect(userTurn(body).content).toBe('hi')
  })

  it('catches mode-mapping loss: default mode applies without an effort, reasoningEffort selects a mode', async () => {
    await setup()
    await collect(adapter.stream(options({ model: 'modes' })))
    expect(backend.requests.at(-1).body.temperature).toBe(0.8)

    await collect(adapter.stream(options({ model: 'modes', reasoningEffort: 'fast' })))
    expect(backend.requests.at(-1).body.temperature).toBe(0.2)
  })
})

describe('system prompt projection', () => {
  it('catches lost loop prompts: a leading system message reaches the wire as system role', async () => {
    await setup()
    await collect(
      adapter.stream(
        options({
          messages: [
            { role: 'system', content: [{ type: 'text', text: 'LOOP PERSONA' }] },
            { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          ],
        }),
      ),
    )
    const body = backend.requests.at(-1).body
    expect(body.messages[0]).toEqual({ role: 'system', content: 'LOOP PERSONA' })
  })

  it('catches lost one-shot prompts: GenerateOptions.system becomes a leading system message', async () => {
    await setup()
    await collect(adapter.stream(options({ system: 'ONE SHOT' })))
    expect(backend.requests.at(-1).body.messages[0]).toEqual({ role: 'system', content: 'ONE SHOT' })
  })
})

describe('tool round-trip', () => {
  const toolCallChunks = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_time', arguments: '{"cit' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'y":"Paris"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
  ]

  it('catches name-splitting and argument corruption: finalized calls emit name exactly once with full arguments', async () => {
    await setup()
    backend.script({ chunks: toolCallChunks })
    const chunks = await collect(
      adapter.stream(
        options({
          tools: [{ name: 'get_time', description: 'clock', parameters: { type: 'object', properties: {} } }],
        }),
      ),
    )
    const nameDeltas = chunks.filter((c) => c.type === 'tool-call-delta' && c.name !== undefined)
    expect(nameDeltas).toHaveLength(1)
    const delta = chunks.find((c) => c.type === 'tool-call-delta')
    expect(delta.id).toBe('call_1')
    expect(delta.argumentsDelta).toBe('{"city":"Paris"}')
    const end = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'tool-call')
    expect(end.block).toEqual({ type: 'tool-call', id: 'call_1', name: 'get_time', arguments: '{"city":"Paris"}' })
    expect(chunks.at(-1).reason).toEqual({ kind: 'tool-calls' })

    const sentTool = backend.requests.at(-1).body.tools[0]
    expect(sentTool.function.name).toBe('get_time')
    expect(sentTool.function.parameters).toEqual({ type: 'object', properties: {} })
  })

  it('catches broken replay: assistant tool calls and error results return as wire messages', async () => {
    await setup()
    await collect(
      adapter.stream(
        options({
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'time?' }] },
            {
              role: 'assistant',
              content: [{ type: 'tool-call', id: 'call_1', name: 'get_time', arguments: '{"city":"Paris"}' }],
            },
            { role: 'tool', toolCallId: 'call_1', isError: true, content: [{ type: 'text', text: 'boom' }] },
          ],
        }),
      ),
    )
    const body = backend.requests.at(-1).body
    const assistant = body.messages.find((m) => m.role === 'assistant')
    expect(assistant.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{"city":"Paris"}' } },
    ])
    expect(body.messages).toContainEqual({ role: 'tool', tool_call_id: 'call_1', content: 'Error: boom' })
  })
})

describe('reasoning replay', () => {
  it('catches lost thinking: reasoning deltas stream as reasoning blocks and replay via the assistant reasoning field', async () => {
    await setup()
    backend.script({
      chunks: [
        { choices: [{ delta: { reasoning_content: 'thinking hard' } }] },
        { choices: [{ delta: { content: 'therefore 42' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
      ],
    })
    const chunks = await collect(adapter.stream(options()))
    expect(chunks.some((c) => c.type === 'block-start' && c.blockType === 'reasoning')).toBe(true)
    expect(chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')).toBe('thinking hard')
    const reasoningEnd = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'reasoning')
    expect(reasoningEnd.block.text).toBe('thinking hard')

    await collect(
      adapter.stream(
        options({
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            {
              role: 'assistant',
              content: [
                { type: 'reasoning', text: 'thinking hard' },
                { type: 'text', text: 'therefore 42' },
              ],
            },
            { role: 'user', content: [{ type: 'text', text: 'and again' }] },
          ],
        }),
      ),
    )
    const assistant = backend.requests.at(-1).body.messages.find((m) => m.role === 'assistant')
    expect(assistant.reasoning).toBe('thinking hard')
    expect(assistant.content).toBe('therefore 42')
  })
})

describe('usage accounting', () => {
  it('catches double-counted cache: dsh usage is cache-disjoint with the authoritative total preserved', async () => {
    await setup()
    backend.script({
      reply: 'ok',
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 100,
        total_tokens: 1100,
        prompt_tokens_details: { cached_tokens: 800 },
        completion_tokens_details: { reasoning_tokens: 40 },
      },
    })
    const chunks = await collect(adapter.stream(options()))
    const usage = chunks.at(-2)
    expect(usage.type).toBe('usage')
    expect(chunks.at(-1).type).toBe('finish')
    expect(usage.usage).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 1100,
      cacheReadTokens: 800,
      reasoningTokens: 40,
    })

    // The ledger needs the CORE aggregate (1000 prompt incl. cache), not the harness projection.
    const file = readdirSync(outbox)[0]
    const record = JSON.parse(readFileSync(path.join(outbox, file), 'utf8'))
    expect(record.lastRequest.promptTokens).toBe(1000)
    expect(record.lastRequest.cachedTokens).toBe(800)
    expect(record.lastRequest.modelId).toBe('demo-model')
  })
})

describe('retried turns (core attemptRestart contract)', () => {
  // The core yields a bare { attemptRestart: true } between attempts. The
  // first production adapter walked event.finishedToolCalls on it and died
  // with a TypeError on every retried turn, invisible because every fixture
  // pinned maxRetries to 0. These fixtures keep the retry leg of the contract
  // under current: nudge, colon continuation, per-attempt metering.
  function retrySnapshot(snapshot) {
    snapshot.maxRetries = 1
  }

  it('catches the retry crash: an empty-reply nudge ends as the retried answer, not a request failure', async () => {
    await setup(retrySnapshot)
    backend.script({ reply: '' }, { reply: 'RETRY-OK' })
    const chunks = await collect(adapter.stream(options()))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')
    expect(text).toBe('RETRY-OK')
    expect(backend.requests).toHaveLength(2)
    // Nudged first call was billed too: one metered record per attempt, and the
    // usage chunk carries the summed turn (2 x 500/40 from the demo default).
    expect(readdirSync(outbox)).toHaveLength(2)
    const usage = chunks.filter((c) => c.type === 'usage')
    expect(usage).toHaveLength(1)
    expect(usage[0].usage).toEqual({ inputTokens: 1000, outputTokens: 80, totalTokens: 1080 })
  })

  it('catches the merged replay: a colon continuation closes the streamed block before the retry opens its own', async () => {
    await setup(retrySnapshot)
    backend.script({ reply: 'wait:' }, { reply: 'the rest' })
    const chunks = await collect(adapter.stream(options()))
    const ends = chunks.filter((c) => c.type === 'block-end')
    expect(ends.map((c) => c.block.text)).toEqual(['wait:', 'the rest'])
    expect(ends[0].index).not.toBe(ends[1].index)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('catches unclean resolveModel failures: a dead server is a classified LlmError, never a raw core throw', async () => {
    await setup((snapshot) => {
      snapshot.config.servers[0].serverUrl = 'http://127.0.0.1:1'
    })
    await expect(adapter.resolveModel('vllmc', 'm1')).rejects.toBeInstanceOf(LlmError)
  })
})

describe('auxiliary calls', () => {
  it('catches premium-title burn: session-title routes to the snapshot cheap model and stays metered', async () => {
    await setup()
    await collect(adapter.stream(options({ purpose: 'session-title' })))
    expect(backend.requests.at(-1).body.model).toBe('cheap-model')
    expect(backend.requests.at(-1).body.max_tokens).toBe(64)
    const record = JSON.parse(readFileSync(path.join(outbox, readdirSync(outbox)[0]), 'utf8'))
    expect(record.purpose).toBe('session-title')
    expect(record.model).toBe('cheap')
  })
})

describe('cancellation', () => {
  it('catches a hung harness turn: abort mid-stream settles with an aborted finish, never a hang', async () => {
    await setup()
    backend.script({ chunks: [{ choices: [{ delta: { content: 'partial' } }] }], hold: true })
    const controller = new AbortController()
    const chunks = []
    for await (const chunk of adapter.stream(options({ signal: controller.signal }))) {
      chunks.push(chunk)
      if (chunk.type === 'text-delta') controller.abort()
    }
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } },
    })
  })
})

describe('restart drain markers', () => {
  it('catches a truncated in-flight turn: a marker exists while a request streams and clears when it ends', async () => {
    await setup()
    backend.script({ reply: 'drained' })
    expect(readdirSync(activeDir)).toEqual([])
    const iterator = adapter.stream(options())
    const first = await iterator.next()
    // The marker is down before the first chunk is handed back, so a restart
    // that begins now sees the request and waits instead of killing it.
    expect(readdirSync(activeDir)).toHaveLength(1)
    while (!(await iterator.next()).done) {
      /* drain to completion */
    }
    expect(readdirSync(activeDir)).toEqual([])
    expect(first.done).toBe(false)
  })

  it('catches a marker orphaned by an aborted turn: the finally clears it so the next restart is not wedged', async () => {
    await setup()
    backend.script({ chunks: [{ choices: [{ delta: { content: 'partial' } }] }], hold: true })
    const controller = new AbortController()
    for await (const chunk of adapter.stream(options({ signal: controller.signal }))) {
      if (chunk.type === 'text-delta') controller.abort()
    }
    expect(readdirSync(activeDir)).toEqual([])
  })
})

describe('error taxonomy', () => {
  async function expectLlmError(spec, code) {
    await setup()
    backend.script(spec, spec)
    await expect(collect(adapter.stream(options()))).rejects.toMatchObject({ name: 'LlmError', code })
  }

  it('catches leaked OpenAI envelopes: 401 maps to AUTH', () => expectLlmError({ status: 401, json: { error: { message: 'Invalid API key' } } }, 'AUTH'))
  it('catches silent rate-limit thrash: 429 maps to RATE_LIMIT', () => expectLlmError({ status: 429, errorText: 'Too Many Requests' }, 'RATE_LIMIT'))
  it('catches the unhelpful context error: overflow wording maps to CONTEXT_WINDOW_EXCEEDED', () =>
    expectLlmError(
      { status: 400, errorText: "This model's maximum context length is 4096 tokens, however you requested 9000 tokens" },
      'CONTEXT_WINDOW_EXCEEDED',
    ))

  it('catches LlmError class loss: thrown failures are dsh LlmError instances', async () => {
    await setup()
    backend.script({ status: 401, json: { error: { message: 'nope' } } }, { status: 401, json: { error: { message: 'nope' } } })
    await expect(collect(adapter.stream(options()))).rejects.toBeInstanceOf(LlmError)
  })

  it('catches silent model drift: unknown model ids fail loudly as INVALID_ARGS', async () => {
    await setup()
    await expect(collect(adapter.stream(options({ model: 'ghost' })))).rejects.toMatchObject({ name: 'LlmError', code: 'INVALID_ARGS' })
  })
})

describe('catalog for the GUI', () => {
  it('catches an empty model picker: listModels and resolveModel answer from the snapshot with probed windows', async () => {
    await setup()
    const models = await adapter.listModels('vllmc')
    expect(models.map((m) => m.id)).toEqual(['m1', 'cheap', 'modes'])

    const resolved = await adapter.resolveModel('vllmc', 'm1')
    expect(resolved.context.contextWindow).toBe(200000)
    expect(resolved.defaultMaxTokens).toBe(256)
    expect(resolved.name).toBe('Demo One')

    const withModes = await adapter.resolveModel('vllmc', 'modes')
    expect(withModes.reasoning.efforts.map((e) => e.id)).toEqual(['fast', 'smart'])
    expect(withModes.reasoning.defaultEffort).toBe('smart')
  })
})

describe('image forwarding', () => {
  const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const pngUrl = `data:image/png;base64,${Buffer.from(pngBytes).toString('base64')}`
  const ref = { attachmentId: 'sha256:0123456789abcdef', mediaType: 'image/png', bytes: 8, width: 64, height: 32, name: 'shot.png' }

  function withVision(snapshot) {
    snapshot.config.models.push({
      id: 'vision',
      server: 's1',
      vllmModelId: 'demo-model',
      maxOutputTokens: 128,
      capabilities: { toolCalling: true, imageInput: true },
    })
  }

  function fakeStore(readImage) {
    const calls = []
    return {
      calls,
      readImage: async (r, signal) => {
        calls.push(r.attachmentId)
        if (readImage) return readImage(r)
        return { ref: r, data: pngBytes }
      },
    }
  }

  function imageTurn(extra = []) {
    return [{ role: 'user', content: [{ type: 'text', text: 'look:' }, { type: 'image', attachment: ref }, ...extra] }]
  }

  it('catches the modality lie: imageInput capabilities reach the catalog and the resolved route', async () => {
    await setup(withVision)
    const models = await adapter.listModels('vllmc')
    expect(models.find((m) => m.id === 'vision').inputModalities).toEqual(['text', 'image'])
    expect(models.find((m) => m.id === 'm1').inputModalities).toEqual(['text'])
    const resolved = await adapter.resolveModel('vllmc', 'vision')
    expect(resolved.inputModalities).toEqual(['text', 'image'])
  })

  it('catches the blind eye: a pasted image reaches the wire as an image_url data URL', async () => {
    const store = fakeStore()
    await setup(withVision, { resolveAttachments: () => store })
    await collect(adapter.stream(options({ model: 'vision', messages: imageTurn() })))
    expect(userTurn(backend.requests.at(-1).body).content).toEqual([
      { type: 'text', text: 'look:' },
      { type: 'image_url', image_url: { url: pngUrl } },
    ])
    expect(store.calls).toEqual([ref.attachmentId])
  })

  it('catches the capability lie: a text-only model never reads the store and keeps the string placeholder', async () => {
    const store = fakeStore()
    await setup(withVision, { resolveAttachments: () => store })
    await collect(adapter.stream(options({ messages: imageTurn() })))
    expect(store.calls).toEqual([])
    expect(userTurn(backend.requests.at(-1).body).content).toBe('look:[image attached to this message; not forwarded by the bridge]')
  })

  it('catches the fake eye: a vision model without an attachment service degrades to honest text', async () => {
    await setup(withVision)
    await collect(adapter.stream(options({ model: 'vision', messages: imageTurn() })))
    expect(userTurn(backend.requests.at(-1).body).content).toBe('look:[image attached to this message; not forwarded by the bridge]')
  })

  it('catches the corrupt-bytes failure: one unreadable attachment placeholders, the turn still runs', async () => {
    const store = fakeStore(() => {
      throw new Error('attachment purged')
    })
    await setup(withVision, { resolveAttachments: () => store })
    const chunks = await collect(adapter.stream(options({ model: 'vision', messages: imageTurn() })))
    expect(chunks.at(-1).reason).toEqual({ kind: 'stop' })
    expect(userTurn(backend.requests.at(-1).body).content).toContain('not forwarded by the bridge')
  })

  it('catches re-reading an offloaded image: offloaded occurrences use harness text, the store stays untouched', async () => {
    const store = fakeStore()
    await setup(withVision, { resolveAttachments: () => store })
    await collect(
      adapter.stream(
        options({
          model: 'vision',
          messages: [{ role: 'user', content: [{ type: 'image', attachment: ref, offloaded: true }] }],
        }),
      ),
    )
    expect(store.calls).toEqual([])
    const content = userTurn(backend.requests.at(-1).body).content
    expect(typeof content).toBe('string')
    expect(content).toContain('image omitted to fit request image limits')
  })

  it('catches the dropped screenshot: an image in a tool result replays as wire parts', async () => {
    const store = fakeStore()
    await setup(withVision, { resolveAttachments: () => store })
    await collect(
      adapter.stream(
        options({
          model: 'vision',
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'read it' }] },
            { role: 'assistant', content: [{ type: 'tool-call', id: 'call_r', name: 'read_image', arguments: '{"path":"a.png"}' }] },
            { role: 'tool', toolCallId: 'call_r', content: [{ type: 'text', text: 'PNG 64x32' }, { type: 'image', attachment: ref }] },
          ],
        }),
      ),
    )
    const toolMsg = backend.requests.at(-1).body.messages.find((m) => m.role === 'tool')
    expect(toolMsg.content).toEqual([
      { type: 'text', text: 'PNG 64x32' },
      { type: 'image_url', image_url: { url: pngUrl } },
    ])
  })
})
