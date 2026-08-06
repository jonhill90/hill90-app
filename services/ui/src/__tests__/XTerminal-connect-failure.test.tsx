/**
 * XTerminal.tsx's mount effect called connect() fire-and-forget:
 *
 *   connect().then((fn) => { cleanup = fn })
 *
 * with no .catch(). If connect() rejects at any point — the three dynamic
 * imports (`await import('xterm')` and its two addons) reject on a
 * chunk-load failure, an ordinary event after a redeploy invalidates a
 * cached chunk hash, or WebSocket construction itself throws — nothing
 * caught it. `connected` never flips true (it's only set deep inside the
 * WebSocket's onopen, which a rejected connect() never reaches), no error
 * state existed, and the pane just stayed empty forever with zero
 * indication why — the only one of the three findings from that sweep
 * reachable on the ordinary path, since the other two need the API to
 * misbehave.
 *
 * This test triggers the rejection at WebSocket construction rather than
 * the dynamic imports: vitest's own `vi.mock` factory mechanism reports a
 * factory that throws/rejects as a vitest-internal "unhandled error", not
 * as an ordinary rejected promise reaching the `await import('xterm')`
 * call site — so it can't cleanly stand in for a real chunk-load failure
 * without also tripping vitest's own error reporting. A synchronously-
 * throwing WebSocket constructor is a real failure mode connect() must
 * also survive (a malformed URL, or certain environment-specific
 * conditions), reaches the exact same unguarded `connect()` promise, and
 * is controllable without fighting the mocker.
 *
 * WHAT THIS TEST PROVES. That a rejected connect() surfaces a visible
 * message instead of leaving the pane silently dead — regardless of where
 * inside connect() the rejection originates.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { accessToken: 'tok', user: {} }, status: 'authenticated' }),
}))

vi.mock('xterm', () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    write() {}
    dispose() {}
    options: any = {}
    onData() { return { dispose() {} } }
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
    proposeDimensions() { return { cols: 80, rows: 24 } }
  },
}))
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('XTerminal: a failed connect() is visible, not silent', () => {
  it('POSITIVE CONTROL: shows an error message when WebSocket setup throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')))
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('WebSocket', class {
      constructor() {
        throw new Error('WebSocket construction failed (simulated)')
      }
    })

    const { default: XTerminal } = await import('../app/chat/XTerminal')
    render(<XTerminal threadId="thread-1" />)

    await waitFor(() => {
      expect(screen.getByText(/failed to load the terminal/i)).toBeInTheDocument()
    })

    // Still reports itself disconnected, not a stuck "Observing" state.
    expect(screen.getByText(/disconnected/i)).toBeInTheDocument()
  })

  it('GUARD RAIL: a normal, successful connect shows no error message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ accessToken: 'tok', apiWsUrl: 'wss://api.example.com' }),
    }))
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    })
    vi.stubGlobal('WebSocket', class {
      readyState = 0
      onopen: any = null
      onmessage: any = null
      onclose: any = null
      onerror: any = null
      binaryType = ''
      send() {}
      close() {}
      constructor() {
        // Never opens — this guard rail only needs to prove no error
        // message appears while a connection attempt is legitimately
        // still in flight, not that it succeeds fully.
      }
    })

    const { default: XTerminal } = await import('../app/chat/XTerminal')
    render(<XTerminal threadId="thread-1" />)

    // Give the mount effect's microtask chain a turn to settle.
    await new Promise((r) => setTimeout(r, 0))

    expect(screen.queryByText(/failed to load the terminal/i)).not.toBeInTheDocument()
  })
})
