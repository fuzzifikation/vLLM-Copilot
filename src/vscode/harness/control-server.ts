/**
 * The editor control channel: a loopback-only HTTP server exposing the MCP
 * endpoint the harness's own upstream `dsh-mcp-client` plugin dials, through
 * which the agent asks the editor to do editor things (see `mcp.ts` for the
 * protocol and `harness.ts` for the tools). The harness process and the
 * extension host are separate processes with no shared memory; this is the seam.
 *
 * Security shape, because "localhost HTTP server" is how malware trivia
 * starts: bound to 127.0.0.1 with a per-activation random bearer token, handed
 * to the harness ONLY through the generated overlay config of the MCP client
 * row. Every request must carry the token; timing-safe compare; bodies are
 * size-capped; no endpoint lists or serves anything beyond the injected tools.
 *
 * Drain integration: while a tool call executes, a marker file sits in the
 * active directory, so the existing "restart drains in-flight requests" logic
 * counts editor-side tool calls too. A registry edit mid-`npm build` waits.
 *
 * No `vscode` import: the transport and the markers are testable in plain
 * node; the tools themselves are injected by `harness.ts`.
 */
import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { handleMcpRequest, type McpTool } from './mcp.js'

export interface ControlServerLog {
  info(message: string): void
  warn(message: string): void
  /** Optional verbosity tier: one line per JSON-RPC request when present. */
  debug?(message: string): void
}

/** Requests are JSON-RPC, but `editor_open_diff` carries whole file contents. */
const MAX_BODY_BYTES = 1024 * 1024

export interface ControlServerDeps {
  token: string
  activeDir: string
  /**
   * The MCP surface: a lazily read tool registry (so the tool list can reflect
   * live editor state) and the identity announced at `initialize`.
   */
  mcp: { tools: () => McpTool[]; serverInfo: { name: string; version: string } }
  log: ControlServerLog
}

export class ControlServer {
  private server: Server | undefined
  private address: string | undefined

  constructor(private readonly deps: ControlServerDeps) {}

  /** Loopback URL including port, e.g. http://127.0.0.1:54321. Undefined when not listening. */
  get url(): string | undefined {
    return this.address
  }

  async listen(): Promise<string> {
    if (this.address) return this.address
    const server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    this.server = server
    const bound = server.address()
    if (bound === null || typeof bound === 'string') throw new Error('control server did not bind to a TCP port')
    this.address = `http://127.0.0.1:${bound.port}`
    // The port is not a secret (the token is), so it may be logged.
    this.deps.log.info(`editor control channel listening at ${this.address}`)
    return this.address
  }

  close(): void {
    this.server?.close()
    // close() only stops new connections; the harness's keep-alive sockets
    // stay open and hold the port against the next activation.
    this.server?.closeAllConnections()
    this.server = undefined
    this.address = undefined
  }

  private authorized(req: { headers: Record<string, string | string[] | undefined> }): boolean {
    const header = req.headers.authorization
    const presented = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : ''
    return timingSafeEqualString(presented, this.deps.token)
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const fail = (code: number, message: string): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: message }))
    }
    if (!this.authorized(req)) return fail(401, 'unauthorized')
    if (req.method === 'GET' && req.url === '/v1/ping') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, product: 'vllm-copilot-bridge' }))
      return
    }
    if (req.url === '/mcp') return this.handleMcp(req, res, fail)
    return fail(404, 'not found')
  }

  /**
   * One JSON-RPC message per POST, JSON responses only, no sessions. The
   * pinned client was read to confirm it tolerates exactly this: 405 on its
   * GET stream probe, 404 on the DELETE that closes a session we never
   * opened, 202 on notifications, and plain JSON bodies instead of SSE.
   */
  private async handleMcp(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    fail: (code: number, message: string) => void,
  ): Promise<void> {
    if (req.method === 'DELETE') return fail(404, 'this server keeps no MCP session to close')
    if (req.method !== 'POST') {
      // The client's GET carries `Accept: text/event-stream`; answering 405
      // is the spec's way of saying "no server-to-client channel here", and
      // the pinned client logs it and moves on.
      res.writeHead(405).end()
      return
    }
    let body: string
    try {
      body = await readCapped(req)
    } catch (err) {
      return fail(413, (err as Error).message)
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      // A parse failure gets a JSON-RPC error, not an HTTP 400: an SDK that
      // sees a transport-level error retries or dies; an RPC error reaches
      // the model as readable text.
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'request body is not valid JSON' } }))
      return
    }

    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) controller.abort()
    })
    // Only tool calls can take user-visible time (a build in the terminal);
    // metadata traffic never earns a drain marker.
    const toolName = mcpToolCallName(parsed)
    this.deps.log.debug?.(
      toolName !== undefined
        ? `mcp tools/call: ${toolName}`
        : `mcp ${mcpMethodOf(parsed)}`,
    )
    // The marker is a drain hint, never a gate: a filesystem that refuses it
    // must not be allowed to kill the request (active-marker writes are
    // best-effort everywhere else for exactly this reason).
    let marker: string | undefined
    if (toolName !== undefined) {
      try {
        marker = this.writeMarker(toolName)
      } catch (err) {
        this.deps.log.warn(`active marker could not be written (a restart may under-count this tool call): ${(err as Error).message}`)
      }
    }
    try {
      const out = await handleMcpRequest(parsed, {
        tools: this.deps.mcp.tools,
        serverInfo: this.deps.mcp.serverInfo,
        signal: controller.signal,
      })
      if (out.body === undefined) {
        res.writeHead(out.status).end()
        return
      }
      res.writeHead(out.status, { 'content-type': 'application/json' })
      // Tool output is user data (file contents, terminal text) and never
      // enters the extension log.
      res.end(JSON.stringify(out.body))
    } catch (err) {
      this.deps.log.warn(`mcp request failed: ${(err as Error).message}`)
      fail(500, (err as Error).message)
    } finally {
      if (marker) rmSync(marker, { force: true })
    }
  }

  private writeMarker(label: string): string {
    mkdirSync(this.deps.activeDir, { recursive: true })
    const file = path.join(this.deps.activeDir, `tool-${randomUUID()}.json`)
    writeFileSync(file, JSON.stringify({ kind: 'mcp-tool', startedAt: new Date().toISOString(), label: label.slice(0, 120) }))
    return file
  }
}

/** The tool name when this message is an executing `tools/call`, else undefined. */
/** Best-effort JSON-RPC method name for debug visibility (batches fold to one label). */
function mcpMethodOf(parsed: unknown): string {
  if (Array.isArray(parsed)) return `batch(${parsed.length})`
  if (parsed && typeof parsed === 'object' && 'method' in parsed) {
    const m = (parsed as { method: unknown }).method
    if (typeof m === 'string') return m
  }
  return 'request'
}

function mcpToolCallName(parsed: unknown): string | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const v = parsed as Record<string, unknown>
  if (v.method !== 'tools/call') return undefined
  if (typeof v.id !== 'string' && typeof v.id !== 'number') return undefined
  const params = typeof v.params === 'object' && v.params !== null ? (v.params as Record<string, unknown>) : {}
  return typeof params.name === 'string' ? params.name : 'mcp-tool'
}

function readCapped(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let oversize = false
    req.on('data', (chunk: Buffer) => {
      if (oversize) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // Do NOT destroy: the caller still owes this client a 413 body, and a
        // destroyed socket delivers nothing. Drain the rest unbuffered so the
        // response can flush and the connection close cleanly.
        oversize = true
        req.resume()
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!oversize) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

/** Both operands are our own length-bounded strings; constant-time within that bound is enough. */
function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
