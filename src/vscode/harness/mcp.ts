/**
 * The editor MCP server: a minimal Model Context Protocol endpoint served on
 * the bridge's existing loopback control channel, so the harness's own
 * upstream `dsh-mcp-client` plugin can mount VS Code tools with zero dsh-side
 * code of ours.
 *
 * Why MCP instead of another bespoke plugin tool: every plugin tool costs a
 * vendor restage, a pnpm reinstall, a preset-child splice, and a certified
 * output contract. With MCP the tool list lives entirely on this side, and
 * adding the tenth editor tool touches no harness-side file at all.
 *
 * Scope, and it is deliberate: JSON-RPC 2.0 over single JSON messages.
 * `initialize`, `ping`, `tools/list`, `tools/call`, and notifications. No SSE,
 * no sessions, no batching, no sampling, no resources. The pinned
 * `@modelcontextprotocol/client` 2.0 (negotiating `2026-07-28`, older
 * `2025-11-25`) was read to certify exactly this much: it accepts a plain
 * `application/json` response, treats 405 on GET as "no streaming channel",
 * tolerates a missing session id, sends `notifications/initialized` as a
 * POST expecting 202, and aborts if the server echoes a protocol version it
 * did not offer. Echoing the client's version back is therefore both legal
 * and the only safe stateless move.
 *
 * No `vscode` import here: this file is protocol math over an injected tool
 * registry, testable in plain node. The tools themselves are built in
 * `harness.ts`, the only place allowed to know the editor API.
 */

/** One MCP tool: metadata the model sees, plus the editor-side executor. */
export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** Resolve with text the model reads. Throw or return isError for honest failures. */
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<{ text: string; isError?: boolean }>
}

export interface McpServerInfo {
  name: string
  version: string
}

/** JSON-RPC error codes we can produce: method not found, bad request. */
const NOT_FOUND = -32601
const INVALID_REQUEST = -32600

interface JsonRpcMessage {
  jsonrpc?: unknown
  id?: string | number | null
  method?: unknown
  params?: unknown
}

export interface McpReply {
  status: number
  /** Omitted for 202: notifications get an empty body by spec. */
  body?: unknown
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Only string/number ids exist in the wild; null is reserved for errors. */
function requestId(message: JsonRpcMessage): string | number | undefined {
  return typeof message.id === 'string' || typeof message.id === 'number' ? message.id : undefined
}

function reply(id: string | number, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id, result } }
}

function fail(id: string | number | null, code: number, message: string): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } }
}

/**
 * Handle one parsed request body. `body` is whatever `JSON.parse` produced;
 * `id` is absent for notifications, which get 202 and no response, exactly as
 * the spec demands and the pinned client expects.
 */
export async function handleMcpRequest(
  body: unknown,
  deps: { tools: () => McpTool[]; serverInfo: McpServerInfo; signal: AbortSignal },
): Promise<McpReply> {
  // The body already parsed (a parse failure is answered at the transport),
  // so a non-object here is a well-formed JSON-RPC REQUEST that makes no
  // sense: INVALID_REQUEST, not PARSE_ERROR. No id exists to answer.
  if (!isObject(body)) return fail(null, INVALID_REQUEST, 'expected a JSON object')
  const message = body as JsonRpcMessage
  const id = requestId(message)
  if (id === undefined) {
    // A notification: acknowledged, never answered. Unknown ones are ignored
    // on purpose, spec: notifications must not produce errors the sender
    // cannot route.
    return { status: 202 }
  }
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return fail(id, INVALID_REQUEST, 'expected { jsonrpc: "2.0", method, id }')
  }

  switch (message.method) {
    case 'initialize': {
      const params = isObject(message.params) ? message.params : {}
      // The client aborts on any version it did not offer, and it only ever
      // offers versions it implements, so echoing is safe across upgrades.
      const protocolVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25'
      return reply(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: deps.serverInfo.name, version: deps.serverInfo.version },
        instructions:
          'These tools act inside the user VS Code editor. Reads are workspace-scoped. ' +
          'Prefer run_terminal for anything the user should watch, and editor_ask when a decision belongs to the human.',
      })
    }
    case 'ping':
      return reply(id, {})
    case 'tools/list':
      return reply(id, {
        tools: deps.tools().map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      })
    case 'tools/call': {
      const params = isObject(message.params) ? message.params : {}
      const name = typeof params.name === 'string' ? params.name : ''
      const args = isObject(params.arguments) ? params.arguments : {}
      const tool = deps.tools().find((t) => t.name === name)
      // An unknown tool is a tool failure the model can correct, not a
      // protocol fault: content keeps the reason in the transcript instead
      // of whatever the client's RPC-error path decides to render.
      if (!tool) {
        return reply(id, {
          content: [{ type: 'text', text: `no such tool: ${JSON.stringify(name)}. Call tools/list to see what exists.` }],
          isError: true,
        })
      }
      try {
        const outcome = await tool.run(args, deps.signal)
        return reply(id, { content: [{ type: 'text', text: outcome.text }], ...(outcome.isError ? { isError: true } : {}) })
      } catch (err) {
        // Tool execution failure is content, not a protocol fault: the model
        // must read the reason, not watch the transport die.
        return reply(id, { content: [{ type: 'text', text: `tool ${name} failed: ${(err as Error).message}` }], isError: true })
      }
    }
    default:
      return fail(id, NOT_FOUND, `method not supported: ${message.method}`)
  }
}
