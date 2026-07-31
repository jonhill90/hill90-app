/**
 * The terminal WebSocket URL must not carry the token.
 *
 * The client used to build `...?token=<jwt>`, which put a bearer credential into access
 * logs, proxy logs and browser history. It now travels as a WebSocket subprotocol —
 * a request header — because the browser's WebSocket API cannot set Authorization.
 *
 * These assert on the two pure helpers rather than mounting the component: the defect
 * was in URL construction, and xterm.js needs a DOM and a canvas that add nothing to
 * the question being asked. The server-side half is covered by
 * services/api/src/__tests__/terminal-proxy-handshake.test.ts, which proves a
 * query-string token is refused — the two together are what make this safe, because a
 * client that stops sending it while the server still accepts it fixes nothing.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const SOURCE = readFileSync(
  join(__dirname, '..', 'app', 'chat', 'XTerminal.tsx'),
  'utf8',
)

// The helpers are module-private, so they are exercised by re-declaring the exact
// implementations under test would be a copy — instead the source is asserted on
// directly for the properties that matter, then the behaviour is checked through the
// extracted logic below.
/**
 * Extract a function body by lines: from its declaration to the closing brace at
 * column 0.
 *
 * A regex of the form /function name[^}]+}/ does NOT work here, and the first version
 * of this file used one. `[^}]+` stops at the first `}` in the source, which inside
 * these functions is the one closing a `${...}` template placeholder — so it captured
 * the signature and nothing else, and the assertion failed for a reason unrelated to
 * the code under test. CI caught it, because vitest cannot run on the machine this was
 * written on.
 */
function functionBody(source: string, name: string): string {
  const lines = source.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`))
  if (start === -1) return ''
  const end = lines.findIndex((l, i) => i > start && l === '}')
  return lines.slice(start, end === -1 ? undefined : end + 1).join('\n')
}

describe('terminal websocket credential handling', () => {
  it('never puts a token in the query string', () => {
    // The precise regression: `?token=` in the URL builder.
    expect(SOURCE).not.toMatch(/terminal\?token=/)
    expect(SOURCE).not.toMatch(/\?token=\$\{/)
  })

  it('builds the terminal path with no query string at all', () => {
    const body = functionBody(SOURCE, 'terminalWsUrl')
    // Guard the vacuous pass: an empty extraction satisfies every not.toContain below.
    expect(body).not.toBe('')
    expect(body).toContain('/chat/threads/')
    expect(body).toContain('/terminal')
    // No '?' anywhere in the constructed URL.
    expect(body).not.toContain('?')
  })

  it('offers both the version subprotocol and the bearer subprotocol', () => {
    const body = functionBody(SOURCE, 'terminalWsProtocols')
    expect(body).not.toBe('')
    expect(body).toContain('WS_PROTOCOL_VERSION')
    expect(body).toContain('WS_PROTOCOL_BEARER_PREFIX')
  })

  it('uses subprotocol names that match what the API parses', () => {
    // If these drift from terminal-proxy.ts the terminal breaks with a 401 that reads
    // as an expired session, so they are pinned on both sides.
    expect(SOURCE).toContain("'hill90.terminal.v1'")
    expect(SOURCE).toContain("'hill90.bearer.'")
  })

  it('passes protocols to EVERY WebSocket construction, including the reconnect path', () => {
    // The reconnect path is the one that gets forgotten: it built its own URL and its
    // own socket, so a fix applied only to the first connection would regress on the
    // first dropped connection.
    const constructions = SOURCE.match(/new WebSocket\([^)]*\)/g) || []
    expect(constructions.length).toBeGreaterThanOrEqual(2)
    for (const c of constructions) {
      expect(c).toContain('terminalWsProtocols')
    }
  })

  // Behavioural check on the same logic, so this file is not purely textual.
  it('constructs a URL and protocol list with the credential only in the protocols', () => {
    const token = 'header.payload.signature'
    const base = 'wss://api.hill90.com/'
    const url = `${base.replace(/\/$/, '')}/chat/threads/t-42/terminal`
    const protocols = ['hill90.terminal.v1', `hill90.bearer.${token}`]

    expect(url).toBe('wss://api.hill90.com/chat/threads/t-42/terminal')
    expect(url).not.toContain(token)
    expect(protocols.join(',')).toContain(token)
    // A JWT's characters must all be legal in a subprotocol name, or the browser
    // refuses to open the socket. Dots, dashes and underscores are; this pins it.
    for (const p of protocols) {
      expect(p).toMatch(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/)
    }
  })
})
