import http from 'node:http'

/**
 * OpenAI-compatible loopback mock: the deterministic wiretap. Records every
 * request (headers + parsed body), answers from a scripted queue with a
 * sensible default, and can hold a response open for cancellation tests.
 * Also answers /v1/models so the core's runtime-limits probe succeeds.
 */
export async function startDemoBackend({ models } = {}) {
  const served = models ?? [
    { id: 'demo-model', max_model_len: 200000 },
    { id: 'cheap-model', max_model_len: 8192 },
  ]
  const requests = []
  const queue = []
  const held = []

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && (req.url || '').includes('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: served.map((m) => ({ object: 'model', id: m.id, root: m.id, max_model_len: m.max_model_len })) }))
      return
    }
    if (req.method === 'POST' && (req.url || '').endsWith('/v1/chat/completions')) {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        let body
        try {
          body = JSON.parse(raw)
        } catch {
          // A test bug must fail the test, not kill the rail process with an
          // uncaught exception inside the request handler.
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'demo backend received a non-JSON request body' } }))
          return
        }
        requests.push({ headers: req.headers, body })
        const spec = queue.shift() ?? { reply: 'mock reply' }
        if (spec.status) {
          res.writeHead(spec.status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(spec.json ?? { error: { message: spec.errorText ?? 'mock error' } }))
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        const write = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        for (const chunk of spec.chunks ?? textChunks(spec.reply, spec.usage)) write(chunk)
        res.write('data: [DONE]\n\n')
        if (spec.hold) held.push(res)
        else res.end()
      })
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    script(...specs) {
      queue.push(...specs)
    },
    reset() {
      queue.length = 0
      requests.length = 0
    },
    close() {
      for (const res of held) res.destroy()
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

export function textChunks(text = 'mock reply', usage) {
  const chunks = []
  const size = 16
  for (let i = 0; i < String(text).length; i += size) {
    chunks.push({ choices: [{ delta: { content: String(text).slice(i, i + size) } }] })
  }
  chunks.push({ choices: [{ delta: {}, finish_reason: 'stop' }] })
  if (usage !== null) {
    chunks.push({ choices: [], usage: usage ?? { prompt_tokens: 500, completion_tokens: 40, total_tokens: 540 } })
  }
  return chunks
}
