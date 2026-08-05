import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { roles: ['admin'] } }, status: 'authenticated' }),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/harness/monitoring',
}))

import MonitoringClient from '@/app/harness/monitoring/MonitoringClient'

function mockFetch(overrides: Record<string, unknown> = {}) {
  return vi.fn((url: string) => {
    if (url.includes('/api/health/detailed')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(overrides.detailed ?? { uptime: 3600, version: '1.0.0' }) })
    }
    if (url.includes('/api/health')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ service: 'api', status: 'healthy' }) })
    }
    if (url.includes('/api/admin/secrets/status')) {
      return Promise.resolve({ ok: overrides.vaultOk ?? true, json: () => Promise.resolve({}) })
    }
    if (url.includes('/api/storage/buckets')) {
      return Promise.resolve({ ok: overrides.storageOk ?? true, json: () => Promise.resolve([]) })
    }
    if (url.includes('/api/agents')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(overrides.agents ?? [
          { id: '1', agent_id: 'bot-1', name: 'Bot 1', status: 'running' },
          { id: '2', agent_id: 'bot-2', name: 'Bot 2', status: 'stopped' },
        ]),
      })
    }
    if (url.includes('/api/usage')) {
      // Real shape (#370): COUNT/SUM results are bigint/numeric, both of which
      // node-postgres returns as STRINGS, and the field is `total_cost_usd`,
      // never `total_cost`. A fixture using numbers or the wrong field name
      // can't detect a component reading either wrong — this one deliberately
      // matches the API's actual response, not the component's assumption of it.
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(overrides.usage ?? {
          total_requests: '42',
          total_tokens: '100000',
          total_cost_usd: '1.230000',
          distinct_models: '2',
        }),
      })
    }
    if (url.includes('/api/shared-knowledge/stats')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(overrides.knowledge ?? {}) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('MonitoringClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders monitoring page title', async () => {
    vi.stubGlobal('fetch', mockFetch())
    render(<MonitoringClient />)
    await waitFor(() => {
      expect(screen.getByText('Monitoring')).toBeInTheDocument()
    })
  })

  it('shows service health section', async () => {
    vi.stubGlobal('fetch', mockFetch())
    render(<MonitoringClient />)
    await waitFor(() => {
      expect(screen.getByText('Service Health')).toBeInTheDocument()
    })
  })

  it('shows API healthy status', async () => {
    vi.stubGlobal('fetch', mockFetch())
    render(<MonitoringClient />)
    await waitFor(() => {
      expect(screen.getByText('API')).toBeInTheDocument()
      expect(screen.getAllByLabelText('healthy').length).toBeGreaterThan(0)
    })
  })

  it('shows agent overview section', async () => {
    vi.stubGlobal('fetch', mockFetch())
    render(<MonitoringClient />)
    await waitFor(() => {
      expect(screen.getByText('Agent Overview')).toBeInTheDocument()
    })
  })

  it('shows refresh button', async () => {
    vi.stubGlobal('fetch', mockFetch())
    render(<MonitoringClient />)
    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument()
    })
  })

  it('handles unhealthy vault', async () => {
    vi.stubGlobal('fetch', mockFetch({ vaultOk: false }))
    render(<MonitoringClient />)
    await waitFor(() => {
      const unhealthy = screen.getAllByLabelText('unhealthy')
      expect(unhealthy.length).toBeGreaterThan(0)
    })
  })

  // #370: the Usage widget's Cost card read `usage.total_cost`, a field the
  // real /api/usage response has never had (it's `total_cost_usd`), so it
  // silently rendered $0.0000 forever regardless of the real total — no
  // crash, no error, a plausible-looking wrong number. The old fixture used
  // the SAME wrong field name as the component, so mock and component agreed
  // with each other and neither was ever checked against the real API.
  it('renders the actual total_cost_usd from a string-numeric API response, not a stale $0.0000', async () => {
    vi.stubGlobal('fetch', mockFetch({
      usage: { total_requests: '7', total_tokens: '9000', total_cost_usd: '4.560000', distinct_models: '1' },
    }))
    render(<MonitoringClient />)
    await waitFor(() => {
      expect(screen.getByText('$4.5600')).toBeInTheDocument()
    })
  })

  // #370, second half: "Models Used" read usage.distinct_models, a field the
  // /api/usage summary never returned — silently 0 forever, same shape and
  // same `?? 0` as the Cost bug above. Fixed by having usage.ts compute it
  // (COUNT(DISTINCT model_name), a bigint — arrives as a string like every
  // other count/sum in this response).
  it('renders the actual distinct_models count from a string-numeric API response, not a stale 0', async () => {
    vi.stubGlobal('fetch', mockFetch({
      usage: { total_requests: '7', total_tokens: '9000', total_cost_usd: '4.560000', distinct_models: '3' },
    }))
    render(<MonitoringClient />)
    await waitFor(() => {
      expect(screen.getByText('Models Used')).toBeInTheDocument()
    })
    const card = screen.getByText('Models Used').closest('div')
    expect(card).toHaveTextContent('3')
  })
})
