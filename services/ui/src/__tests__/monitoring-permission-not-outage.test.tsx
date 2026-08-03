/**
 * A permission answer is not a health answer.
 *
 * THE DEFECT. `/harness/monitoring` carries no `adminOnly` flag, so every
 * signed-in user reaches it. Its vault panel probes
 * `/api/admin/secrets/status`, which is `requireRole('admin')` at the API mount.
 * The handler was:
 *
 *     if (res.ok)  -> healthy
 *     else         -> unhealthy, `HTTP ${res.status}`
 *
 * so an ordinary user was told **the vault is unhealthy** when the vault was
 * fine. The page reported the observer's permissions as the system's health.
 *
 * That is worse than showing nothing. It sends someone to investigate an outage
 * that is not happening, and — the durable cost — it teaches people that red on
 * this page means nothing, which is how a real outage gets ignored later.
 *
 * The fix is a third state, and the cases below pin both edges of it: 401/403
 * become `unknown`, and every other failure stays `unhealthy`, because a service
 * answering 500 is broken no matter who asked.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { name: 'ordinary' } }, status: 'authenticated' }),
}))
vi.mock('next/link', () => ({
  default: ({ children, href }: never) => <a href={href}>{children}</a>,
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/harness/monitoring' }))

import MonitoringClient from '@/app/harness/monitoring/MonitoringClient'

/**
 * Answer each probe independently. `vaultCode` is the one that matters: it is
 * the endpoint an ordinary user is refused.
 */
function mockFetch({ vaultCode = 200, storageCode = 200 }: { vaultCode?: number; storageCode?: number }) {
  return vi.fn((url: string) => {
    const reply = (code: number, body: unknown = {}) =>
      Promise.resolve({
        ok: code >= 200 && code < 300,
        status: code,
        json: () => Promise.resolve(body),
      })
    if (url.startsWith('/api/admin/secrets/status')) return reply(vaultCode)
    if (url.startsWith('/api/storage/buckets')) return reply(storageCode)
    if (url.startsWith('/api/health')) return reply(200, { service: 'api', status: 'healthy' })
    return reply(200, [])
  })
}

describe('monitoring: a permission error is not an outage', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('403 on the vault probe does NOT render as unhealthy — the defect', async () => {
    vi.stubGlobal('fetch', mockFetch({ vaultCode: 403 }))
    render(<MonitoringClient />)

    await waitFor(() => {
      expect(screen.getByText('Not visible to your account')).toBeInTheDocument()
    })
    // The words a user must not see for a healthy vault they simply cannot read.
    expect(screen.queryByText('HTTP 403')).not.toBeInTheDocument()
    expect(screen.queryByText('Unhealthy')).not.toBeInTheDocument()
  })

  it('401 is treated the same way', async () => {
    vi.stubGlobal('fetch', mockFetch({ vaultCode: 401 }))
    render(<MonitoringClient />)

    await waitFor(() => {
      expect(screen.getByText('Not visible to your account')).toBeInTheDocument()
    })
    expect(screen.queryByText('HTTP 401')).not.toBeInTheDocument()
  })

  it('the unknown state is neither the green nor the red dot', async () => {
    // An unknown must not read as a pass. Rendering it green would be the
    // silent-success shape: "everything is fine" asserted about something that
    // was never checked.
    vi.stubGlobal('fetch', mockFetch({ vaultCode: 403 }))
    const { container } = render(<MonitoringClient />)

    await waitFor(() => {
      expect(screen.getByText('Not visible to your account')).toBeInTheDocument()
    })
    const dot = container.querySelector('[data-testid="status-unknown"]')
    expect(dot).toBeTruthy()
    expect(dot?.className).not.toMatch(/green|brand/)
    expect(dot?.className).not.toMatch(/red/)
  })

  // ------------------------------------------------- and the other edge -----

  it('500 on the vault probe STILL renders as unhealthy', async () => {
    // The half that makes this a distinction rather than a mute button. A
    // version that treated every failure as "unknown" would pass all the cases
    // above and hide every real outage.
    vi.stubGlobal('fetch', mockFetch({ vaultCode: 500 }))
    render(<MonitoringClient />)

    await waitFor(() => {
      expect(screen.getByText('HTTP 500')).toBeInTheDocument()
    })
    expect(screen.queryByText('Not visible to your account')).not.toBeInTheDocument()
  })

  it('502 on storage still renders as unhealthy', async () => {
    vi.stubGlobal('fetch', mockFetch({ storageCode: 502 }))
    render(<MonitoringClient />)

    await waitFor(() => {
      expect(screen.getByText('HTTP 502')).toBeInTheDocument()
    })
  })

  it('a healthy probe is still healthy', async () => {
    vi.stubGlobal('fetch', mockFetch({}))
    render(<MonitoringClient />)

    await waitFor(() => {
      expect(screen.getAllByText('Healthy').length).toBeGreaterThan(0)
    })
    expect(screen.queryByText('Not visible to your account')).not.toBeInTheDocument()
  })
})
