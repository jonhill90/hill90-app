import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import AgentWebhooks from '@/app/agents/[id]/AgentWebhooks'

const MOCK_WEBHOOKS = [
  { id: 'wh-1', url: 'https://example.com/hook', events: ['start', 'stop'], active: true, created_at: '2026-01-01T00:00:00Z' },
]

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function mockFetchDefaults(webhooks = MOCK_WEBHOOKS) {
  mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
    if (typeof url === 'string' && url === '/api/agents/bot-1/webhooks' && (!opts || !opts.method || opts.method === 'GET')) {
      return { ok: true, json: async () => webhooks }
    }
    return { ok: true, json: async () => ({}) }
  })
}

describe('AgentWebhooks', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetchDefaults()
  })

  afterEach(() => cleanup())

  it('renders webhook list after fetch', async () => {
    render(<AgentWebhooks agentId="bot-1" />)
    await waitFor(() => {
      expect(screen.getByText(/example\.com\/hook/)).toBeInTheDocument()
    })
  })

  it('shows an error toast, not a silently-open form, when adding a webhook fails', async () => {
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (typeof url === 'string' && url === '/api/agents/bot-1/webhooks' && (!opts || !opts.method || opts.method === 'GET')) {
        return { ok: true, json: async () => MOCK_WEBHOOKS }
      }
      if (typeof url === 'string' && url === '/api/agents/bot-1/webhooks' && opts?.method === 'POST') {
        return { ok: false, status: 500, json: async () => ({ error: 'db unavailable' }) }
      }
      return { ok: true, json: async () => ({}) }
    })

    render(<AgentWebhooks agentId="bot-1" />)
    await waitFor(() => {
      expect(screen.getByText(/example\.com\/hook/)).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Add'))
    fireEvent.change(screen.getByPlaceholderText(/discord\.com\/api\/webhooks/), {
      target: { value: 'https://broken.example.com/hook' },
    })
    fireEvent.click(screen.getByText('Add Webhook'))

    await waitFor(() => {
      expect(screen.getByTestId('toast-error')).toHaveTextContent('Could not add the webhook: db unavailable')
    })
    // The form must still be open with the entered URL — it must not look
    // like the webhook was added.
    expect(screen.getByDisplayValue('https://broken.example.com/hook')).toBeInTheDocument()
  })

  it('shows an error toast, not a silent no-op, when deleting a webhook fails', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (typeof url === 'string' && url === '/api/agents/bot-1/webhooks' && (!opts || !opts.method || opts.method === 'GET')) {
        return { ok: true, json: async () => MOCK_WEBHOOKS }
      }
      if (typeof url === 'string' && url === '/api/agents/bot-1/webhooks/wh-1' && opts?.method === 'DELETE') {
        return { ok: false, status: 500, json: async () => ({ error: 'db unavailable' }) }
      }
      return { ok: true, json: async () => ({}) }
    })

    render(<AgentWebhooks agentId="bot-1" />)
    await waitFor(() => {
      expect(screen.getByText(/example\.com\/hook/)).toBeInTheDocument()
    })

    const row = screen.getByText(/example\.com\/hook/).closest('.rounded')!
    const deleteButton = row.querySelector('button')!
    fireEvent.click(deleteButton)

    await waitFor(() => {
      expect(screen.getByTestId('toast-error')).toHaveTextContent('Could not remove the webhook: db unavailable')
    })
    expect(screen.getByText(/example\.com\/hook/)).toBeInTheDocument()
  })
})
