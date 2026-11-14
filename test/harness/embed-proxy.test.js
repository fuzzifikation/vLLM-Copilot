/**
 * Tripwires for the 2026-11-11 drive-by gate (review F1/F2). Named breakages:
 *  - the gate too strict: the panel's own traffic (iframe navigation from the
 *    webview shell, same-origin app fetches, beacons) stops working, which is
 *    the flagship feature dying quietly behind a 403 nobody logs;
 *  - the gate too loose: a page on another origin can ring /__dsh-key (chords
 *    execute as VS Code commands) or ride the injected session jar past the
 *    harness's SameSite=Strict defense.
 * Headerless local tools keep the harness's own trust domain: no test here
 * asks them to be refused.
 */
import { it, expect } from 'vitest'
import { createServer } from 'node:http'
import { EmbedProxy } from '../../src/vscode/harness/embed-proxy.js'

const log = { info() {}, warn() {}, debug() {} }

function fakeHarness() {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, cookie: req.headers.cookie })
    if (req.url === '/?token=***') {
      res.writeHead(303, { location: '/home' })
      res.end()
      return
    }
    if (req.url === '/home' && !req.headers.cookie) {
      res.writeHead(200, { 'set-cookie': 'dsh_session=s3cret; HttpOnly; SameSite=Strict' })
      res.end('login')
      return
    }
    if (req.url === '/home') {
      res.writeHead(200)
      res.end('home')
      return
    }
    if (req.url === '/api/turn') {
      if (req.headers.cookie !== 'dsh_session=s3cret') {
        res.writeHead(401)
        res.end('nope')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, seen, origin: `http://127.0.0.1:${server.address().port}` }),
    ),
  )
}

it('the embed proxy gate refuses foreign browser traffic and keeps every panel road open', async () => {
  const harness = await fakeHarness()
  const keys = []
  const proxy = new EmbedProxy({ port: 0, log, onKey: (c) => keys.push(c) })
  const addr = await proxy.listen()
  proxy.setTarget(`${harness.origin}/?token=***`)
  try {
    // A local tool without browser identity: forwarded, and with the session jar.
    let r = await fetch(`${addr}/api/turn`)
    expect(r.status).toBe(200)

    // The panel document's own traffic: same-origin, with the headers Chromium sends.
    r = await fetch(`${addr}/api/turn`, {
      headers: { origin: addr, 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' },
    })
    expect(r.status).toBe(200)

    // The one cross-site jump that exists: the webview shell loading the iframe.
    r = await fetch(`${addr}/home`, {
      headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe' },
    })
    expect(r.status).toBe(200)

    // Drive-by, shape one: a page on another origin pointing an <img> at the jar.
    r = await fetch(`${addr}/api/turn`, {
      headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'image' },
    })
    expect(r.status).toBe(403)

    // Drive-by, shape two: a foreign-origin form POST, riding the jar as its own.
    r = await fetch(`${addr}/api/turn`, { method: 'POST', headers: { origin: 'http://evil.example' } })
    expect(r.status).toBe(403)

    // The chord beacon: same-origin rings the workbench, cross-site never reaches it.
    r = await fetch(`${addr}/__dsh-key?c=Ctrl%2BW`)
    expect(r.status).toBe(204)
    expect(keys).toEqual(['Ctrl+W'])
    r = await fetch(`${addr}/__dsh-key?c=Ctrl%2BShift%2BP`, {
      headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'empty' },
    })
    expect(r.status).toBe(403)
    expect(keys).toEqual(['Ctrl+W'])

    // Beacons are answered here and never forwarded, refused or not.
    expect(harness.seen.some((s) => s.url.startsWith('/__dsh'))).toBe(false)
    // The refused forwards never touched the harness with the jar in hand.
    expect(harness.seen.filter((s) => s.url === '/api/turn').every((s) => s.cookie === 'dsh_session=s3cret')).toBe(true)
  } finally {
    proxy.close()
    harness.server.close()
  }
})

it('a forwarded remote window is the panel, an unregistered origin is still a drive-by', async () => {
  const harness = await fakeHarness()
  const proxy = new EmbedProxy({ port: 0, log })
  const addr = await proxy.listen()
  proxy.setTarget(`${harness.origin}/?token=***`)
  // What asExternalUri hands a remote window: the forwarded local port, not
  // the server-side one the proxy actually listens on.
  const tunneled = 'http://127.0.0.1:59999'
  proxy.allowOrigin(tunneled)
  try {
    // The panel's same-origin fetch, arriving with the tunnel origin: forwarded with the jar.
    let r = await fetch(`${addr}/api/turn`, {
      headers: { origin: tunneled, 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'empty' },
    })
    expect(r.status).toBe(200)
    // The chord beacon from the tunnel origin: rings the workbench.
    r = await fetch(`${addr}/__dsh-key?c=Ctrl%2BP`, { headers: { origin: tunneled, 'sec-fetch-site': 'same-origin' } })
    expect(r.status).toBe(204)
    // A foreign origin that merely guesses the tunnel shape: still refused.
    r = await fetch(`${addr}/api/turn`, { method: 'POST', headers: { origin: 'http://127.0.0.1:60001' } })
    expect(r.status).toBe(403)
    expect(harness.seen.some((s) => s.url === '/api/turn' && s.cookie !== 'dsh_session=s3cret')).toBe(false)
  } finally {
    proxy.close()
    harness.server.close()
  }
})
