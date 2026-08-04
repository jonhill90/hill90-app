import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { observeTextTiming } from './support/flake-capture'

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import DashboardClient from '@/app/dashboard/DashboardClient'

const MOCK_SESSION = {
  user: { name: 'Admin Hill', email: 'admin@hill90.com', roles: ['admin'] },
  expires: '2026-12-31',
}

const MOCK_HEALTH = {
  services: [
    { name: 'API', status: 'healthy', responseTime: 42 },
    { name: 'AI', status: 'healthy', responseTime: 85 },
    { name: 'Auth', status: 'healthy', responseTime: 30 },
    { name: 'MCP', status: 'unhealthy' },
  ],
}

const MOCK_AGENTS = [
  { id: 'a1', agent_id: 'scout', name: 'Scout', status: 'running' },
  { id: 'a2', agent_id: 'builder', name: 'Builder', status: 'stopped' },
  { id: 'a3', agent_id: 'watcher', name: 'Watcher', status: 'stopped' },
  { id: 'a4', agent_id: 'broken', name: 'Broken', status: 'error' },
]

const MOCK_MODELS = [
  { id: 'm1', name: 'gpt-4o-mini' },
  { id: 'm2', name: 'claude-sonnet' },
]

const MOCK_USAGE = {
  total_requests: '247',
  total_tokens: '15000',
  total_cost_usd: '0.5432',
}

const MOCK_THREADS = [
  {
    id: 't1',
    title: 'Deploy discussion',
    last_message: 'Looks good, ship it',
    last_author_type: 'human',
    updated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    message_count: 5,
    last_message_at: new Date().toISOString(),
  },
  {
    id: 't2',
    title: null,
    last_message: 'I will investigate the error',
    last_author_type: 'agent',
    updated_at: new Date(Date.now() - 3600_000).toISOString(),
    created_at: new Date(Date.now() - 7200_000).toISOString(),
    message_count: 3,
    last_message_at: new Date(Date.now() - 3600_000).toISOString(),
  },
]

function mockFetchDefaults() {
  mockFetch.mockImplementation((url: string) => {
    if (url === '/api/services/health') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_HEALTH) })
    }
    if (url === '/api/agents') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
    }
    if (url === '/api/user-models') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_MODELS) })
    }
    if (typeof url === 'string' && url.startsWith('/api/usage')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_USAGE) })
    }
    if (url === '/api/chat') {
      // A real Response always carries headers, and the dashboard reads
      // X-Total-Count for the thread count (#197). A double without them made
      // fetchChat throw, which removed the recent-threads widget this test is
      // about — an incomplete double failing a test for the wrong reason.
      return Promise.resolve({
        ok: true,
        headers: { get: (k: string) => (k.toLowerCase() === 'x-total-count' ? String(MOCK_THREADS.length) : null) },
        json: () => Promise.resolve(MOCK_THREADS),
      })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('DashboardClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mockFetchDefaults()
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('renders session info', async () => {
    render(<DashboardClient session={MOCK_SESSION as any} />)

    expect(screen.getByText('Admin Hill')).toBeInTheDocument()
    expect(screen.getByText('admin@hill90.com')).toBeInTheDocument()
    expect(screen.getByText('admin')).toBeInTheDocument()
  })

  it('renders platform overview with agent counts', async () => {
    render(<DashboardClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Platform Overview')).toBeInTheDocument()
    })

    // Total agents
    expect(screen.getByText('4')).toBeInTheDocument()
    // Status breakdown
    expect(screen.getByText('1 running')).toBeInTheDocument()
    expect(screen.getByText(/2 stopped/)).toBeInTheDocument()
  })

  it('renders platform overview with model count', async () => {
    render(<DashboardClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Platform Overview')).toBeInTheDocument()
    })

    expect(screen.getByText('Models')).toBeInTheDocument()
    // '2' appears in both Chat Threads card and Models — use getAllByText
    expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1)
  })

  it('renders platform overview with usage totals', async () => {
    render(<DashboardClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Platform Overview')).toBeInTheDocument()
    })

    expect(screen.getByText('Requests (7d)')).toBeInTheDocument()
    expect(screen.getByText('247')).toBeInTheDocument()
    expect(screen.getByText('Cost (7d)')).toBeInTheDocument()
    expect(screen.getByText('$0.5432')).toBeInTheDocument()
  })

  it('renders service health cards', async () => {
    render(<DashboardClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('API')).toBeInTheDocument()
    })

    expect(screen.getByText('AI')).toBeInTheDocument()
    expect(screen.getByText('Auth')).toBeInTheDocument()
    expect(screen.getByText('MCP')).toBeInTheDocument()
  })

  it('shows platform overview even when some fetches fail', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/services/health') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_HEALTH) })
      }
      if (url === '/api/agents') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      }
      if (url === '/api/user-models') {
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) })
      }
      if (typeof url === 'string' && url.startsWith('/api/usage')) {
        return Promise.resolve({ ok: false, json: () => Promise.resolve({}) })
      }
      if (url === '/api/chat') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<DashboardClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Platform Overview')).toBeInTheDocument()
    })

    // Should show 0 for everything gracefully (multiple 0s across cards)
    expect(screen.getAllByText('0').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('$0.0000')).toBeInTheDocument()
  })

  it('renders active agents widget with running agents', async () => {
    render(<DashboardClient session={MOCK_SESSION as any} />)

    // #117, DIAGNOSED AND FIXED — see docs/decisions/api-suite-flakiness.md.
    //
    // This waited on `getByText('Active Agents')`, which does not depend on the
    // agents fetch: DashboardClient.tsx renders that <h2> unconditionally, before
    // `fetchHarness()`'s Promise.all has resolved. So the wait was satisfied on
    // first paint and the synchronous `getByText('Scout')` that followed it raced
    // the real data — intermittently in CI (17 recorded occurrences, all "ARRIVED
    // LATE" at exactly 20ms, swept from every CI run since the discriminator
    // landed), never locally, where the same chain resolves inside a tick.
    //
    // THE FIX waits for something that only changes once `activeAgents` is
    // actually set — the empty-state text disappearing. `setActiveAgents` and
    // `setHarness` run back to back with no `await` between them in
    // fetchHarness(), so both land in the same React commit: once this resolves,
    // Scout is already there. Proven, not assumed — see the reproduction test
    // below, which forces the old gate red on demand with a controlled promise
    // instead of hoping to land inside CI's ~20ms window by chance.
    await waitFor(() => {
      expect(screen.queryByText('No active agents')).not.toBeInTheDocument()
    })

    // BACKSTOP, not the fix. If this ever fires again, the fix above is
    // incomplete or something new is racing — either way it is a signal worth
    // reading, not a flake to retry away. Expected to always take the
    // instant path now: the wait above already guarantees Scout is in the
    // same commit it resolved on.
    await observeTextTiming('Scout', 'dashboard-active-agents', {
      context: () => ({
        fetchCalls: mockFetch.mock.calls.map((c) => String(c[0])),
        fetchCallCount: mockFetch.mock.calls.length,
      }),
    })
    // Only running agents should appear
    expect(screen.queryByText('Builder')).not.toBeInTheDocument()
    expect(screen.queryByText('Watcher')).not.toBeInTheDocument()

    // Open link points to agent detail
    const openLinks = screen.getAllByText('Open')
    expect(openLinks.length).toBe(1)
    expect(openLinks[0].closest('a')).toHaveAttribute('href', '/agents/a1')
  })

  it('the active-agents wait depends on the agents data resolving, not on the heading that renders regardless (#117)', async () => {
    // #117's mechanism, forced open deterministically instead of hoped-for at
    // CI's ~20ms window. ~40 earlier local attempts across four emulated CI
    // conditions never once landed inside a window that small; a manually
    // controlled promise makes the gap arbitrarily wide and reproduces it
    // on demand, on any machine.
    let resolveAgents!: (v: unknown) => void
    const agentsGate = new Promise((resolve) => { resolveAgents = resolve })
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/agents') {
        return agentsGate.then(() => ({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) }))
      }
      if (url === '/api/services/health') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_HEALTH) })
      }
      if (url === '/api/user-models') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_MODELS) })
      }
      if (typeof url === 'string' && url.startsWith('/api/usage')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_USAGE) })
      }
      if (url === '/api/chat') {
        return Promise.resolve({
          ok: true,
          headers: { get: (k: string) => (k.toLowerCase() === 'x-total-count' ? String(MOCK_THREADS.length) : null) },
          json: () => Promise.resolve(MOCK_THREADS),
        })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<DashboardClient session={MOCK_SESSION as any} />)

    // PROVEN, not asserted: the heading is on screen before the agents fetch
    // has even been released. This is the whole mechanism #117 traced to
    // DashboardClient.tsx:369 — the <h2> is unconditional.
    expect(screen.getByText('Active Agents')).toBeInTheDocument()
    // And the data genuinely is not there yet — the gap this control exists
    // to hold open, so the assertions below are not vacuously true.
    expect(screen.queryByText('Scout')).not.toBeInTheDocument()

    resolveAgents(undefined)

    // THE FIX: wait for something that only changes once `activeAgents` has
    // actually been set, not for chrome that was already there. Once this
    // resolves, Scout is already in the DOM — same React commit, since
    // `setActiveAgents` and `setHarness` run back to back with no `await`
    // between them in fetchHarness().
    await waitFor(() => {
      expect(screen.queryByText('No active agents')).not.toBeInTheDocument()
    })
    expect(screen.getByText('Scout')).toBeInTheDocument()
  })

  it('shows empty state when no active agents', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/agents') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([{ id: 'a1', status: 'stopped', name: 'X' }]) })
      }
      if (url === '/api/services/health') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_HEALTH) })
      }
      if (url === '/api/user-models') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      }
      if (typeof url === 'string' && url.startsWith('/api/usage')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_USAGE) })
      }
      if (url === '/api/chat') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<DashboardClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('No active agents')).toBeInTheDocument()
    })
  })

  it('renders recent chat threads widget', async () => {
    // The second #117 victim — identical shape to 'Active Agents' (a
    // static <h2>Recent Chats</h2>, gated on nothing, ahead of the
    // fetchChat()-populated thread list) and fixed the same way: wait on the
    // empty-state text disappearing, which only changes once `recentThreads`
    // is actually set. Never independently confirmed to race in CI (17 recorded
    // #117 occurrences since the discriminator landed were all the OTHER
    // widget — see docs/decisions/api-suite-flakiness.md) but the render
    // structure is the same defect, so it gets the same fix rather than being
    // left half-corrected.
    render(<DashboardClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.queryByText('No chat threads yet')).not.toBeInTheDocument()
    })

    // BACKSTOP — see the identical comment on the Active Agents test above.
    await observeTextTiming('Deploy discussion', 'dashboard-recent-chats', {
      context: () => ({
        fetchCalls: mockFetch.mock.calls.map((c) => String(c[0])),
        fetchCallCount: mockFetch.mock.calls.length,
      }),
    })
    expect(screen.getByText('Untitled thread')).toBeInTheDocument()
    expect(screen.getByText('Looks good, ship it')).toBeInTheDocument()
    // Agent prefix for agent messages
    expect(screen.getByText(/Agent:.*I will investigate/)).toBeInTheDocument()

    // Thread links
    const threadLink = screen.getByText('Deploy discussion').closest('a')
    expect(threadLink).toHaveAttribute('href', '/chat/t1')
  })

  it('renders quick action buttons', () => {
    render(<DashboardClient session={MOCK_SESSION as any} />)

    const newAgentLink = screen.getByText('New Agent').closest('a')
    expect(newAgentLink).toHaveAttribute('href', '/agents')

    const startChatLink = screen.getByText('Start Chat').closest('a')
    expect(startChatLink).toHaveAttribute('href', '/chat')

    const viewUsageLink = screen.getByText('View Usage').closest('a')
    expect(viewUsageLink).toHaveAttribute('href', '/harness/usage')
  })

  it('auto-refreshes after 60 seconds', async () => {
    render(<DashboardClient session={MOCK_SESSION as any} />)

    // Initial fetch calls
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled()
    })

    const initialCallCount = mockFetch.mock.calls.length

    // Advance timers by 60s
    vi.advanceTimersByTime(60_000)

    await waitFor(() => {
      expect(mockFetch.mock.calls.length).toBeGreaterThan(initialCallCount)
    })
  })
})
