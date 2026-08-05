import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import DiscordClient from '@/app/harness/discord/DiscordClient'

const MOCK_BINDINGS = [
  {
    id: 'b1',
    channel_id: '123456789012345678',
    guild_id: '987654321098765432',
    agent_id: 'a1',
    agent_name: 'Monitor Bot',
    agent_slug: 'monitor-bot',
    thread_id: null,
    created_at: new Date().toISOString(),
  },
]

const MOCK_AGENTS = [{ id: 'a1', name: 'Monitor Bot', agent_id: 'monitor-bot' }]

const MOCK_LINKS = [
  { id: 'l1', discord_user_id: '111222333444555666', hill90_user_id: 'user-uuid-1', created_at: new Date().toISOString() },
]

function mockFetchDefaults(bindings: unknown[] = MOCK_BINDINGS, agents: unknown[] = MOCK_AGENTS, links: unknown[] = []) {
  return vi.fn((url: string) => {
    if (url === '/api/discord/bindings') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(bindings) })
    }
    if (url === '/api/discord/status') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ configured: true, status: 'ok', message: '' }) })
    }
    if (url === '/api/agents') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(agents) })
    }
    if (url === '/api/discord/user-links') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(links) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('DiscordClient', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders channel bindings after fetch', async () => {
    vi.stubGlobal('fetch', mockFetchDefaults())
    render(<DiscordClient />)
    await waitFor(() => {
      expect(screen.getByText('Monitor Bot')).toBeInTheDocument()
    })
  })

  it('shows empty state when no bindings', async () => {
    vi.stubGlobal('fetch', mockFetchDefaults([]))
    render(<DiscordClient />)
    await waitFor(() => {
      expect(screen.getByText('No channels bound yet. Bind a Discord channel to an agent to start.')).toBeInTheDocument()
    })
  })

  it('shows an error state, not the empty state, when the bindings fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/discord/bindings') {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })
      }
      if (url === '/api/discord/status') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ configured: true, status: 'ok', message: '' }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    }))
    render(<DiscordClient />)
    await waitFor(() => {
      expect(screen.getByTestId('bindings-error')).toBeInTheDocument()
    })
    expect(screen.queryByText('No channels bound yet. Bind a Discord channel to an agent to start.')).not.toBeInTheDocument()
  })

  it('shows an alert, not a silently-open form, when creating a channel binding fails', async () => {
    vi.stubGlobal('alert', vi.fn())
    vi.stubGlobal('fetch', vi.fn((url: string, opts?: any) => {
      if (url === '/api/discord/bindings' && (!opts || !opts.method)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_BINDINGS) })
      }
      if (url === '/api/discord/bindings' && opts?.method === 'POST') {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'db unavailable' }) })
      }
      if (url === '/api/discord/status') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ configured: true, status: 'ok', message: '' }) })
      }
      if (url === '/api/agents') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    }))

    render(<DiscordClient />)
    await waitFor(() => {
      expect(screen.getByText('Monitor Bot')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Bind Channel'))
    fireEvent.change(screen.getByPlaceholderText('123456789012345678'), { target: { value: '999888777666555444' } })
    fireEvent.change(screen.getByPlaceholderText('987654321098765432'), { target: { value: '111000999888777666' } })
    fireEvent.change(screen.getByDisplayValue('Select agent...'), { target: { value: 'a1' } })
    fireEvent.click(screen.getByText('Create'))

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith('db unavailable')
    })
    // The form must still be open with the entered data — it must not look
    // like the binding was created.
    expect(screen.getByDisplayValue('999888777666555444')).toBeInTheDocument()
  })

  it('shows an alert, not a silent no-op, when deleting a channel binding fails', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.stubGlobal('alert', vi.fn())
    vi.stubGlobal('fetch', vi.fn((url: string, opts?: any) => {
      if (url === '/api/discord/bindings' && (!opts || !opts.method)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_BINDINGS) })
      }
      if (url === '/api/discord/bindings/b1' && opts?.method === 'DELETE') {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'db unavailable' }) })
      }
      if (url === '/api/discord/status') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ configured: true, status: 'ok', message: '' }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    }))

    render(<DiscordClient />)
    await waitFor(() => {
      expect(screen.getByText('Monitor Bot')).toBeInTheDocument()
    })

    const row = screen.getByText(/Channel: 123456789012345678/).closest('.rounded-md')!
    fireEvent.click(row.querySelector('button')!)

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith('db unavailable')
    })
    expect(screen.getByText(/Channel: 123456789012345678/)).toBeInTheDocument()
  })

  it('shows an alert, not a silently-open form, when linking a Discord user fails', async () => {
    vi.stubGlobal('alert', vi.fn())
    vi.stubGlobal('fetch', vi.fn((url: string, opts?: any) => {
      if (url === '/api/discord/bindings') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_BINDINGS) })
      }
      if (url === '/api/discord/status') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ configured: true, status: 'ok', message: '' }) })
      }
      if (url === '/api/agents') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
      }
      if (url === '/api/discord/user-links' && (!opts || !opts.method)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      }
      if (url === '/api/discord/user-links' && opts?.method === 'POST') {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'db unavailable' }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }))

    render(<DiscordClient />)
    await waitFor(() => {
      expect(screen.getByText('Monitor Bot')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Link Account'))
    fireEvent.change(screen.getByPlaceholderText('123456789012345678'), { target: { value: '555444333222111000' } })
    fireEvent.click(screen.getByText('Link'))

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith('db unavailable')
    })
    expect(screen.getByDisplayValue('555444333222111000')).toBeInTheDocument()
  })

  it('shows an alert, not a silent no-op, when deleting a user link fails', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.stubGlobal('alert', vi.fn())
    vi.stubGlobal('fetch', vi.fn((url: string, opts?: any) => {
      if (url === '/api/discord/bindings') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_BINDINGS) })
      }
      if (url === '/api/discord/status') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ configured: true, status: 'ok', message: '' }) })
      }
      if (url === '/api/agents') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
      }
      if (url === '/api/discord/user-links' && (!opts || !opts.method)) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_LINKS) })
      }
      if (url === '/api/discord/user-links/l1' && opts?.method === 'DELETE') {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'db unavailable' }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }))

    render(<DiscordClient />)
    await waitFor(() => {
      expect(screen.getByText(/Discord: 111222333444555666/)).toBeInTheDocument()
    })

    const row = screen.getByText(/Discord: 111222333444555666/).closest('.rounded-md')!
    fireEvent.click(row.querySelector('button')!)

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith('db unavailable')
    })
    expect(screen.getByText(/Discord: 111222333444555666/)).toBeInTheDocument()
  })
})
