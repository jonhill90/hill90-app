import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { roles: ['admin'] } }, status: 'authenticated' }),
}))

vi.mock('lucide-react', () => ({
  Plus: (props: any) => <span data-testid="icon-plus" {...props} />,
  Play: (props: any) => <span data-testid="icon-play" {...props} />,
  Pause: (props: any) => <span data-testid="icon-pause" {...props} />,
  Trash2: (props: any) => <span data-testid="icon-trash" {...props} />,
  Clock: (props: any) => <span data-testid="icon-clock" {...props} />,
  Zap: (props: any) => <span data-testid="icon-zap" {...props} />,
  RefreshCw: (props: any) => <span data-testid="icon-refresh" {...props} />,
}))

import WorkflowsClient from '@/app/harness/workflows/WorkflowsClient'

// app#374: webhook_token is deliberately absent from these fixtures — the
// real /api/workflows response no longer carries it (migration 068 dropped
// the plaintext column entirely). A fixture that still modeled it would be
// testing against a shape the API can no longer produce.
const MOCK_WORKFLOWS = [
  {
    id: 'wf-1', name: 'Daily Health Check', description: 'Check services',
    agent_id: 'a-1', agent_name: 'Monitor Bot', agent_slug: 'monitor-bot', agent_status: 'running',
    schedule_cron: '0 9 * * *', prompt: 'Check all services', trigger_type: 'cron',
    output_type: 'none', output_config: {}, enabled: true,
    last_run_at: '2026-04-18T09:00:00Z', next_run_at: '2026-04-19T09:00:00Z', created_at: '2026-04-15T00:00:00Z',
  },
  {
    id: 'wf-2', name: 'PR Review Webhook', description: 'Review PRs on push',
    agent_id: 'a-2', agent_name: 'Review Bot', agent_slug: 'review-bot', agent_status: 'stopped',
    schedule_cron: null, prompt: 'Review the PR', trigger_type: 'webhook',
    output_type: 'none', output_config: {}, enabled: true,
    last_run_at: null, next_run_at: null, created_at: '2026-04-16T00:00:00Z',
  },
]

const MOCK_AGENTS = [
  { id: 'a-1', name: 'Monitor Bot', agent_id: 'monitor-bot', status: 'running' },
  { id: 'a-2', name: 'Review Bot', agent_id: 'review-bot', status: 'stopped' },
]

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/workflows') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_WORKFLOWS) })
    if (url === '/api/agents') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
    if (url.includes('/runs')) return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  }))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('WorkflowsClient', () => {
  it('renders workflow list', async () => {
    render(<WorkflowsClient />)
    await waitFor(() => {
      expect(screen.getByText('Daily Health Check')).toBeInTheDocument()
      expect(screen.getByText('PR Review Webhook')).toBeInTheDocument()
    })
  })

  it('shows workflow count', async () => {
    render(<WorkflowsClient />)
    await waitFor(() => {
      expect(screen.getByText('2 workflows')).toBeInTheDocument()
    })
  })

  it('shows cron schedule for cron workflows', async () => {
    render(<WorkflowsClient />)
    await waitFor(() => {
      expect(screen.getByText('Daily at 9:00')).toBeInTheDocument()
    })
  })

  it('shows webhook trigger for webhook workflows', async () => {
    render(<WorkflowsClient />)
    await waitFor(() => {
      expect(screen.getByText('Webhook trigger')).toBeInTheDocument()
    })
  })

  it('shows active/paused badges', async () => {
    render(<WorkflowsClient />)
    await waitFor(() => {
      const badges = screen.getAllByText('Active')
      expect(badges.length).toBe(2)
    })
  })

  it('shows agent name and status', async () => {
    render(<WorkflowsClient />)
    await waitFor(() => {
      expect(screen.getByText('Monitor Bot')).toBeInTheDocument()
      expect(screen.getByText('(running)')).toBeInTheDocument()
    })
  })

  it('opens create form on New Workflow click', async () => {
    render(<WorkflowsClient />)
    await waitFor(() => {
      expect(screen.getByText('New Workflow')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('New Workflow'))
    expect(screen.getByText('Trigger')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('Daily Health Check')).toBeInTheDocument()
  })

  it('shows empty state when no workflows', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/workflows') return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      if (url === '/api/agents') return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }))
    render(<WorkflowsClient />)
    await waitFor(() => {
      expect(screen.getByText('No workflows yet')).toBeInTheDocument()
    })
  })

  // app#374: the persistent per-row webhook URL render was the actual leak —
  // the full token sat in a `title` attribute on every list render. Asserting
  // its absence here only has teeth because the fixture above no longer
  // carries `webhook_token` at all, matching what the real API now returns.
  it('never renders a webhook URL or token on the persistent list — only the one-time reveal does that', async () => {
    render(<WorkflowsClient />)
    await waitFor(() => {
      expect(screen.getByText('PR Review Webhook')).toBeInTheDocument()
    })
    expect(screen.queryByText(/\/workflows\/webhook\//)).not.toBeInTheDocument()
  })

  it('shows the webhook URL exactly once, right after creating a webhook workflow, then lets it be dismissed', async () => {
    const fetchMock = vi.fn((url: string, opts?: RequestInit) => {
      if (url === '/api/workflows' && (!opts || opts.method === undefined)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_WORKFLOWS) })
      }
      if (url === '/api/agents') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
      if (url === '/api/workflows' && opts?.method === 'POST') {
        // Real shape (routes/workflows.ts): webhook_url appears ONLY in the
        // create response, and the row itself carries no token/hash field.
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            id: 'wf-3', name: 'New Hook', trigger_type: 'webhook',
            webhook_url: '/workflows/webhook/9f8e7d6c5b4a3210deadbeefcafef00dfeedfacecafefeed0123456789abcde',
          }),
        })
      }
      if (url.includes('/runs')) return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<WorkflowsClient />)
    await waitFor(() => expect(screen.getByText('Daily Health Check')).toBeInTheDocument())

    fireEvent.click(screen.getByText('New Workflow'))
    fireEvent.change(screen.getByPlaceholderText('Daily Health Check'), { target: { value: 'New Hook' } })
    fireEvent.change(screen.getByDisplayValue('Select agent...'), { target: { value: 'a-1' } })
    fireEvent.change(screen.getByDisplayValue('Cron Schedule'), { target: { value: 'webhook' } })
    fireEvent.change(screen.getByPlaceholderText('Check all service health endpoints and report any issues...'), { target: { value: 'do the thing' } })
    fireEvent.click(screen.getByText('Create Workflow'))

    await waitFor(() => {
      expect(screen.getByText('Webhook URL — shown once')).toBeInTheDocument()
      expect(screen.getByText('/workflows/webhook/9f8e7d6c5b4a3210deadbeefcafef00dfeedfacecafefeed0123456789abcde')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Dismiss'))
    await waitFor(() => {
      expect(screen.queryByText('Webhook URL — shown once')).not.toBeInTheDocument()
    })
  })
})
