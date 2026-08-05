import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

/**
 * `checkHealth` fed an unchecked response body straight into `services`.
 *
 * THE DEFECT. It read:
 *
 *     const res = await fetch('/api/services/health')
 *     const data = await res.json()
 *     setServices(data.services)
 *
 * with no `res.ok` check. A Next.js route handler refusing the request
 * answers `NextResponse.json({ error }, { status })` — a NON-ok response that
 * still parses as JSON — so `data.services` is `undefined` and `services`,
 * typed `ServiceHealth[]` and never optional, becomes `undefined`.
 *
 * The next render then runs `services.filter(...)` (the healthy-count line)
 * and `services.map(...)` (the service list) against `undefined` and throws.
 * The whole dashboard goes, not just the health panel.
 *
 * `checkHealth`'s OWN `catch` cannot save it. The catch marks every service
 * unhealthy — precisely the right behaviour, already written by the author
 * for this situation — but the throw happens during a later render, outside
 * the async function, so the recovery path is bypassed and the user gets a
 * blank page instead of the red dots that were built for them.
 *
 * THE SIBLING, twenty lines below in the SAME FILE. `fetchHarness` checks
 * `agentsRes.ok` and carries a comment explaining exactly why this matters —
 * that a silent `[]` "reads as 'you have no agents' rather than 'the request
 * failed'" — and checks `modelsRes.ok` and `usageRes.ok` too. One function
 * reasoned it through and the one above it never got the guard.
 *
 * NOT CLAIMED HERE: that this is the mechanism behind #117. It is a
 * candidate — a render-time throw is indistinguishable from "the expected
 * text never arrived" to a testing-library query, and this is that file —
 * but #117's failures were never captured with a stack, so nothing connects
 * them beyond the shape. Recorded as a lead, not a diagnosis.
 */

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

import DashboardClient from '@/app/dashboard/DashboardClient'

// Same shape as DashboardClient.test.tsx's own fixture — `session` is a PROP,
// not a useSession() hook. A first version of this file mocked the hook, and
// all four tests failed on `session.user` being undefined: red for a reason
// that had nothing to do with the defect under test.
const MOCK_SESSION = {
  user: { name: 'Admin Hill', email: 'admin@hill90.com', roles: ['admin'] },
  expires: '2026-12-31',
}

/** Everything except the health probe answers benignly, so only one variable moves. */
function respondWith(healthResponse: any) {
  mockFetch.mockImplementation(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/services/health')) return healthResponse
    if (u.includes('/api/agents')) return { ok: true, json: async () => [] }
    if (u.includes('/api/usage')) return { ok: true, json: async () => null }
    return { ok: true, json: async () => [] }
  })
}

describe('DashboardClient health probe — a non-ok response must not become the services array', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })
  afterEach(() => cleanup())

  it('THE ASSERTION THAT MATTERS: a 500 with a JSON error body does not take the page down', async () => {
    // The shape a Next.js route handler actually produces on refusal:
    // non-ok, but valid JSON, so res.json() succeeds and returns no `services`.
    respondWith({ ok: false, status: 500, json: async () => ({ error: 'health probe failed' }) })

    render(<DashboardClient session={MOCK_SESSION as any} />)

    // The dashboard must still be on screen. Before the fix the render threw
    // on services.filter(undefined) and nothing below it existed.
    await waitFor(() => {
      expect(screen.getByText('Platform Overview')).toBeInTheDocument()
    })
  })

  it('a 401 — the session-expiry case — is handled the same way', async () => {
    respondWith({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) })

    render(<DashboardClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Platform Overview')).toBeInTheDocument()
    })
  })

  it('a 200 whose body carries no services array is refused too', async () => {
    // Not hypothetical padding: an upstream shape change is exactly how #303
    // broke the knowledge graph — the endpoint kept answering 200 and renamed
    // the key. A guard on res.ok alone would not catch it.
    respondWith({ ok: true, status: 200, json: async () => ({ total: 3 }) })

    render(<DashboardClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Platform Overview')).toBeInTheDocument()
    })
  })

  it('POSITIVE CONTROL: a well-formed 200 still populates the panel', async () => {
    // Without this, every assertion above would pass on a component that
    // rendered the dashboard and ignored the health response entirely.
    respondWith({
      ok: true,
      status: 200,
      json: async () => ({
        services: [
          { name: 'API', status: 'healthy' },
          { name: 'Postgres', status: 'healthy' },
        ],
      }),
    })

    render(<DashboardClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Platform Overview')).toBeInTheDocument()
    })
    // 'All Go', not '2/2' — the panel renders the count only when some
    // service is NOT healthy. A first version asserted '2/2' and failed on a
    // correctly-working component; the assertion was wrong, not the code.
    await waitFor(() => {
      expect(screen.getByText('All Go')).toBeInTheDocument()
    })
    expect(screen.getByText('Operational')).toBeInTheDocument()
  })
})
