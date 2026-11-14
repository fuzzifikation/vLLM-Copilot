/**
 * The embedded-GUI seam: a cookie-jar reverse proxy that lets a chromeless
 * webview panel host the harness UI, which Chromium otherwise refuses to let
 * any frame load.
 *
 * The problem, precisely: the harness authenticates its browser session with
 * an HttpOnly `SameSite=Strict` cookie (dsh-client-connection stamps the
 * attributes itself), the webview page lives on the `vscode-webview://`
 * origin, and Chromium never sends Strict cookies across that boundary — a
 * direct iframe only ever reaches the server's 401 text (certified the hard
 * way in 0.0.10/0.0.11, and upstream discussion 9002). The attributes are
 * BROWSER policy, not wire validation: to the harness, a `Cookie:` header is
 * a `Cookie:` header whoever wrote it. So the extension writes it.
 *
 * The shape: a loopback HTTP server on a stable port. It logs in to the
 * token-bearing harness URL once (following the 303 and keeping every
 * Set-Cookie in a server-side jar), strips cookies from what the webview
 * could store, and injects the jar into every forwarded request — plain,
 * SSE (`/plugins/events`), RPC POST, and the WebSocket upgrade alike (raw
 * socket splice after header rewrite; no `ws` dependency, keeping the
 * extension's zero-runtime-dependency rule). Same-origin from the page's
 * point of view, so relative routes, the module preload list, and the mux
 * WebSocket all just work.
 *
 * The gift that keeps giving: the port is stable across harness restarts,
 * so the one URL the panel (or a pinned browser window) holds never rots.
 * The token never enters the browser — the panel's iframe src carries no
 * secret, and a harness restart is a `setTarget` call plus an iframe reload,
 * not a new URL to chase.
 *
 * Security shape, honestly: bound to 127.0.0.1 only; the jar and the token
 * never leave the extension host. The door is a stable loopback port, which
 * is the SAME trust domain the harness itself publishes (any loopback process
 * can already read the token from the pid record); the proxy adds no new
 * exposure, and strips nothing from the harness's own request checks — Host
 * and Origin are rewritten to the harness's own origin, which is exactly
 * what its loopback trust check expects. In a remote window the panel's
 * Chromium sits on the CLIENT and reaches this loopback only through the
 * workbench's port forwarding; `allowOrigin` registers the forwarded origin
 * the extension resolved via asExternalUri, so panel traffic keeps its
 * same-origin word and a stranger on another origin still eats the 403.
 *
 * No `vscode` import: plain node, testable like `control-server.ts`.
 */
import { createServer, request as nodeRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect as netConnect } from 'node:net'

export interface EmbedProxyLog {
  info(message: string): void
  warn(message: string): void
  /** Debug tier: one line per proxied request and upgrade when present. */
  debug?(message: string): void
}

export interface EmbedProxyDeps {
  /** Preferred fixed port so the panel's URL survives harness restarts; 0 picks any free port. */
  port: number
  log: EmbedProxyLog
  /**
   * Same-origin back channel: the title beacon the proxy stamps into the
   * index POSTs the frame's document.title here (view id + title), and the
   * extension renames the owning panel. The parent.postMessage route stays
   * as a second opinion; either half arriving renames the tab.
   */
  onTitle?: (view: string, title: string) => void
  /**
   * The chord twin of the title beacon's back channel: the frame fetches
   * its unconsumed modifier chord to `/__dsh-key`, and the extension runs
   * it if it is on the whitelist. Same trust, same fire-and-forget shape,
   * because the parent.postMessage road has proven unreliable in webviews
   * and a shortcut may not depend on one hop.
   */
  onKey?: (chord: string) => void
}

/** The login walk hops at most this far before declaring the target unusable. */
const MAX_LOGIN_HOPS = 6

export class EmbedProxy {
  private server: Server | undefined
  private address: string | undefined
  private target: URL | undefined
  /** Cookie name → latest value. A harness restart rotates the values; setTarget clears the jar. */
  private jar = new Map<string, string>()
  private login: Promise<boolean> | undefined
  /** Live WebSocket relay legs, so close() can tear down what pipe() alone leaves hanging. */
  private readonly relays = new Set<import('node:stream').Duplex>()
  /**
   * Extra origins the panel legitimately carries when the webview's Chromium
   * fetches through a port-forwarding tunnel (remote SSH/WSL windows: the UI
   * process is on the CLIENT, the proxy on the SERVER, and the forwarded local
   * port may not equal the loopback port down here). The extension registers
   * what asExternalUri handed it; nothing else turns a same-origin fetch into
   * a jar ride.
   */
  private readonly forwardedOrigins = new Set<string>()

  constructor(private readonly deps: EmbedProxyDeps) {}

  /** Proxy root including port, e.g. http://127.0.0.1:43171. Undefined when not listening. */
  get url(): string | undefined {
    return this.address
  }

  async listen(): Promise<string> {
    if (this.address) return this.address
    const server = createServer((req, res) => void this.handle(req, res))
    server.on('upgrade', (req, socket, head) => void this.handleUpgrade(req, socket, head))
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.deps.port, '127.0.0.1', () => resolve())
      })
    } catch (err) {
      // A second window (or a leftover) holds the stable port: an ephemeral
      // port still serves this window, it just trades away URL stability.
      if (this.deps.port === 0) throw err
      this.deps.log.warn(`embed port ${this.deps.port} is taken; using an ephemeral port (the panel URL will not be stable across restarts)`)
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve())
      })
    }
    this.server = server
    const bound = server.address()
    if (bound === null || typeof bound === 'string') throw new Error('embed proxy did not bind to a TCP port')
    this.address = `http://127.0.0.1:${bound.port}`
    this.deps.log.info(`embed proxy listening at ${this.address}`)
    return this.address
  }

  close(): void {
    this.server?.close()
    this.server?.closeAllConnections()
    for (const relay of this.relays) relay.destroy()
    this.relays.clear()
    this.server = undefined
    this.address = undefined
  }

  /**
   * Point the proxy at a harness root (the token-bearing URL from the pid
   * record or the announcing window). Clears the jar: a new harness process
   * means a new session, and re-login is one hop.
   */
  setTarget(rawUrl: string): void {
    const next = new URL(rawUrl)
    if (this.target?.origin === next.origin && this.target?.pathname === next.pathname && String(this.target?.search) === String(next.search)) return
    this.target = next
    this.jar.clear()
    this.login = undefined
    this.deps.log.info(`embed proxy targeting harness at ${next.origin}`)
  }

  /** Perform (or join) the login walk. Resolves false when no target or the walk failed. */
  private ensureSession(): Promise<boolean> {
    if (this.jar.size > 0) return Promise.resolve(true)
    const target = this.target
    if (!target) return Promise.resolve(false)
    this.login ??= this.walkLogin(target).finally(() => {
      // A failed walk must be retryable: the harness may have needed a moment
      // (or a restart this window does not own); keeping the rejection cached
      // would wedge the panel until the next explicit setTarget.
      if (this.jar.size === 0) this.login = undefined
    })
    return this.login
  }

  private walkLogin(start: URL): Promise<boolean> {
    return new Promise((resolve) => {
      let next = start
      let hops = 0
      const hop = (): void => {
        const req = nodeRequest(
          {
            agent: false,
            host: next.hostname,
            port: next.port === '' ? 80 : Number(next.port),
            method: 'GET',
            path: `${next.pathname}${next.search}`,
            headers: { host: next.host, cookie: this.cookieHeader() },
          },
          (res) => {
            this.ingestCookies(res.headers['set-cookie'])
            const location = res.headers.location
            if (res.statusCode !== undefined && res.statusCode >= 300 && res.statusCode < 400 && location && hops < MAX_LOGIN_HOPS) {
              hops += 1
              next = new URL(location, next)
              // Redirects that leave the harness origin are a misconfiguration,
              // not a login chain: the jar check below decides, and a walk that
              // ends off-origin has acquired nothing.
              res.resume()
              hop()
              return
            }
            res.resume()
            const ok = this.jar.size > 0
            if (ok) this.deps.log.debug?.(`embed proxy acquired harness session cookie (${this.jar.size})`)
            else this.deps.log.warn('embed proxy login returned no session cookie')
            resolve(ok)
          },
        )
        req.on('error', (err: Error) => {
          this.deps.log.warn(`embed proxy login failed: ${err.message}`)
          resolve(false)
        })
        req.end()
      }
      hop()
    })
  }

  private cookieHeader(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  private ingestCookies(raw: string[] | undefined): void {
    for (const line of raw ?? []) {
      const pair = line.split(';')[0] ?? ''
      const eq = pair.indexOf('=')
      if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }

  /**
   * Whitelist one origin the webview really carries when its requests reach
   * this proxy through a forwarded port (remote windows). Called by the
   * extension with the origin `asExternalUri` returned for this proxy root.
   * Idempotent; clearing happens only with close(), a fresh proxy.
   */
  allowOrigin(origin: string): void {
    if (!origin) return
    const normalized = origin.replace(/\/+$/, '')
    if (normalized && !this.forwardedOrigins.has(normalized)) {
      this.forwardedOrigins.add(normalized)
      this.deps.log.info(`embed proxy accepts forwarded origin ${normalized}`)
    }
  }

  /** Rewrite absolute same-target Location headers so the browser stays on the proxy. */
  private rewriteLocation(location: string | undefined): string | undefined {
    if (!location || !this.target || !this.address) return location
    if (location.startsWith(this.target.origin)) return this.address + location.slice(this.target.origin.length)
    return location
  }

  /**
   * The drive-by gate. The browser traffic this proxy may serve is exactly
   * two things: same-origin requests from the harness panel's own document
   * (beacons, app traffic, websockets) and the GET navigations whose fetch
   * destination says iframe/document - the one jump from the webview shell
   * into this origin. Anything that announces itself - Origin header or
   * Sec-Fetch-* - as coming from ANY other site, including other local
   * ports, is refused before it reads a byte, rings a beacon, or rides the
   * cookie jar the harness's SameSite=Strict defense keeps browsers away
   * from. Requests carrying no browser identity are local tools, the same
   * trust domain the harness itself grants them; only the browser's own
   * word can condemn a request.
   */
  private crossSite(req: IncomingMessage): boolean {
    const origin = req.headers.origin
    if (typeof origin === 'string' && origin !== this.address && !this.forwardedOrigins.has(origin.replace(/\/+$/, ''))) return true
    const site = req.headers['sec-fetch-site']
    if (typeof site !== 'string' || site === 'same-origin' || site === 'none') return false
    const method = (req.method ?? 'GET').toUpperCase()
    const dest = req.headers['sec-fetch-dest']
    return !((method === 'GET' || method === 'HEAD') && (dest === 'iframe' || dest === 'document'))
  }

  private refuse(req: IncomingMessage, res: ServerResponse): void {
    this.deps.log.debug?.(`embed proxy refused a foreign request (${req.headers['sec-fetch-site'] ?? req.headers.origin ?? '?'}) for ${(req.url ?? '/').split('?')[0]}`)
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'cross-origin request refused' }))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.crossSite(req)) {
      this.refuse(req, res)
      return
    }
    if ((req.url ?? '').startsWith('/__dsh-title')) {
      // The beacon's own report: writes one string into the extension's map,
      // reads nothing, so it answers before auth and forwards nothing.
      const q = new URL(req.url ?? '/', 'http://127.0.0.1')
      const view = q.searchParams.get('v') ?? ''
      const title = q.searchParams.get('t') ?? ''
      this.deps.log.debug?.(`embed title beacon${view ? ` (${view})` : ''}: ${title}`)
      this.deps.onTitle?.(view, title)
      res.writeHead(204)
      res.end()
      return
    }
    if ((req.url ?? '').startsWith('/__dsh-key')) {
      // The chord's own report, shaped exactly like the title's: writes one
      // string into the extension, reads nothing, so it answers pre-auth and
      // forwards nothing.
      const q = new URL(req.url ?? '/', 'http://127.0.0.1')
      const chord = q.searchParams.get('c') ?? ''
      this.deps.log.debug?.(`embed key beacon: ${chord}`)
      if (chord) this.deps.onKey?.(chord)
      res.writeHead(204)
      res.end()
      return
    }
    const target = this.target
    if (!target) {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'harness is not started' }))
      return
    }
    this.deps.log.debug?.(`embed ${req.method} ${(req.url ?? '/').split('?')[0]}`)
    if (!(await this.ensureSession())) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'harness session unavailable' }))
      return
    }
    const headers: Record<string, string | string[]> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue
      const lower = k.toLowerCase()
      // Host/Origin/Referer become the harness's own (its loopback trust check
      // reads Host; Origin checks see a same-origin page); Cookie becomes the
      // jar; hop-by-hop and browser-identity headers are ours to manage.
      // accept-encoding is dropped so the HTML injection below always sees text,
      // never gzip bytes it must not touch.
      if (['host', 'origin', 'referer', 'cookie', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'accept-encoding', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions'].includes(lower)) continue
      headers[lower] = v as string | string[]
    }
    headers['host'] = target.host
    headers['origin'] = target.origin
    if (this.jar.size > 0) headers['cookie'] = this.cookieHeader()
    const upstream = nodeRequest({ agent: false, host: target.hostname, port: target.port === '' ? 80 : Number(target.port), method: req.method, path: req.url, headers }, (up) => {
      this.ingestCookies(up.headers['set-cookie'])
      const status = up.statusCode ?? 502
      const isHtmlPage = status === 200 && String(up.headers['content-type'] ?? '').includes('text/html') && (req.url ?? '/').split('?')[0] === '/'
      const out: Record<string, string | string[]> = {}
      for (const [k, v] of Object.entries(up.headers)) {
        if (v === undefined) continue
        const lower = k.toLowerCase()
        // The jar lives here, not in the webview: the browser must not keep
        // cookie state it could not send anyway. Framing (length/chunking)
        // is Node's to decide on this response, never a copy of upstream's.
        if (lower === 'set-cookie' || lower === 'transfer-encoding' || lower === 'content-length') continue
        if (lower === 'location') {
          const rewritten = this.rewriteLocation(Array.isArray(v) ? v[0] : String(v))
          if (rewritten !== undefined) out['location'] = rewritten
          continue
        }
        out[lower] = v as string | string[]
      }
      if (isHtmlPage) {
        // The one page we own knowledge about: the GUI reflects the open chat
        // into document.title (dsh-client-ui-layout stamps it). A webview on
        // the other side of this proxy cannot read a cross-origin title, so
        // the server that renders the page whispers it to the parent frame
        // on change. No secrets, no DOM surgery, one fixed-shape message.
        const chunks: Buffer[] = []
        up.on('data', (c: Buffer) => chunks.push(c))
        up.on('end', () => {
          let body = Buffer.concat(chunks).toString('utf8')
          // Title beacon plus keyboard bridge: keydowns with a modifier (or F1)
          // that the app did not consume (defaultPrevented says it did) travel
          // to the shell as a normalized chord. VS Code 1.145 removed the old
          // vscode-keydown forwarding protocol, and DOM events cannot escape an
          // iframe, so this injected hop is the only lawful road for chords.
          const beacon = '<script>(()=>{if(window.top===window)return;const v=new URLSearchParams(location.search).get("dshView")||"";let t="";const s=()=>{const x=document.title;if(x===t)return;t=x;try{parent.postMessage({dshEmbedTitle:x,v:v},"*")}catch(e){}try{fetch("/__dsh-title?v="+encodeURIComponent(v)+"&t="+encodeURIComponent(x))}catch(e){}};s();setInterval(s,1500);document.addEventListener("keydown",(e)=>{if(e.repeat)return;if(!(e.ctrlKey||e.metaKey||e.key==="F1"||e.altKey))return;if(e.key==="Control"||e.key==="Meta"||e.key==="Alt"||e.key==="Shift")return;setTimeout(()=>{if(e.defaultPrevented)return;const n=e.key===","?"Comma":(e.key.length===1?e.key.toUpperCase():e.key);const c=(e.ctrlKey?"Ctrl+":"")+(e.metaKey&&!e.ctrlKey?"Cmd+":"")+(e.altKey?"Alt+":"")+(e.shiftKey&&e.key!=="Shift"?"Shift+":"")+n;try{parent.postMessage({dshKey:c,v:v},"*")}catch(e2){}try{fetch("/__dsh-key?c="+encodeURIComponent(c))}catch(e3){}},0)},true)})()</script>'
          const at = body.lastIndexOf('</body>')
          body = at >= 0 ? body.slice(0, at) + beacon + body.slice(at) : body + beacon
          out['content-length'] = String(Buffer.byteLength(body))
          res.writeHead(status, out)
          res.end(body)
        })
        return
      }
      res.writeHead(status, out)
      up.pipe(res)
    })
    upstream.on('error', (err: Error) => {
      this.deps.log.debug?.(`embed forward failed: ${err.message}`)
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'harness unavailable' }))
      } else res.destroy()
    })
    req.pipe(upstream)
  }

  /** WebSocket relay: rewrite the handshake, then splice raw bytes both ways. */
  private async handleUpgrade(req: IncomingMessage, client: import('node:stream').Duplex, head: Buffer): Promise<void> {
    if (this.crossSite(req)) {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      return
    }
    const target = this.target
    if (!target || !(await this.ensureSession())) {
      client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
      return
    }
    this.deps.log.debug?.(`embed ws upgrade ${(req.url ?? '/').split('?')[0]}`)
    const upstream = netConnect(Number(target.port) || 80, target.hostname)
    const fail = (): void => {
      this.relays.delete(upstream)
      client.destroy()
      upstream.destroy()
    }
    // pipe() only ends the peer on a clean FIN or an error; a destroyed
    // socket (tab closed, proxy reloaded) must tear the other leg down too,
    // or both ends hang each other's graceful close forever.
    this.relays.add(upstream)
    upstream.on('close', () => {
      this.relays.delete(upstream)
      client.destroy()
    })
    client.on('close', () => upstream.destroy())
    upstream.once('error', fail)
    client.once('error', fail)
    upstream.once('connect', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, `Host: ${target.host}`, `Origin: ${target.origin}`]
      for (const [k, v] of Object.entries(req.headers)) {
        const lower = k.toLowerCase()
        if (v === undefined) continue
        if (['host', 'origin', 'cookie'].includes(lower)) continue
        const value = Array.isArray(v) ? v.join(', ') : v
        lines.push(`${k}: ${value}`)
      }
      if (this.jar.size > 0) lines.push(`Cookie: ${this.cookieHeader()}`)
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length > 0) upstream.write(head)
      upstream.pipe(client)
      client.pipe(upstream)
    })
  }
}
