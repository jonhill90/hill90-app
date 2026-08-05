import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock next/link
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
}))

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: any }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import AgentsClient from '@/app/agents/AgentsClient'

const MOCK_SESSION = {
  user: { name: 'Admin', email: 'admin@hill90.com', roles: ['admin'] },
  expires: '2026-12-31',
}

const MOCK_AGENTS = [
  {
    id: 'agent-1',
    agent_id: 'research-bot',
    name: 'ResearchBot',
    description: 'Researches topics',
    status: 'running',
    cpus: '0.5',
    mem_limit: '512m',
    pids_limit: 64,
    tools_config: {
      shell: { enabled: true, allowed_binaries: ['bash'], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace'], denied_paths: [] },
      health: { enabled: true },
    },
    models: ['gpt-4o-mini', 'claude-sonnet'],
    skills: [{ id: 'skill-dev', name: 'Developer', scope: 'container_local' }],
    avatar_key: null,
    hasAvatar: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    created_by: 'admin',
  },
  {
    id: 'agent-2',
    agent_id: 'writer-bot',
    name: 'WriterBot',
    description: 'Writes content',
    status: 'stopped',
    cpus: '1.0',
    mem_limit: '1g',
    pids_limit: 128,
    tools_config: {
      shell: { enabled: false, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: false, read_only: false, allowed_paths: [], denied_paths: [] },
      health: { enabled: true },
    },
    models: [],
    skills: [],
    avatar_key: null,
    hasAvatar: false,
    created_at: '2026-02-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
    created_by: 'admin',
  },
  {
    id: 'agent-3',
    agent_id: 'error-bot',
    name: 'ErrorBot',
    description: 'Has an error',
    status: 'error',
    cpus: '1.0',
    mem_limit: '1g',
    pids_limit: 128,
    tools_config: {
      shell: { enabled: true, allowed_binaries: [], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: false, read_only: false, allowed_paths: [], denied_paths: [] },
      health: { enabled: false },
    },
    models: [],
    skills: [],
    avatar_key: null,
    hasAvatar: false,
    created_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-01T00:00:00Z',
    created_by: 'admin',
  },
  {
    id: 'agent-4',
    agent_id: 'multi-skill-bot',
    name: 'MultiSkillBot',
    description: 'Has multiple skills',
    status: 'stopped',
    cpus: '2.0',
    mem_limit: '2g',
    pids_limit: 200,
    tools_config: {
      shell: { enabled: true, allowed_binaries: ['bash', 'git'], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace'], denied_paths: [] },
      health: { enabled: true },
    },
    models: [],
    skills: [
      { id: 'skill-dev', name: 'Developer', scope: 'container_local' },
      { id: 'skill-reader', name: 'Data Reader', scope: 'container_local' },
    ],
    avatar_key: null,
    hasAvatar: false,
    created_at: '2026-03-02T00:00:00Z',
    updated_at: '2026-03-02T00:00:00Z',
    created_by: 'admin',
  },
]

function mockFetchDefaults() {
  mockFetch.mockImplementation((url: string) => {
    if (url === '/api/agents') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('AgentsClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchDefaults()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders agent cards with names and status', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
      expect(screen.getByText('WriterBot')).toBeInTheDocument()
    })

    // Status badges + filter buttons both show these texts
    expect(screen.getAllByText('Running').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Stopped').length).toBeGreaterThan(0)
    expect(screen.getByText('4 agents')).toBeInTheDocument()
  })

  it('shows model badges on agents with assigned models', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument()
  })

  it('does not show model badges on agents without assigned models', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('WriterBot')).toBeInTheDocument()
    })

    const modelBadges = screen.queryAllByText('gpt-4o-mini')
    expect(modelBadges.length).toBe(1)
  })

  it('shows resource info on agent cards', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    expect(screen.getByText('0.5 CPU')).toBeInTheDocument()
    expect(screen.getByText('512m RAM')).toBeInTheDocument()
  })

  it('shows empty state when no agents', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/agents') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('No agents yet')).toBeInTheDocument()
    })
  })

  it('shows admin action buttons', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    expect(screen.getByText('Stop')).toBeInTheDocument()
    expect(screen.getAllByText('Start').length).toBeGreaterThan(0)
  })

  it('fetches agents on mount', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    expect(mockFetch).toHaveBeenCalledWith('/api/agents')
  })

  it('does not render legacy tool capability badges', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    expect(screen.queryByLabelText('Shell access')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Filesystem access')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Health endpoint')).not.toBeInTheDocument()
  })

  it('status filter shows only matching agents', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Click "Running" filter
    fireEvent.click(screen.getByRole('button', { name: /^Running$/i }))

    // Only ResearchBot should be visible
    expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    expect(screen.queryByText('WriterBot')).not.toBeInTheDocument()
    expect(screen.queryByText('ErrorBot')).not.toBeInTheDocument()
  })

  // T9: Agent list card shows skill badge with scope
  it('agent card shows skill name and scope', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // ResearchBot has Developer skill with container_local scope (MultiSkillBot also has it)
    expect(screen.getAllByText('Developer').length).toBeGreaterThan(0)
    // Scope badge "Container" appears on multiple agent cards
    expect(screen.getAllByText(/Container/).length).toBeGreaterThan(0)
  })

  // T10: Agent list card shows "No skills" when no skill
  it('agent card shows No skills when no skill', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('WriterBot')).toBeInTheDocument()
    })

    const noSkillBadges = screen.getAllByText('No skills')
    expect(noSkillBadges.length).toBeGreaterThan(0)
  })

  // U9: Agent list shows multiple skill badges
  it('agent card shows multiple skill badges', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('MultiSkillBot')).toBeInTheDocument()
    })

    // MultiSkillBot has Developer and Data Reader skills
    expect(screen.getByText('Data Reader')).toBeInTheDocument()
  })

  it('running agents appear before stopped agents', async () => {
    render(<AgentsClient session={MOCK_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Get all agent name links in order
    const links = screen.getAllByRole('link').filter(
      (el) => ['ResearchBot', 'WriterBot', 'ErrorBot'].includes(el.textContent || '')
    )

    // Running agent should be first
    expect(links[0].textContent).toBe('ResearchBot')
  })

  // app#408: #406 made POST /:id/start return a `warnings` array when
  // AKM/model-router token generation failed but the container still
  // launched. This is the human half — the UI must render it, visibly
  // enough that it is not mistaken for success.
  describe('start warnings (app#408)', () => {
    const WARNING_TEXT =
      'Model-router token generation failed — agent started but cannot make inference requests until it is stopped and restarted'

    it('a degraded start renders the warning banner on that agent only', async () => {
      mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
        if (url === '/api/agents') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
        }
        if (url === '/api/agents/agent-2/start' && opts?.method === 'POST') {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                status: 'running',
                container_id: 'c1',
                principal_id: 'agent-2',
                warnings: [WARNING_TEXT],
              }),
          })
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
      })

      render(<AgentsClient session={MOCK_SESSION as any} />)

      await waitFor(() => {
        expect(screen.getByText('WriterBot')).toBeInTheDocument()
      })

      const writerCard = screen.getByTestId('agent-card-agent-2')
      fireEvent.click(within(writerCard).getByText('Start'))

      await waitFor(() => {
        expect(screen.getByTestId('start-warnings-agent-2')).toBeInTheDocument()
      })
      expect(within(writerCard).getByText(WARNING_TEXT)).toBeInTheDocument()

      // Absent-safe on every OTHER agent — a banner that always appears
      // fails the same way as one that never does.
      expect(screen.queryByTestId('start-warnings-agent-1')).not.toBeInTheDocument()
      expect(screen.queryByTestId('start-warnings-agent-3')).not.toBeInTheDocument()
      expect(screen.queryByTestId('start-warnings-agent-4')).not.toBeInTheDocument()
    })

    it('a clean start renders no warning banner at all', async () => {
      mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
        if (url === '/api/agents') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
        }
        if (url === '/api/agents/agent-2/start' && opts?.method === 'POST') {
          // No `warnings` key at all — matches the API's own contract
          // (#406): present only when non-empty.
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({ status: 'running', container_id: 'c1', principal_id: 'agent-2' }),
          })
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
      })

      render(<AgentsClient session={MOCK_SESSION as any} />)

      await waitFor(() => {
        expect(screen.getByText('WriterBot')).toBeInTheDocument()
      })

      const writerCard = screen.getByTestId('agent-card-agent-2')
      fireEvent.click(within(writerCard).getByText('Start'))

      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith('/api/agents/agent-2/start', { method: 'POST' })
      })

      expect(screen.queryByTestId('start-warnings-agent-2')).not.toBeInTheDocument()
      expect(screen.queryByText(WARNING_TEXT)).not.toBeInTheDocument()
    })

    // THE ASSERTION THAT MATTERS (sibling drift sweep). handleAction (single
    // agent) and handleBulkStart both clear a stale startWarnings entry up
    // front (#408) — handleBulkStop, the third sibling doing the identical
    // "act on an agent, then refresh" job, did not. A degraded-start warning
    // on an agent that is then bulk-stopped kept showing the stale badge
    // even though the agent was no longer running — the exact regression
    // #408 fixed for the single-agent and bulk-start paths, reintroduced in
    // bulk-stop.
    it('bulk-stopping an agent with a stale start warning clears the warning', async () => {
      vi.stubGlobal('confirm', () => true)
      let agent2Running = false

      mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
        if (url === '/api/agents') {
          const agents = MOCK_AGENTS.map(a =>
            a.id === 'agent-2' && agent2Running ? { ...a, status: 'running' } : a
          )
          return Promise.resolve({ ok: true, json: () => Promise.resolve(agents) })
        }
        if (url === '/api/agents/agent-2/start' && opts?.method === 'POST') {
          agent2Running = true
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                status: 'running', container_id: 'c1', principal_id: 'agent-2',
                warnings: [WARNING_TEXT],
              }),
          })
        }
        if (opts?.method === 'POST' && url.endsWith('/stop')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'stopped' }) })
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
      })

      render(<AgentsClient session={MOCK_SESSION as any} />)

      await waitFor(() => {
        expect(screen.getByText('WriterBot')).toBeInTheDocument()
      })

      // Start WriterBot (agent-2) with a degraded-start warning.
      const writerCard = screen.getByTestId('agent-card-agent-2')
      fireEvent.click(within(writerCard).getByText('Start'))
      await waitFor(() => {
        expect(screen.getByTestId('start-warnings-agent-2')).toBeInTheDocument()
      })

      // Now bulk-stop every running agent (agent-1 was already running;
      // agent-2 just joined it) via "Stop All".
      await waitFor(() => {
        expect(screen.getByText(/Stop All/)).toBeInTheDocument()
      })
      fireEvent.click(screen.getByText(/Stop All/))

      await waitFor(() => {
        expect(screen.queryByTestId('start-warnings-agent-2')).not.toBeInTheDocument()
      })
      expect(screen.queryByText(WARNING_TEXT)).not.toBeInTheDocument()
    })
  })

  // Browser half of the silent-failure sweep: a failed /api/agents must not
  // render the same as "no agents yet" on the main list page.
  describe('a failed agents load renders an error, not an empty estate', () => {
    it('shows an error banner, not "No agents yet"', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === '/api/agents') {
          return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) })
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
      })

      render(<AgentsClient session={MOCK_SESSION as any} />)

      await waitFor(() => {
        expect(screen.getByTestId('agents-list-error')).toBeInTheDocument()
      })
      expect(screen.getByText('Could not load agents — try refreshing the page')).toBeInTheDocument()
      expect(screen.queryByText('No agents yet')).not.toBeInTheDocument()
    })

    it('a genuinely empty (but successful) agent list still shows "No agents yet"', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === '/api/agents') {
          return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
      })

      render(<AgentsClient session={MOCK_SESSION as any} />)

      await waitFor(() => {
        expect(screen.getByText('No agents yet')).toBeInTheDocument()
      })
      expect(screen.queryByTestId('agents-list-error')).not.toBeInTheDocument()
    })
  })
})
