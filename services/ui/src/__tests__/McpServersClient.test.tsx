import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { roles: ['user'] } }, status: 'authenticated' }),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}))

vi.mock('next/navigation', () => ({
  usePathname: () => '/harness/mcp-servers',
}))

import McpServersClient from '@/app/harness/mcp-servers/McpServersClient'

// app#369: the API no longer returns connection_config at all — the
// credential-bearing part of it is encrypted at rest. It sends
// connection_display instead: a server-computed, non-secret summary
// (command verbatim + arg/env counts for stdio, origin-only for sse/http).
// These mocks intentionally carry NO connection_config field, matching the
// real response shape, so a regression that reads the old field name is
// exercised here rather than hidden by a fixture that still has it.
const MOCK_SERVERS = [
  {
    id: 's1',
    name: 'GitHub MCP',
    description: 'GitHub API tools',
    transport: 'stdio',
    connection_display: { command: 'npx', args_count: 2 },
    is_platform: false,
    agent_count: 2,
    created_by: 'user1',
    created_at: new Date().toISOString(),
  },
  {
    id: 's2',
    name: 'Knowledge Server',
    description: null,
    transport: 'sse',
    connection_display: { url_origin: 'http://localhost:3001' },
    is_platform: true,
    agent_count: 0,
    created_by: 'system',
    created_at: new Date().toISOString(),
  },
]

describe('McpServersClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders page title and description', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SERVERS) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText('MCP Servers')).toBeInTheDocument()
    })
    expect(screen.getByText(/model context protocol/i)).toBeInTheDocument()
  })

  it('renders server list after fetch', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SERVERS) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText('GitHub MCP')).toBeInTheDocument()
    })
    expect(screen.getByText('Knowledge Server')).toBeInTheDocument()
  })

  it('shows transport badges', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SERVERS) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText('stdio')).toBeInTheDocument()
    })
    expect(screen.getByText('sse')).toBeInTheDocument()
  })

  it('shows platform badge for platform servers', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SERVERS) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText('platform')).toBeInTheDocument()
    })
  })

  it('shows agent count', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SERVERS) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText('2 agents')).toBeInTheDocument()
    })
    expect(screen.getByText('0 agents')).toBeInTheDocument()
  })

  it('shows empty state when no servers', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText(/no mcp servers configured/i)).toBeInTheDocument()
    })
  })

  it('shows create form when Add Server clicked', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText(/no mcp servers configured/i)).toBeInTheDocument()
    })
    // Click the first Add Server button
    fireEvent.click(screen.getAllByText('Add Server')[0])
    expect(screen.getByText('New MCP Server')).toBeInTheDocument()
    expect(screen.getByText('Transport')).toBeInTheDocument()
  })

  it('shows command field for stdio transport', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText(/no mcp servers configured/i)).toBeInTheDocument()
    })
    fireEvent.click(screen.getAllByText('Add Server')[0])
    expect(screen.getByText('Command')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/npx -y/)).toBeInTheDocument()
  })

  it('shows URL field for SSE transport', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText(/no mcp servers configured/i)).toBeInTheDocument()
    })
    fireEvent.click(screen.getAllByText('Add Server')[0])
    // Switch to SSE
    fireEvent.change(screen.getByDisplayValue('stdio (local process)'), { target: { value: 'sse' } })
    expect(screen.getByText('Server URL')).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/localhost:3001/)).toBeInTheDocument()
  })

  it('shows description when present', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SERVERS) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText('GitHub API tools')).toBeInTheDocument()
    })
  })

  it('handles non-array API response gracefully', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ error: 'not found' }) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText(/no mcp servers configured/i)).toBeInTheDocument()
    })
  })

  // app#369, direction 1: the list must not render blank for a server that
  // HAS a command. Before this fix, the list read connection_config
  // directly, which the API no longer sends — that field is fully absent
  // (not present-but-empty), so the old code threw reading .command off
  // undefined rather than rendering blank. Either failure mode — a thrown
  // render error or an empty command — is caught here.
  it('renders the command for a server that has one, not a blank or crashed list', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SERVERS) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText('GitHub MCP')).toBeInTheDocument()
    })
    expect(screen.getByText(/npx/)).toBeInTheDocument()
    expect(screen.getByText(/2 args hidden/)).toBeInTheDocument()
    expect(screen.getByText(/localhost:3001/)).toBeInTheDocument()
  })

  // app#369, direction 2: whatever the API sends, the secret itself must
  // never reach the DOM. connection_display only ever carries a command
  // string, counts, and a URL origin — never args/env values or a path/
  // query — so a server that (hypothetically, via a future regression)
  // sent a raw secret through connection_display would still not have it
  // rendered, because the component only reads the specific safe subfields.
  it('never renders a value under an unexpected connection_display field', async () => {
    const SERVER_WITH_UNEXPECTED_FIELD = {
      ...MOCK_SERVERS[0],
      id: 's3',
      name: 'Unexpected Field MCP',
      connection_display: {
        command: 'npx',
        args_count: 1,
        // Not a field the component reads — simulates a hypothetical
        // regression where a raw value leaked into connection_display.
        raw_secret: 'ghp_SUPERSECRETVALUE123',
      },
    }
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([SERVER_WITH_UNEXPECTED_FIELD]) })))
    render(<McpServersClient />)
    await waitFor(() => {
      expect(screen.getByText('Unexpected Field MCP')).toBeInTheDocument()
    })
    expect(screen.queryByText(/ghp_SUPERSECRETVALUE123/)).not.toBeInTheDocument()
  })
})
