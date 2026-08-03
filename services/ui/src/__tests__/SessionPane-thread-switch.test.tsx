/**
 * The browser pane must not carry one thread's URL into another thread's write.
 *
 * `app/chat/[threadId]/page.tsx` renders `<ChatLayout activeThreadId={threadId}/>`
 * with no `key`; ChatLayout renders ChatView with no `key`; ChatView renders
 * SessionPane with no `key`; SessionPane renders BrowserView with no `key`. So
 * /chat/A → /chat/B changes the prop through four levels WITHOUT remounting.
 *
 * WHY THIS IS NOT COSMETIC. `urlInput` is not a display field. It is the body of
 * a write:
 *
 *     const target = urlInput.trim()
 *     await fetch(`/api/chat/${threadId}/browser-navigate`, {
 *       method: 'POST', body: JSON.stringify({ url: finalUrl }) })
 *
 * so a URL carried over from thread A navigates thread B's browser. Same shape as
 * app#181.
 *
 * TWO FAULTS, ONE TEST EACH, BECAUSE NEITHER FIX CLOSES THE OTHER:
 *
 *   1. A late response from the thread you LEFT writes state — needs the ref
 *      guard. With only the reset, A's response still lands on B.
 *   2. The new thread INHERITS the old thread's URL with no late response at all,
 *      because a 404 returns early without touching `urlInput` — needs the reset.
 *      With only the ref guard, B's own 404 is current, so nothing clears it. The
 *      screenshot is inherited with it, which suppresses the `error && !screenshot`
 *      empty state, so B silently renders A's page under A's URL.
 *
 * Both were confirmed red by reverting each half separately; see the PR.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('@/app/chat/XTerminal', () => ({
  default: ({ threadId }: { threadId: string }) => <div>XTerminal: {threadId}</div>,
}))
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

const urlBox = () => screen.getByTestId('browser-url-input') as HTMLInputElement

/** Screenshot responses that resolve only when their thread's gate is called. */
function deferredScreenshots() {
  const gates: Record<string, (body: unknown) => void> = {}
  mockFetch.mockImplementation((url: string) => {
    const m = /^\/api\/chat\/([^/]+)\/screenshot$/.exec(String(url))
    if (m) {
      return new Promise((resolve) => {
        gates[m[1]] = (body: unknown) => resolve(body)
      })
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
  })
  return gates
}

const screenshotOf = (threadUrl: string) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ screenshot: 'data:image/png;base64,AAAA', url: threadUrl }),
})

const notActive = { ok: false, status: 404, json: () => Promise.resolve({}) }

describe('SessionPane browser pane across a thread switch', () => {
  beforeEach(() => { mockFetch.mockReset() })
  afterEach(() => cleanup())

  it('FAULT 1: a late response from the thread you left does not overwrite the URL box', async () => {
    const gates = deferredScreenshots()

    const { rerender } = render(<SessionPane threadId="thread-a" initialTab="browser" />)
    await waitFor(() => expect(gates['thread-a']).toBeTypeOf('function'))

    // Navigate to B. Same component instance — no key anywhere down the chain.
    rerender(<SessionPane threadId="thread-b" initialTab="browser" />)
    await waitFor(() => expect(gates['thread-b']).toBeTypeOf('function'))

    gates['thread-b'](screenshotOf('https://b.example/current'))
    await waitFor(() => expect(urlBox().value).toBe('https://b.example/current'))

    gates['thread-a'](screenshotOf('https://a.example/left-behind')) // lands LATE
    await new Promise((r) => setTimeout(r, 50))

    // Pressing Enter here POSTs this value to /api/chat/thread-b/browser-navigate.
    expect(urlBox().value).toBe('https://b.example/current')
  })

  it('FAULT 2: a new thread does not INHERIT the previous thread\'s URL', async () => {
    // No deferral and no late response: every response is prompt and belongs to
    // the thread that asked for it. The fault is inheritance, not a race.
    mockFetch.mockImplementation((url: string) => {
      const m = /^\/api\/chat\/([^/]+)\/screenshot$/.exec(String(url))
      if (m) {
        return Promise.resolve(
          m[1] === 'thread-a' ? screenshotOf('https://a.example/private') : notActive,
        )
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    })

    const { rerender } = render(<SessionPane threadId="thread-a" initialTab="browser" />)
    await waitFor(() => expect(urlBox().value).toBe('https://a.example/private'))

    // Thread B's browser is not active, so its screenshot 404s. That path returns
    // at the status check without touching urlInput, so nothing overwrites what
    // was inherited — and a poll interval later, still nothing does.
    rerender(<SessionPane threadId="thread-b" initialTab="browser" />)

    // Reaching the empty state IS the assertion's positive control, and it is only
    // reachable once the inherited screenshot is cleared: the branch that renders
    // it is `if (error && !screenshot)`, so a retained screenshot suppresses it and
    // the pane instead draws thread A's page under thread A's URL, with no error.
    await waitFor(() => expect(screen.getByTestId('browser-inactive')).toBeInTheDocument())

    // The URL box is the write body. It must not exist holding A's value, and A's
    // page must not be on screen either. Queried rather than asserted through
    // urlBox() so this states the absence directly, whichever branch rendered.
    expect(screen.queryByDisplayValue('https://a.example/private')).not.toBeInTheDocument()
    expect(screen.queryByTestId('browser-screenshot')).not.toBeInTheDocument()
    expect(screen.queryByTestId('browser-url-input')).not.toBeInTheDocument()
  })

  // Guard rail: the ordinary case must still work, or the reset has just broken
  // the pane instead of fixing it.
  it('still shows the current thread\'s URL in the ordinary case', async () => {
    mockFetch.mockImplementation((url: string) => {
      const m = /^\/api\/chat\/([^/]+)\/screenshot$/.exec(String(url))
      if (m) return Promise.resolve(screenshotOf(`https://${m[1]}.example/page`))
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
    })

    const { rerender } = render(<SessionPane threadId="thread-a" initialTab="browser" />)
    await waitFor(() => expect(urlBox().value).toBe('https://thread-a.example/page'))

    rerender(<SessionPane threadId="thread-b" initialTab="browser" />)
    await waitFor(() => expect(urlBox().value).toBe('https://thread-b.example/page'))
  })
})
