/**
 * A terminal that stops must say why.
 *
 * Every close code except 4001/4002/1000 auto-reconnects with a server-refreshed
 * token and heals invisibly. So a code that neither reconnects nor says anything
 * leaves a dead pane the user reads as a network blip — while it is in fact the
 * one case they can act on.
 *
 * Before this, XTerminal returned silently on 4001 and wrote nothing. The api
 * terminal proxy now ends a session when its token expires (4002) and sends a
 * reason with it; this is what makes that reason reach a human.
 */
import { describe, it, expect } from 'vitest'
import {
  terminalCloseNotice,
  shouldReconnect,
  CLOSE_UNAUTHORIZED,
  CLOSE_CREDENTIAL_EXPIRED,
  CLOSE_ACCESS_REVOKED,
} from '@/app/chat/terminalClose'

describe('terminalCloseNotice', () => {
  it('explains an expired credential using the server reason', () => {
    const lines = terminalCloseNotice(CLOSE_CREDENTIAL_EXPIRED, 'credential expired')
    expect(lines).not.toBeNull()
    const text = (lines as string[]).join('')
    expect(text).toContain('credential expired')
    expect(text).toMatch(/reload/i)
  })

  it('explains a refused credential', () => {
    const text = (terminalCloseNotice(CLOSE_UNAUTHORIZED, '') as string[]).join('')
    expect(text).toContain('not authorized')
  })

  it('falls back to a stated reason when the server sends none', () => {
    const text = (terminalCloseNotice(CLOSE_CREDENTIAL_EXPIRED, undefined) as string[]).join('')
    expect(text).toContain('credential expired')
  })

  it('says nothing for a close that will reconnect', () => {
    expect(terminalCloseNotice(1006, '')).toBeNull()
    expect(terminalCloseNotice(1001, '')).toBeNull()
  })

  it('says nothing for a deliberate close', () => {
    expect(terminalCloseNotice(1000, '')).toBeNull()
  })
})

describe('shouldReconnect', () => {
  it('does not retry a credential problem — retrying repeats it', () => {
    expect(shouldReconnect(CLOSE_UNAUTHORIZED)).toBe(false)
    expect(shouldReconnect(CLOSE_CREDENTIAL_EXPIRED)).toBe(false)
  })

  it('does not retry a deliberate close', () => {
    expect(shouldReconnect(1000)).toBe(false)
  })

  it('retries a dropped connection, which is what heals a blip', () => {
    expect(shouldReconnect(1006)).toBe(true)
  })
})

/**
 * app#196: the api now closes a terminal with 4004 when the viewer is REMOVED
 * from the thread.
 *
 * The reconnect assertion is the load-bearing one. This module auto-reconnects on
 * every code it does not recognise, so a 4004 the ui did not know about would make
 * a removed user's terminal retry in a loop against an upgrade that now refuses
 * them — and say nothing while doing it. Adding a code to the api without adding
 * it here is a silent regression, which is why both halves are asserted.
 */
describe('a terminal closed because access was revoked', () => {
  it('does NOT reconnect — retrying cannot restore access that was taken away', () => {
    expect(shouldReconnect(CLOSE_ACCESS_REVOKED)).toBe(false)
  })

  it('tells the user why, rather than leaving a pane that reads as a blip', () => {
    const lines = terminalCloseNotice(CLOSE_ACCESS_REVOKED)
    expect(lines).not.toBeNull()
    expect(lines!.join('')).toMatch(/access revoked/i)
  })

  it('prefers the server\'s reason when it sends one', () => {
    const lines = terminalCloseNotice(CLOSE_ACCESS_REVOKED, 'access revoked')
    expect(lines!.join('')).toMatch(/access revoked/i)
  })

  it('is a distinct code from unauthorized and expired', () => {
    expect(CLOSE_ACCESS_REVOKED).not.toBe(4001)
    expect(CLOSE_ACCESS_REVOKED).not.toBe(4002)
  })
})
