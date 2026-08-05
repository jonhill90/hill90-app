import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
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

function mockFetchDefaults(bindings: unknown[] = MOCK_BINDINGS) {
  return vi.fn((url: string) => {
    if (url === '/api/discord/bindings') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(bindings) })
    }
    if (url === '/api/discord/status') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ configured: true, status: 'ok', message: '' }) })
    }
    if (url === '/api/agents') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
    }
    if (url === '/api/discord/user-links') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
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
})
