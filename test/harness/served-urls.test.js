/**
 * Tripwires for the history the stale-tab sweep aims by. Named breakages:
 *  - a clobbered or unparseable history makes every future sweep blind, and
 *    the restored zombie tab eats the window's menus again;
 *  - a non-loopback URL slipping in means the sweep could one day match and
 *    close a tab for a host it never served;
 *  - a UI token landing in this plaintext file means every reader of the
 *    harness home holds a key to the harness GUI (2026-11-11 review F3).
 */
import { it, expect, describe } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendServedUrl, loopbackHostPort, readServedHostPorts, servedUrlsFile } from '../../src/vscode/harness/served-urls.js'

function freshFile() {
  return servedUrlsFile(mkdtempSync(join(tmpdir(), 'dshb-urls-')))
}

describe('served-url history', () => {
  it('records loopback origins, replaces the row of a reused host:port, and never stores a token', () => {
    const file = freshFile()
    appendServedUrl(file, 'http://127.0.0.1:4001/?token=old')
    appendServedUrl(file, 'http://127.0.0.1:4002/?token=fresh')
    appendServedUrl(file, 'http://127.0.0.1:4001/?token=reborn')
    const text = readFileSync(file, 'utf8')
    expect(text.trim().split('\n')).toEqual(['http://127.0.0.1:4002', 'http://127.0.0.1:4001'])
    expect(text).not.toContain('token')
    expect(readServedHostPorts(file)).toEqual(['127.0.0.1:4002', '127.0.0.1:4001'])
  })

  it('caps the file so a long life of restarts never grows it unbounded', () => {
    const file = freshFile()
    for (let port = 5000; port < 5025; port += 1) appendServedUrl(file, `http://127.0.0.1:${port}/`)
    const ports = readServedHostPorts(file)
    expect(ports.length).toBe(10)
    expect(ports[ports.length - 1]).toBe('127.0.0.1:5024')
    expect(ports).not.toContain('127.0.0.1:5014')
  })

  it('refuses anything that is not a plain http loopback URL', () => {
    const file = freshFile()
    const warned = []
    for (const url of ['https://127.0.0.1:9/', 'http://example.com:8080/', 'not a url', 'file:///c:/x']) {
      appendServedUrl(file, url, { warn: (m) => warned.push(m) })
    }
    expect(existsSync(file)).toBe(false)
    expect(readServedHostPorts(file)).toEqual([])
    expect(warned.length).toBe(4)
  })

  it('extracts the exact label a browser tab carries', () => {
    expect(loopbackHostPort('http://127.0.0.1:60648/?token=abc')).toBe('127.0.0.1:60648')
    expect(loopbackHostPort('http://localhost:1234/')).toBe('localhost:1234')
    expect(loopbackHostPort('http://0.0.0.0:1234/')).toBeUndefined()
    expect(loopbackHostPort('')).toBeUndefined()
  })
})
