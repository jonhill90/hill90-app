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
