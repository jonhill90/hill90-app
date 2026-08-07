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

// app#{async-callback-sweep}: refreshAll is handed bare to setInterval, so the
// promise it returns is discarded by the caller — an unguarded rejection
// inside it would be an unhandled rejection, not a caught error. Every real
// probeService call today is internally guarded and cannot reject, so this
// can't be reached through the real implementation; mocking the module is
// how a test proves refreshAll's OWN resilience rather than re-proving
// probeService's already-separately-tested guarantee (service-probe.test.ts).
vi.mock('@/utils/service-probe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/service-probe')>()
  return { ...actual, probeService: vi.fn(actual.probeService) }
})

import MonitoringClient from '@/app/harness/monitoring/MonitoringClient'
import { probeService } from '@/utils/service-probe'

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
        ok: overrides.usageOk ?? true,
        json: () => Promise.resolve(overrides.usage ?? {
          total_requests: '42',
          total_tokens: '100000',
          total_cost_usd: '1.230000',
          distinct_models: '2',
        }),
      })
    }
    if (url.includes('/api/shared-knowledge/stats')) {
      return Promise.resolve({ ok: overrides.knowledgeOk ?? true, json: () => Promise.resolve(overrides.knowledge ?? {}) })
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

  // app#410: a failed /api/usage or /api/shared-knowledge/stats fetch left
  // these widgets showing "Loading..." forever — never resolving, never
  // saying the request failed.
  describe('a failed stats fetch resolves to an error, not permanent "Loading..."', () => {
    it('UsageStats shows an error instead of loading forever', async () => {
      vi.stubGlobal('fetch', mockFetch({ usageOk: false }))
      render(<MonitoringClient />)

      await waitFor(() => {
        expect(screen.getByTestId('usage-stats-error')).toBeInTheDocument()
      })
      expect(screen.getByText('Unable to fetch usage data.')).toBeInTheDocument()
      expect(screen.queryByText('Loading usage...')).not.toBeInTheDocument()
    })

    it('KnowledgeStats shows an error instead of loading forever', async () => {
      vi.stubGlobal('fetch', mockFetch({ knowledgeOk: false }))
      render(<MonitoringClient />)

      await waitFor(() => {
        expect(screen.getByTestId('knowledge-stats-error')).toBeInTheDocument()
      })
      expect(screen.getByText('Unable to fetch knowledge stats.')).toBeInTheDocument()
      expect(screen.queryByText('Loading knowledge stats...')).not.toBeInTheDocument()
    })
  })

  // Async-callback sweep: refreshAll is `setInterval(refreshAll, 30_000)` — the
  // returned promise is discarded, so an unguarded rejection inside it becomes
  // an unhandled rejection, not a caught error. Every real probeService call is
  // internally guarded today and can't reject, which is exactly why this can
  // only be proven by forcing the dependency to violate its own contract, not
  // by finding a real input that breaks it.
  describe("refreshAll survives a rejecting dependency (it shouldn't be reachable today, but nothing enforced that)", () => {
    it('does not leave the refresh button stuck disabled/spinning when a probe rejects', async () => {
      vi.stubGlobal('fetch', mockFetch())
      vi.mocked(probeService).mockRejectedValueOnce(new Error('simulated: a probe violated its own never-rejects contract'))

      render(<MonitoringClient />)

      const button = await screen.findByRole('button', { name: /refresh/i })
      // The property under test: refreshAll's mount-time call must reach its
      // `finally` and re-enable the button even though one dependency
      // rejected — not stay stuck disabled/spinning forever, which is what
      // an unhandled rejection inside refreshAll (pre-fix: no try/finally)
      // would have left it as, since the two lines after the bare `await`
      // never run once the awaited promise rejects.
      await waitFor(() => {
        expect(button).not.toBeDisabled()
      })
      expect(button.querySelector('svg')).not.toHaveClass('animate-spin')
    })

    it('still updates "Last refresh" even when a probe rejects', async () => {
      vi.stubGlobal('fetch', mockFetch())
      vi.mocked(probeService).mockRejectedValueOnce(new Error('simulated probe rejection'))

      render(<MonitoringClient />)

      await waitFor(() => {
        expect(screen.getByText(/Last refresh:/)).toBeInTheDocument()
      })
      // Distinguishing "ran and updated" from "was always there": the initial
      // state is also a real Date, so this asserts the button re-enabling
      // (proven above) and this coexist — refreshAll actually completed its
      // finally block, not just left old state on screen untouched.
      const button = await screen.findByRole('button', { name: /refresh/i })
      await waitFor(() => expect(button).not.toBeDisabled())
    })
  })
})
