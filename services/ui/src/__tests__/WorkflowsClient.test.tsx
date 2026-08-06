import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
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

  it('shows an error banner, not "No workflows yet", when the workflows fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/workflows') return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) })
      if (url === '/api/agents') return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }))
    render(<WorkflowsClient />)
    await waitFor(() => {
      expect(screen.getByTestId('workflows-error')).toBeInTheDocument()
    })
    expect(screen.getByText('Could not load workflows — try refreshing the page')).toBeInTheDocument()
    expect(screen.queryByText('No workflows yet')).not.toBeInTheDocument()
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

  // Write-path silent-failure sweep: a failed DELETE must not close the
  // detail pane or clear runs as though the workflow were gone.
  it('does not clear the selected workflow when deleting it fails', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.stubGlobal('alert', vi.fn())
    vi.stubGlobal('fetch', vi.fn((url: string, opts?: RequestInit) => {
      if (url === '/api/workflows') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_WORKFLOWS) })
      if (url === '/api/agents') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
      if (url === '/api/workflows/wf-1' && opts?.method === 'DELETE') {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'db unavailable' }) })
      }
      if (url.includes('/runs')) return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }))

    render(<WorkflowsClient />)
    await waitFor(() => expect(screen.getByText('Daily Health Check')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Daily Health Check'))
    const deleteButtons = screen.getAllByTitle('Delete')
    fireEvent.click(deleteButtons[0])

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith('db unavailable')
    })
    // The workflow row and its detail pane must still be present — a failed
    // delete must not act as though the workflow were already gone.
    expect(screen.getByText('Daily Health Check')).toBeInTheDocument()
  })

  // Twin of the test above, but the fetch itself REJECTS (a network
  // failure) rather than resolving with ok: false — handleDelete had no
  // try/catch at all, so this used to be an unhandled promise rejection
  // with nothing shown to the user. Representative of the same fix applied
  // to all five handlers in this file (handleSubmit, handleToggle,
  // handleDelete, handleAddStep, handleDeleteStep) — each already had this
  // exact if(ok)/else(alert) shape for a non-2xx response (handleRun, the
  // one handler in this file already guarded, is the reference this fix
  // matches).
  it('does not silently swallow a network failure when deleting a workflow', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.stubGlobal('alert', vi.fn())
    vi.stubGlobal('fetch', vi.fn((url: string, opts?: RequestInit) => {
      if (url === '/api/workflows') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_WORKFLOWS) })
      if (url === '/api/agents') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
      if (url === '/api/workflows/wf-1' && opts?.method === 'DELETE') {
        return Promise.reject(new Error('network error'))
      }
      if (url.includes('/runs')) return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }))

    render(<WorkflowsClient />)
    await waitFor(() => expect(screen.getByText('Daily Health Check')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Daily Health Check'))
    const deleteButtons = screen.getAllByTitle('Delete')
    fireEvent.click(deleteButtons[0])

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith('Failed to delete workflow')
    })
    expect(screen.getByText('Daily Health Check')).toBeInTheDocument()
  })

  // app#452: handleDeleteStep used to skip the confirm() its sibling
  // handleDelete has. Both tests below exercise the real UI path (open the
  // workflow, switch to the Steps tab) rather than calling the handler
  // directly, so a regression that moves the confirm() out of the click path
  // would still be caught.
  it('does NOT delete a step when the confirm is declined — the DELETE request must never fire', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    vi.stubGlobal('alert', vi.fn())
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/workflows') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_WORKFLOWS) })
      if (url === '/api/agents') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
      if (url.includes('/runs')) return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      if (url === '/api/workflows/wf-1/steps') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([
            { id: 'step-1', agent_id: 'a-1', agent_name: 'Monitor Bot', agent_slug: 'monitor-bot', prompt: 'Check things', step_order: 0 },
          ]),
        })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<WorkflowsClient />)
    await waitFor(() => expect(screen.getByText('Daily Health Check')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Daily Health Check'))
    await waitFor(() => expect(screen.getByText('Steps (1)')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Steps (1)'))
    await waitFor(() => expect(screen.getByText('Check things')).toBeInTheDocument())

    fireEvent.click(within(screen.getByText('Check things').parentElement!.parentElement!).getByTestId('icon-trash'))

    expect(window.confirm).toHaveBeenCalledWith('Delete this step?')
    // The step is still there — declining must be a true no-op, not a dialog
    // that shows and deletes anyway.
    expect(screen.getByText('Check things')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalledWith('/api/workflows/wf-1/steps/step-1', expect.objectContaining({ method: 'DELETE' }))
  })

  it('deletes a step when the confirm is accepted', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.stubGlobal('alert', vi.fn())
    let stepsCallCount = 0
    const fetchMock = vi.fn((url: string, opts?: RequestInit) => {
      if (url === '/api/workflows') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_WORKFLOWS) })
      if (url === '/api/agents') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
      if (url.includes('/runs')) return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      if (url === '/api/workflows/wf-1/steps/step-1' && opts?.method === 'DELETE') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
      }
      if (url === '/api/workflows/wf-1/steps') {
        stepsCallCount += 1
        const steps = stepsCallCount === 1
          ? [{ id: 'step-1', agent_id: 'a-1', agent_name: 'Monitor Bot', agent_slug: 'monitor-bot', prompt: 'Check things', step_order: 0 }]
          : []
        return Promise.resolve({ ok: true, json: () => Promise.resolve(steps) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<WorkflowsClient />)
    await waitFor(() => expect(screen.getByText('Daily Health Check')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Daily Health Check'))
    await waitFor(() => expect(screen.getByText('Steps (1)')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Steps (1)'))
    await waitFor(() => expect(screen.getByText('Check things')).toBeInTheDocument())

    fireEvent.click(within(screen.getByText('Check things').parentElement!.parentElement!).getByTestId('icon-trash'))

    expect(window.confirm).toHaveBeenCalledWith('Delete this step?')
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/workflows/wf-1/steps/step-1', expect.objectContaining({ method: 'DELETE' }))
    })
    await waitFor(() => expect(screen.queryByText('Check things')).not.toBeInTheDocument())
  })

  it('shows an error, not a silent no-op, when creating a workflow fails', async () => {
    vi.stubGlobal('alert', vi.fn())
    vi.stubGlobal('fetch', vi.fn((url: string, opts?: RequestInit) => {
      if (url === '/api/workflows' && (!opts || !opts.method)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_WORKFLOWS) })
      }
      if (url === '/api/agents') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
      if (url === '/api/workflows' && opts?.method === 'POST') {
        return Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: 'invalid cron expression' }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }))

    render(<WorkflowsClient />)
    await waitFor(() => expect(screen.getByText('Daily Health Check')).toBeInTheDocument())

    fireEvent.click(screen.getByText('New Workflow'))
    fireEvent.change(screen.getByPlaceholderText('Daily Health Check'), { target: { value: 'Bad Workflow' } })
    fireEvent.change(screen.getByDisplayValue('Select agent...'), { target: { value: 'a-1' } })
    fireEvent.change(screen.getByPlaceholderText('Check all service health endpoints and report any issues...'), { target: { value: 'do the thing' } })
    fireEvent.click(screen.getByText('Create Workflow'))

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith('invalid cron expression')
    })
    // The form must still be open with the entered data — it must not look
    // like the workflow was created.
    expect(screen.getByText('Trigger')).toBeInTheDocument()
  })
})
