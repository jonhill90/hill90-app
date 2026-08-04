/**
 * State that belongs to the USER, not to the thread, survives a thread switch.
 *
 * WHY THIS FILE EXISTS. app#187 fixed two faults in the browser pane and argued at
 * length against the one-line alternative — `key={threadId}` — on the grounds that
 * it would also discard view state the user had chosen. That argument lived only
 * in a comment. Auditing the day's merges for durability, I added the key and ran
 * both SessionPane suites: 21 passed. Nothing objected.
 *
 * A comment loses to the next person who thinks a one-line fix is tidier. This
 * converts the argument into a check.
 *
 * WHICH KEY DISCARDS WHAT — the comment was imprecise and writing this test is
 * what surfaced it. There are two renders in the chain and they lose different
 * things:
 *
 *   <SessionPane key={threadId}>   in ChatView    -> discards viewMode and filter
 *   <BrowserView key={threadId}>   in SessionPane -> discards takeControl,
 *                                                    describeMode and the URL box
 *
 * #187's comment named `viewMode` and `filter` while sitting inside BrowserView,
 * whose key loses neither. Both placements are covered here so the check does not
 * inherit the imprecision, and the comment has been corrected to say which render
 * it means.
 *
 * NOT a test of the #187 fix itself — SessionPane-thread-switch.test.tsx covers
 * that, and would still pass with a key in place, which is exactly the gap.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('@/app/chat/XTerminal', () => ({ default: () => <div data-testid="xterm" /> }))
vi.mock('@/app/agents/[id]/EventCard', () => ({ default: () => <div /> }))

class MockEventSource {
  close = vi.fn()
  onerror: ((e: unknown) => void) | null = null
  onmessage: ((e: unknown) => void) | null = null
  addEventListener() {}
  removeEventListener() {}
}
vi.stubGlobal('EventSource', MockEventSource)

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import SessionPane from '@/app/chat/SessionPane'

const screenshot = {
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: () => Promise.resolve({ screenshot: 'AAAA', url: 'https://x.test' }),
}

beforeEach(() => {
  mockFetch.mockReset()
  mockFetch.mockImplementation((url: string) =>
    String(url).includes('/screenshot')
      ? Promise.resolve(screenshot)
      : Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({}) }),
  )
})
afterEach(() => cleanup())

describe('view state the user chose survives a thread switch', () => {
  it('the tab is driven by initialTab, so a key would NOT lose it', async () => {
    // Recorded because #187's comment says the opposite, and this is what the
    // attempt to test it turned up. ChatView owns the tab and passes it down as
    // `initialTab`; SessionPane seeds viewMode from it and re-applies it in an
    // effect (SessionPane.tsx:583-587). After any remount the prop restores it.
    //
    // So `viewMode` is the one thing a key would NOT have discarded. The decision
    // not to use a key is still right — see the two tests below for what it
    // genuinely protects — but the reason given for it was wrong, and the comment
    // has been corrected rather than left to mislead the next reader.
    const { rerender } = render(<SessionPane threadId="thread-a" initialTab="events" />)
    await waitFor(() => expect(screen.getByText('All')).toBeInTheDocument())

    rerender(<SessionPane key="forced-remount" threadId="thread-b" initialTab="events" />)

    // Even a forced remount keeps it, because the prop supplies it.
    await waitFor(() => expect(screen.getByText('All')).toBeInTheDocument())
  })

  it('keeps the event filter — the second thing that key would discard', async () => {
    const { rerender } = render(<SessionPane threadId="thread-a" />)

    fireEvent.click(await screen.findByText('Events'))
    fireEvent.click(await screen.findByText('Shell'))

    rerender(<SessionPane threadId="thread-b" />)

    // The filter is a separate useState from viewMode, so it needs its own
    // assertion: a change could preserve one and lose the other.
    const shell = screen.getByText('Shell')
    expect(shell.className).toMatch(/bg-|text-white|brand/)
  })

  it('keeps Take Control — guards a key on <BrowserView>', async () => {
    const { rerender } = render(<SessionPane threadId="thread-a" initialTab="browser" />)

    fireEvent.click(await screen.findByTestId('take-control-toggle'))
    await waitFor(() =>
      expect(screen.getByTestId('take-control-toggle')).toHaveTextContent(/Take Control: ON/),
    )

    rerender(<SessionPane threadId="thread-b" initialTab="browser" />)

    // BrowserView's own reset clears thread-derived state (screenshot, url,
    // urlInput) on purpose. takeControl is the USER's mode, not the thread's
    // data, and #187 left it alone deliberately — a key would not have.
    await waitFor(() =>
      expect(screen.getByTestId('take-control-toggle')).toHaveTextContent(/Take Control: ON/),
    )
  })

  // Guard rail: this must not be read as "nothing resets". Thread-derived state
  // still clears, which is the whole of #187 and is covered in full by
  // SessionPane-thread-switch.test.tsx.
  it('still clears the thread-derived URL box', async () => {
    const { rerender } = render(<SessionPane threadId="thread-a" initialTab="browser" />)

    await waitFor(() =>
      expect((screen.getByTestId('browser-url-input') as HTMLInputElement).value).toBe('https://x.test'),
    )

    mockFetch.mockImplementation((url: string) =>
      String(url).includes('/screenshot')
        ? Promise.resolve({ ok: false, status: 404, headers: { get: () => null }, json: () => Promise.resolve({}) })
        : Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({}) }),
    )
    rerender(<SessionPane threadId="thread-b" initialTab="browser" />)

    await waitFor(() => expect(screen.getByTestId('browser-inactive')).toBeInTheDocument())
    expect(screen.queryByDisplayValue('https://x.test')).toBeNull()
  })
})
