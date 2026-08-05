import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const mockPush = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, back: vi.fn() }),
}))

vi.mock('../app/agents/new/AgentFormClient', () => ({
  default: () => <div data-testid="agent-form">Agent Form</div>,
}))

import AgentEditClient from '@/app/agents/[id]/edit/AgentEditClient'

const MOCK_AGENT = {
  id: 'uuid-1',
  agent_id: 'my-agent',
  name: 'My Agent',
  description: '',
  cpus: 1,
  mem_limit: '512m',
  pids_limit: 100,
  soul_md: '',
  rules_md: '',
  models: [],
  skills: [],
  status: 'stopped',
  created_by: 'user1',
}

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('AgentEditClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders the form after a successful load', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve(MOCK_AGENT) })
    render(<AgentEditClient agentId="my-agent" />)
    await waitFor(() => {
      expect(screen.getByTestId('agent-form')).toBeInTheDocument()
    })
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('redirects to /agents on a genuine 404', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) })
    render(<AgentEditClient agentId="missing-agent" />)
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/agents')
    })
    expect(screen.queryByTestId('agent-edit-error')).not.toBeInTheDocument()
  })

  it('shows an error state, not a silent redirect, on a non-404 failure', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) })
    render(<AgentEditClient agentId="my-agent" />)
    await waitFor(() => {
      expect(screen.getByTestId('agent-edit-error')).toBeInTheDocument()
    })
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('shows an error state, not a silent redirect, on a network error', async () => {
    mockFetch.mockRejectedValue(new Error('network down'))
    render(<AgentEditClient agentId="my-agent" />)
    await waitFor(() => {
      expect(screen.getByTestId('agent-edit-error')).toBeInTheDocument()
    })
    expect(mockPush).not.toHaveBeenCalled()
  })
})
