import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: React.ReactNode; href: string; [key: string]: any }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

// Mock next/navigation
const mockPush = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, back: vi.fn() }),
}))

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Mock confirm/alert
vi.stubGlobal('confirm', vi.fn(() => true))
vi.stubGlobal('alert', vi.fn())

// Mock EventTimeline to avoid EventSource in tests
vi.mock('@/app/agents/[id]/EventTimeline', () => ({
  default: ({ agentId, agentStatus }: { agentId: string; agentStatus: string }) => (
    <div data-testid="event-timeline">EventTimeline: {agentStatus}</div>
  ),
}))

import AgentDetailClient from '@/app/agents/[id]/AgentDetailClient'

const MOCK_AGENT = {
  id: 'uuid-1',
  agent_id: 'research-bot',
  name: 'ResearchBot',
  description: 'Researches topics and summarizes findings',
  status: 'stopped',
  cpus: '1.0',
  mem_limit: '1g',
  pids_limit: 200,
  tools_config: {
    shell: { enabled: true, allowed_binaries: ['bash', 'python3'], denied_patterns: ['rm -rf'], max_timeout: 600 },
    filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace'], denied_paths: ['/etc/shadow'] },
    health: { enabled: true },
  },
  soul_md: 'You are a research assistant.',
  rules_md: 'Always cite sources.',
  container_id: null,
  model_policy_id: 'policy-1',
  models: ['gpt-4o-mini', 'claude-sonnet-4-5-20250929'],
  skills: [],
  hasAvatar: false,
  error_message: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-15T00:00:00Z',
  created_by: 'admin',
}

const MOCK_AGENT_WITH_SKILL = {
  ...MOCK_AGENT,
  skills: [
    {
      id: 'preset-dev',
      name: 'Developer',
      scope: 'container_local',
      tools: [{ id: 'tool-gh', name: 'gh' }, { id: 'tool-git', name: 'git' }],
      instructions_md: 'Always write tests before implementation.\nFollow TDD red-green-refactor.',
    },
  ],
}

const MOCK_USAGE = {
  total_requests: 150,
  total_tokens: 25000,
  total_cost_usd: '3.50',
}

const MOCK_KNOWLEDGE_ENTRIES = [
  { id: '1', agent_id: 'research-bot', path: 'notes/research.md', title: 'Research Notes', entry_type: 'note', tags: [], status: 'active', sync_status: 'synced', created_at: '2026-01-10T00:00:00Z', updated_at: '2026-01-10T00:00:00Z' },
  { id: '2', agent_id: 'research-bot', path: 'docs/api.md', title: 'API Documentation', entry_type: 'doc', tags: ['api'], status: 'active', sync_status: 'synced', created_at: '2026-01-12T00:00:00Z', updated_at: '2026-01-12T00:00:00Z' },
]

const MOCK_KNOWLEDGE_SEARCH_RESULTS = {
  query: 'test', results: [
    { id: '1', agent_id: 'research-bot', path: 'notes/research.md', title: 'Research Notes', entry_type: 'note', tags: [], score: 0.85, headline: 'Some **test** content', created_at: '2026-01-10T00:00:00Z', updated_at: '2026-01-10T00:00:00Z' },
  ], count: 1, search_type: 'fts', score_type: 'ts_rank',
}

const MOCK_KNOWLEDGE_ENTRY_DETAIL = {
  id: '1', agent_id: 'research-bot', path: 'notes/research.md', title: 'Research Notes', entry_type: 'note', content: '# Research Notes\n\nFull content here.', content_hash: 'abc123', tags: [], status: 'active', sync_status: 'synced', created_at: '2026-01-10T00:00:00Z', updated_at: '2026-01-10T00:00:00Z',
}

const ADMIN_SESSION = {
  user: { name: 'Admin', email: 'admin@hill90.com', roles: ['admin'] },
  expires: '2026-12-31',
}

const USER_SESSION = {
  user: { name: 'User', email: 'user@hill90.com', roles: ['user'] },
  expires: '2026-12-31',
}

const MOCK_ALL_SKILLS = [
  { id: 'preset-dev', name: 'Developer', scope: 'container_local', tools: [{ id: 'tool-gh', name: 'gh' }, { id: 'tool-git', name: 'git' }], instructions_md: 'Dev instructions' },
  { id: 'skill-docker', name: 'Docker Access', scope: 'host_docker', tools: [], instructions_md: 'Docker instructions' },
  { id: 'skill-vps', name: 'VPS Admin', scope: 'vps_system', tools: [], instructions_md: 'VPS instructions' },
]

const MOCK_TOOL_INSTALLS = [
  {
    tool_id: 'tool-gh',
    tool_name: 'gh',
    tool_description: 'GitHub CLI',
    status: 'installed',
    install_message: 'installed',
    installed_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-01T00:00:00Z',
  },
]

const MOCK_AGENT_WITH_MULTI_SKILLS = {
  ...MOCK_AGENT,
  skills: [
    {
      id: 'preset-dev',
      name: 'Developer',
      scope: 'container_local',
      tools: [{ id: 'tool-gh', name: 'gh' }, { id: 'tool-git', name: 'git' }],
      instructions_md: 'Dev instructions.',
    },
    {
      id: 'skill-docker',
      name: 'Docker Access',
      scope: 'host_docker',
      tools: [],
      instructions_md: 'Docker instructions here.',
    },
  ],
}

const MOCK_AGENT_WITH_ELEVATED_SKILL = {
  ...MOCK_AGENT,
  skills: [
    {
      id: 'skill-docker',
      name: 'Docker Access',
      scope: 'host_docker',
      tools: [],
      instructions_md: 'Docker instructions here.',
    },
  ],
}

function mockFetchDefaults(agentOverride?: typeof MOCK_AGENT) {
  mockFetch.mockImplementation((url: string, opts?: any) => {
    if (url === `/api/agents/uuid-1` && (!opts || !opts.method || opts.method === 'GET')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(agentOverride || MOCK_AGENT) })
    }
    if (url === '/api/skills') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_ALL_SKILLS) })
    }
    if (typeof url === 'string' && url.includes('/api/agents/uuid-1/tool-installs')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_TOOL_INSTALLS) })
    }
    if (typeof url === 'string' && url.includes('/api/usage')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_USAGE) })
    }
    if (typeof url === 'string' && url.includes('/api/knowledge/search')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_KNOWLEDGE_SEARCH_RESULTS) })
    }
    if (typeof url === 'string' && /\/api\/knowledge\/entries\/[^/]+\/.+/.test(url)) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_KNOWLEDGE_ENTRY_DETAIL) })
    }
    if (typeof url === 'string' && url.includes('/api/knowledge/entries')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_KNOWLEDGE_ENTRIES) })
    }
    if (typeof url === 'string' && url.includes('/skills') && opts?.method === 'POST') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }
    if (typeof url === 'string' && url.includes('/skills/') && opts?.method === 'DELETE') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('AgentDetailClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchDefaults()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders overview tab without legacy tool access summary', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Overview tab should be active by default
    expect(screen.getByText('Overview')).toBeInTheDocument()
    // Status info
    expect(screen.getByText('stopped')).toBeInTheDocument()
    // Legacy overview tool summary removed
    expect(screen.queryByText('Tool Access')).not.toBeInTheDocument()
    expect(screen.getByText('Tool Install Status')).toBeInTheDocument()
    expect(screen.getByText('gh')).toBeInTheDocument()
    expect(screen.getAllByText('installed').length).toBeGreaterThan(0)
  })

  it('shows an alert, not a silent no-op, when an avatar upload fails', async () => {
    mockFetchDefaults()
    const defaultImpl = mockFetch.getMockImplementation()!
    mockFetch.mockImplementation((url: string, opts?: any) => {
      if (url === '/api/agents/uuid-1/avatar' && opts?.method === 'POST') {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'db unavailable' }) })
      }
      return defaultImpl(url, opts)
    })

    const { container } = render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)
    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['fake image bytes'], 'avatar.png', { type: 'image/png' })
    fireEvent.change(fileInput, { target: { files: [file] } })

    await waitFor(() => {
      expect(window.alert).toHaveBeenCalledWith('db unavailable')
    })
    // hasAvatar was never set — a failed upload must not look like it worked.
    expect(screen.getByText('ResearchBot')).toBeInTheDocument()
  })

  // This sweep's finding #1/#2: Start/Stop/Delete/Clone/Assign-Skill/
  // Remove-Skill/Reconcile all had `res.json()` on the failure branch with
  // no `.catch()`, and an outer catch that only `console.error`'d — so a
  // non-JSON error body (a 502/504 from a proxy timeout) made the action
  // fail completely silently. THE ASSERTION THAT MATTERS is not "no
  // unhandled rejection" — a version that swallows the error into silence
  // would pass that too, which is the same defect wearing a different coat
  // (hit twice already today, #513 and #518). What has to be checked is
  // whether the USER sees something: a toast with text in it.
  describe('a non-JSON error body no longer fails silently (this sweep)', () => {
    it('Start shows a toast, not silence, when the server answers with a body res.json() cannot parse', async () => {
      mockFetchDefaults()
      const defaultImpl = mockFetch.getMockImplementation()!
      mockFetch.mockImplementation((url: string, opts?: any) => {
        if (url === '/api/agents/uuid-1/start' && opts?.method === 'POST') {
          return Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new Error('not json')) })
        }
        return defaultImpl(url, opts)
      })

      render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)
      await waitFor(() => {
        expect(screen.getByText('ResearchBot')).toBeInTheDocument()
      })

      // MOCK_AGENT.status is 'stopped', so the visible action is Start.
      fireEvent.click(screen.getByRole('button', { name: 'Start' }))

      await waitFor(() => {
        expect(screen.getByTestId('toast-error')).toBeInTheDocument()
      })
      expect(screen.getByTestId('toast-error')).toHaveTextContent('HTTP 502')
    })

    it('Delete shows a toast, not silence, and does not navigate away, on the same failure shape', async () => {
      mockFetchDefaults()
      const defaultImpl = mockFetch.getMockImplementation()!
      mockFetch.mockImplementation((url: string, opts?: any) => {
        if (url === '/api/agents/uuid-1' && opts?.method === 'DELETE') {
          return Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new Error('not json')) })
        }
        return defaultImpl(url, opts)
      })

      render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)
      await waitFor(() => {
        expect(screen.getByText('ResearchBot')).toBeInTheDocument()
      })

      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

      await waitFor(() => {
        expect(screen.getByTestId('toast-error')).toBeInTheDocument()
      })
      expect(screen.getByTestId('toast-error')).toHaveTextContent('HTTP 502')
      // The believed-saved-and-lost case in the other direction: a failed
      // delete must not navigate away as though it had succeeded.
      expect(mockPush).not.toHaveBeenCalled()
    })
  })

  it('clicking Configuration tab shows skills runtime summary', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Click Configuration tab
    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }))

    // Should show skills runtime summary (no legacy tool config detail)
    await waitFor(() => {
      expect(screen.getByText('Skills Runtime')).toBeInTheDocument()
    })
    expect(screen.queryByText('Tool Configuration')).not.toBeInTheDocument()
  })

  it('fetches usage data only when Model Access tab clicked', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Usage should NOT be fetched on initial load
    const usageCalls = mockFetch.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].includes('/api/usage')
    )
    expect(usageCalls).toHaveLength(0)

    // Click Model Access tab
    fireEvent.click(screen.getByRole('button', { name: 'Model Access' }))

    // Now usage should be fetched
    await waitFor(() => {
      const usageCallsAfter = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('/api/usage')
      )
      expect(usageCallsAfter.length).toBeGreaterThan(0)
    })
  })

  it('Memory tab renders AgentMemory component', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Click Memory tab
    fireEvent.click(screen.getByRole('button', { name: 'Memory' }))

    // AgentMemory component should render — check for its search input
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search memory entries...')).toBeInTheDocument()
    })
  })

  it('Activity tab visible to non-admin users', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={USER_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    expect(screen.getByRole('button', { name: 'Activity' })).toBeInTheDocument()
  })

  it('Activity tab visible to admin users', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    expect(screen.getByRole('button', { name: 'Activity' })).toBeInTheDocument()
  })

  it('Raw Logs sub-view requires admin', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={USER_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Click Activity tab
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }))

    // Non-admin should NOT see Raw Logs toggle
    expect(screen.queryByTestId('raw-logs-toggle')).not.toBeInTheDocument()
  })

  it('Raw Logs sub-view visible to admins', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Click Activity tab
    fireEvent.click(screen.getByRole('button', { name: 'Activity' }))

    // Admin should see Raw Logs toggle
    expect(screen.getByTestId('raw-logs-toggle')).toBeInTheDocument()
  })

  it('Configuration tab displays resources', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }))

    await waitFor(() => {
      expect(screen.getByText('Resources')).toBeInTheDocument()
    })
  })

  // app#374/#386 REVIEW: the shape this exists to catch. Before this fix,
  // handleAddEnvVar built its PUT body from `{ ...(agent.env_vars || {}),
  // [key]: envVal }` — a client-side read-modify-write. Once env_vars
  // stopped being returned (values encrypted at rest, #386's first pass),
  // `agent.env_vars` was always undefined, so that spread silently became
  // `{}`: saving ONE variable sent a payload that, under the OLD
  // full-replace server contract, would have deleted every other key —
  // with a success path and no error. THE ASSERTION THAT MATTERS is that
  // the request this component sends can no longer even express that: it
  // must never carry any key this test didn't ask for, and it must never
  // resemble a full replacement.
  it('adding one environment variable sends ONLY that key — never a reconstructed full map that could drop others', async () => {
    const agentWithTwoVars = { ...MOCK_AGENT, env_var_keys: ['ANTHROPIC_API_KEY', 'LOG_LEVEL'] }
    mockFetchDefaults(agentWithTwoVars as any)
    const defaultImpl = mockFetch.getMockImplementation()!
    let putBody: any = null
    mockFetch.mockImplementation((url: string, opts?: any) => {
      if (url === '/api/agents/uuid-1' && opts?.method === 'PUT') {
        putBody = JSON.parse(opts.body)
        return Promise.resolve({ ok: true, json: () => Promise.resolve(agentWithTwoVars) })
      }
      return defaultImpl(url, opts)
    })

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)
    await waitFor(() => expect(screen.getByText('ResearchBot')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }))
    await waitFor(() => expect(screen.getByText('Environment Variables')).toBeInTheDocument())

    // An existing key is shown in the table (from env_var_keys, value
    // masked) — confirms the fixture reflects "an agent that already has
    // variables", the exact case a whole-map replace would have destroyed.
    // (ANTHROPIC_API_KEY isn't queried here — it also appears in the
    // separate Claude Code widget above this table, so LOG_LEVEL, unique
    // to the generic env-var table, is the unambiguous check.)
    expect(screen.getByText('LOG_LEVEL')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('KEY'), { target: { value: 'DEBUG_MODE' } })
    const valueInput = screen.getByPlaceholderText('value')
    fireEvent.change(valueInput, { target: { value: 'true' } })
    // Scoped to this input's own row — the Tags section above it also has
    // an "Add" button with the same accessible name.
    fireEvent.click(within(valueInput.closest('div')!).getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(putBody).not.toBeNull())
    expect(putBody).toEqual({ env_vars_set: { DEBUG_MODE: 'true' } })
    // The specific regression this test exists for: the request must not
    // even be SHAPED like a full replacement of the other two keys.
    expect(putBody.env_vars).toBeUndefined()
    expect(Object.keys(putBody.env_vars_set)).toEqual(['DEBUG_MODE'])
  })

  it('removing one environment variable sends only its key via env_vars_unset', async () => {
    const agentWithTwoVars = { ...MOCK_AGENT, env_var_keys: ['ANTHROPIC_API_KEY', 'LOG_LEVEL'] }
    mockFetchDefaults(agentWithTwoVars as any)
    const defaultImpl = mockFetch.getMockImplementation()!
    let putBody: any = null
    mockFetch.mockImplementation((url: string, opts?: any) => {
      if (url === '/api/agents/uuid-1' && opts?.method === 'PUT') {
        putBody = JSON.parse(opts.body)
        return Promise.resolve({ ok: true, json: () => Promise.resolve(agentWithTwoVars) })
      }
      return defaultImpl(url, opts)
    })

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)
    await waitFor(() => expect(screen.getByText('ResearchBot')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }))
    await waitFor(() => expect(screen.getByText('LOG_LEVEL')).toBeInTheDocument())

    // The × button next to LOG_LEVEL's row.
    const row = screen.getByText('LOG_LEVEL').closest('tr')!
    fireEvent.click(within(row).getByRole('button'))

    await waitFor(() => expect(putBody).not.toBeNull())
    expect(putBody).toEqual({ env_vars_unset: ['LOG_LEVEL'] })
  })

  // app#453: handleRemoveEnvVar used to skip the confirm() its sibling
  // handleRemoveSkill has. Unlike a tag (see the app#453 comment on
  // handleRemoveTag in the component itself), an env var's value is never
  // readable back from the API once set — removing one is not "annoying to
  // retype", the value is gone. This test declines the dialog and asserts
  // the DELETE-shaped PUT never fires, not merely that a dialog appeared.
  it('does NOT remove an environment variable when the confirm is declined — no PUT must fire', async () => {
    const agentWithTwoVars = { ...MOCK_AGENT, env_var_keys: ['ANTHROPIC_API_KEY', 'LOG_LEVEL'] }
    mockFetchDefaults(agentWithTwoVars as any)
    const defaultImpl = mockFetch.getMockImplementation()!
    let putCalled = false
    mockFetch.mockImplementation((url: string, opts?: any) => {
      if (url === '/api/agents/uuid-1' && opts?.method === 'PUT') {
        putCalled = true
        return Promise.resolve({ ok: true, json: () => Promise.resolve(agentWithTwoVars) })
      }
      return defaultImpl(url, opts)
    })

    const confirmMock = vi.fn(() => false)
    vi.stubGlobal('confirm', confirmMock)

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)
    await waitFor(() => expect(screen.getByText('ResearchBot')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }))
    await waitFor(() => expect(screen.getByText('LOG_LEVEL')).toBeInTheDocument())

    const row = screen.getByText('LOG_LEVEL').closest('tr')!
    fireEvent.click(within(row).getByRole('button'))

    expect(confirmMock).toHaveBeenCalledWith('Remove the environment variable "LOG_LEVEL"? Its value cannot be recovered once removed.')
    // Declining must be a true no-op — no request, and the row still there.
    expect(putCalled).toBe(false)
    expect(screen.getByText('LOG_LEVEL')).toBeInTheDocument()

    vi.stubGlobal('confirm', vi.fn(() => true))
  })

  // app#453: the deliberate other half. handleRemoveTag does NOT confirm —
  // this pins that as intended behavior (see the comment on handleRemoveTag
  // itself) so a future "make it consistent with its siblings" pass doesn't
  // add a dialog here reflexively. A removed tag costs nothing to redo: it
  // is a short string the user just typed, retypeable and re-addable in one
  // step, unlike a skill grant or an unrecoverable env var value.
  it('removes a tag with NO confirm dialog — deliberately, unlike handleRemoveSkill/handleRemoveEnvVar', async () => {
    const agentWithTag = { ...MOCK_AGENT, tags: ['staging'] }
    mockFetchDefaults(agentWithTag as any)
    const defaultImpl = mockFetch.getMockImplementation()!
    let putBody: any = null
    mockFetch.mockImplementation((url: string, opts?: any) => {
      if (url === '/api/agents/uuid-1' && opts?.method === 'PUT') {
        putBody = JSON.parse(opts.body)
        return Promise.resolve({ ok: true, json: () => Promise.resolve(agentWithTag) })
      }
      return defaultImpl(url, opts)
    })

    const confirmMock = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmMock)

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)
    await waitFor(() => expect(screen.getByText('ResearchBot')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Configuration' }))
    await waitFor(() => expect(screen.getByText('staging')).toBeInTheDocument())

    fireEvent.click(screen.getByText('×'))

    await waitFor(() => expect(putBody).not.toBeNull())
    expect(putBody).toEqual({ tags: [] })
    // The point of this test: removal happened without ever asking.
    expect(confirmMock).not.toHaveBeenCalled()

    vi.stubGlobal('confirm', vi.fn(() => true))
  })

  it('Model Access tab shows assigned models', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Model Access' }))

    await waitFor(() => {
      expect(screen.getByText('Assigned Models')).toBeInTheDocument()
    })
    expect(screen.getByText('gpt-4o-mini')).toBeInTheDocument()
    expect(screen.getByText('claude-sonnet-4-5-20250929')).toBeInTheDocument()
  })

  // T1: Detail skills card renders each skill with name and scope badge
  it('renders skills list with scope badges', async () => {
    mockFetchDefaults(MOCK_AGENT_WITH_SKILL as any)

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Skills card should show skill name and scope badge
    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })
    // Multiple "Container" badges may appear (skills card + assign picker)
    expect(screen.getAllByText('Container').length).toBeGreaterThan(0)
  })

  // T2: Detail skills card empty state
  it('shows no skills assigned when empty', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    expect(screen.getByText('No skills assigned')).toBeInTheDocument()
  })

  // T3: Detail assign skill calls POST
  it('assign skill calls POST endpoint', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Click "Assign Skill" to open picker
    fireEvent.click(screen.getByText('Assign Skill'))

    // Select Developer skill from picker
    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('Developer'))

    // Should have called POST /api/agents/uuid-1/skills
    await waitFor(() => {
      const postCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('/skills') && c[1]?.method === 'POST'
      )
      expect(postCalls.length).toBeGreaterThan(0)
    })
  })

  // T4: Detail remove skill calls DELETE
  it('remove skill calls DELETE endpoint', async () => {
    mockFetchDefaults(MOCK_AGENT_WITH_SKILL as any)

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Click Remove button
    fireEvent.click(screen.getByText('Remove'))

    // Should have called DELETE
    await waitFor(() => {
      const deleteCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('/skills/') && c[1]?.method === 'DELETE'
      )
      expect(deleteCalls.length).toBeGreaterThan(0)
    })
  })

  // T5: Remove hidden for non-admin on elevated skill
  it('remove hidden for non-admin on host_docker skill', async () => {
    mockFetchDefaults(MOCK_AGENT_WITH_ELEVATED_SKILL as any)

    render(<AgentDetailClient agentId="uuid-1" session={USER_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Docker Access')).toBeInTheDocument()
    })

    // Non-admin should NOT see Remove button for host_docker skill
    expect(screen.queryByText('Remove')).not.toBeInTheDocument()
  })

  // T6: Remove shown for non-admin on container_local skill
  it('remove shown for non-admin on container_local skill', async () => {
    mockFetchDefaults(MOCK_AGENT_WITH_SKILL as any)

    render(<AgentDetailClient agentId="uuid-1" session={USER_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Non-admin CAN see Remove button for container_local skill
    expect(screen.getByText('Remove')).toBeInTheDocument()
  })

  // T7: Assign picker filters elevated scopes for non-admin
  it('assign picker excludes elevated skills for non-admin', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={USER_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Click "Assign Skill" to open picker
    fireEvent.click(screen.getByText('Assign Skill'))

    // Should show container_local skill but NOT elevated ones
    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })
    expect(screen.queryByText('Docker Access')).not.toBeInTheDocument()
    expect(screen.queryByText('VPS Admin')).not.toBeInTheDocument()
  })

  // U7: Assign picker excludes already-assigned skills
  it('assign picker excludes already-assigned skills', async () => {
    mockFetchDefaults(MOCK_AGENT_WITH_SKILL as any)

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Click "Assign Skill" to open picker
    fireEvent.click(screen.getByText('Assign Skill'))

    // Developer is already assigned -- should NOT appear in picker
    // But Docker Access and VPS Admin should appear (admin sees all)
    await waitFor(() => {
      expect(screen.getByText('Docker Access')).toBeInTheDocument()
    })
    expect(screen.getByText('VPS Admin')).toBeInTheDocument()

    // The picker should have items for Docker Access and VPS Admin but not Developer
    // Developer already appears in the skills list above, so we verify the picker
    // doesn't have a second clickable button for Developer
    const pickerButtons = screen.getAllByRole('button').filter(
      btn => btn.textContent?.includes('Developer') && btn.closest('[class*="navy-900"]')
    )
    // The picker is inside a navy-900 div -- should not have Developer there
    expect(pickerButtons).toHaveLength(0)
  })

  // U8: Detail shows multiple skill cards
  it('shows multiple skill cards', async () => {
    mockFetchDefaults(MOCK_AGENT_WITH_MULTI_SKILLS as any)

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Both skills should appear
    expect(screen.getByText('Docker Access')).toBeInTheDocument()
  })

  // T8: Skill instructions toggle
  it('skill instructions expand on click', async () => {
    mockFetchDefaults(MOCK_AGENT_WITH_SKILL as any)

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Instructions should NOT be visible initially
    expect(screen.queryByText(/Always write tests before implementation/)).not.toBeInTheDocument()

    // Click "Show Instructions"
    fireEvent.click(screen.getByText('Show Instructions'))

    // Instructions should now be visible
    await waitFor(() => {
      expect(screen.getByText(/Always write tests before implementation/)).toBeInTheDocument()
    })
  })

  // U5: Detail shows NO kind badge — shows tools instead
  it('shows no kind badge on skill cards, shows tools instead', async () => {
    mockFetchDefaults(MOCK_AGENT_WITH_SKILL as any)

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Should NOT show "Skill" or "Profile" kind badges
    const skillCard = screen.getByText('Developer').closest('[class*="rounded-md"]')!
    expect(skillCard.textContent).not.toMatch(/\bSkill\b/)
    expect(skillCard.textContent).not.toContain('Profile')

    // Should show tools as badges on the skill card
    expect(within(skillCard).getByText('gh')).toBeInTheDocument()
    expect(within(skillCard).getByText('git')).toBeInTheDocument()
  })

  // U6: Detail shows tools on skill cards
  it('shows tools as badges on skill cards', async () => {
    mockFetchDefaults(MOCK_AGENT_WITH_SKILL as any)

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('Developer')).toBeInTheDocument()
    })

    // Should show tool names as badges on the skill card
    const skillCard = screen.getByText('Developer').closest('[class*="rounded-md"]')!
    expect(within(skillCard).getByText('gh')).toBeInTheDocument()
    expect(within(skillCard).getByText('git')).toBeInTheDocument()
  })

  // T18: installing status renders blue badge
  it('installing status renders blue badge', async () => {
    const installingToolInstalls = [
      {
        tool_id: 'tool-gh',
        tool_name: 'gh',
        tool_description: 'GitHub CLI',
        status: 'installing',
        install_message: 'downloading...',
        installed_at: null,
        updated_at: '2026-03-01T00:00:00Z',
      },
    ]

    mockFetch.mockImplementation((url: string, opts?: any) => {
      if (url === `/api/agents/uuid-1` && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENT) })
      }
      if (url === '/api/skills') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_ALL_SKILLS) })
      }
      if (typeof url === 'string' && url.includes('/api/agents/uuid-1/tool-installs')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(installingToolInstalls) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // The installing badge should have blue styling
    await waitFor(() => {
      const badge = screen.getByText('installing')
      expect(badge).toBeInTheDocument()
      expect(badge.className).toContain('bg-blue-900/40')
      expect(badge.className).toContain('text-blue-400')
    })
  })

  // T19: Reconcile button visible for admin on running agent
  it('reconcile button visible for admin on running agent', async () => {
    const runningAgent = { ...MOCK_AGENT, status: 'running', container_id: 'abc-123' }
    mockFetchDefaults(runningAgent as any)

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    await waitFor(() => {
      expect(screen.getByText('Reconcile')).toBeInTheDocument()
    })
  })

  // T20: Reconcile button hidden for non-admin
  it('reconcile button hidden for non-admin', async () => {
    const runningAgent = { ...MOCK_AGENT, status: 'running', container_id: 'abc-123' }
    mockFetchDefaults(runningAgent as any)

    render(<AgentDetailClient agentId="uuid-1" session={USER_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    // Non-admin should NOT see Reconcile button even on running agent
    expect(screen.queryByText('Reconcile')).not.toBeInTheDocument()
  })

  // U1-U7: Knowledge tab tests moved to AgentMemory.test.tsx (T1-T6)
  // The following tests are replaced by AgentMemory.test.tsx which tests the extracted component directly.

  it.skip('Knowledge tab tests moved to AgentMemory.test.tsx', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Knowledge' }))

    await waitFor(() => {
      expect(screen.getByText('notes/research.md')).toBeInTheDocument()
    })
    expect(screen.getByText('docs/api.md')).toBeInTheDocument()
    expect(screen.getByText('Research Notes')).toBeInTheDocument()
    expect(screen.getByText('API Documentation')).toBeInTheDocument()
  })

  // U2: Knowledge search triggers API call
  it.skip('Knowledge search triggers API call', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Knowledge' }))

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search knowledge entries...')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByPlaceholderText('Search knowledge entries...'), { target: { value: 'test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => {
      const searchCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('/api/knowledge/search?q=test&agent_id=research-bot')
      )
      expect(searchCalls.length).toBeGreaterThan(0)
    })
  })

  // U3: Knowledge search results display
  it.skip('Knowledge search results display with path and headline', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Knowledge' }))

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search knowledge entries...')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByPlaceholderText('Search knowledge entries...'), { target: { value: 'test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => {
      expect(screen.getByText('1 results')).toBeInTheDocument()
    })
    expect(screen.getByText('notes/research.md')).toBeInTheDocument()
    expect(screen.getByText('score: 0.85')).toBeInTheDocument()
  })

  // U4: Knowledge entry click loads full content
  it.skip('Knowledge entry click loads full content', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Knowledge' }))

    await waitFor(() => {
      expect(screen.getByText('Research Notes')).toBeInTheDocument()
    })

    // Click the first entry
    fireEvent.click(screen.getByText('Research Notes'))

    // Should fetch entry detail
    await waitFor(() => {
      const detailCalls = mockFetch.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('/api/knowledge/entries/research-bot/notes/research.md')
      )
      expect(detailCalls.length).toBeGreaterThan(0)
    })

    // Should show full content
    await waitFor(() => {
      expect(screen.getByText(/# Research Notes/)).toBeInTheDocument()
      expect(screen.getByText(/Full content here/)).toBeInTheDocument()
    })
  })

  // U5: Knowledge back button returns to list
  it.skip('Knowledge back button returns to list', async () => {
    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Knowledge' }))

    await waitFor(() => {
      expect(screen.getByText('Research Notes')).toBeInTheDocument()
    })

    // Click entry to go to detail view
    fireEvent.click(screen.getByText('Research Notes'))

    await waitFor(() => {
      expect(screen.getByText('Back to list')).toBeInTheDocument()
    })

    // Click back
    fireEvent.click(screen.getByText('Back to list'))

    // Should be back to list view
    await waitFor(() => {
      expect(screen.getByText('Knowledge Entries')).toBeInTheDocument()
    })
    expect(screen.getByText('notes/research.md')).toBeInTheDocument()
  })

  // U6: Knowledge empty state
  it.skip('Knowledge empty state shows message', async () => {
    mockFetch.mockImplementation((url: string, opts?: any) => {
      if (url === `/api/agents/uuid-1` && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENT) })
      }
      if (url === '/api/skills') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_ALL_SKILLS) })
      }
      if (typeof url === 'string' && url.includes('/api/agents/uuid-1/tool-installs')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_TOOL_INSTALLS) })
      }
      if (typeof url === 'string' && url.includes('/api/knowledge/entries')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Knowledge' }))

    await waitFor(() => {
      expect(screen.getByText('No knowledge entries')).toBeInTheDocument()
    })
  })

  // U7: Knowledge search no results
  it.skip('Knowledge search no results shows message', async () => {
    mockFetch.mockImplementation((url: string, opts?: any) => {
      if (url === `/api/agents/uuid-1` && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENT) })
      }
      if (url === '/api/skills') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_ALL_SKILLS) })
      }
      if (typeof url === 'string' && url.includes('/api/agents/uuid-1/tool-installs')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_TOOL_INSTALLS) })
      }
      if (typeof url === 'string' && url.includes('/api/knowledge/search')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ query: 'nothing', results: [], count: 0, search_type: 'fts', score_type: 'ts_rank' }) })
      }
      if (typeof url === 'string' && url.includes('/api/knowledge/entries')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_KNOWLEDGE_ENTRIES) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Knowledge' }))

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search knowledge entries...')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByPlaceholderText('Search knowledge entries...'), { target: { value: 'nothing' } })
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))

    await waitFor(() => {
      expect(screen.getByText('No results found')).toBeInTheDocument()
    })
  })

  // app#410: a non-404 failure used to leave the page blank (`return null`)
  // — worse than an empty state, a blank one with zero explanation.
  describe('a failed agent fetch renders an error, not a blank page', () => {
    it('shows an error message on a 500', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === '/api/agents/uuid-1') {
          return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) })
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
      })

      const { container } = render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

      await waitFor(() => {
        expect(screen.getByTestId('agent-detail-error')).toBeInTheDocument()
      })
      expect(screen.getByText('Could not load this agent — try refreshing the page')).toBeInTheDocument()
      // Not blank: the error message is real content, not an empty body.
      expect(container.textContent).not.toBe('')
      expect(mockPush).not.toHaveBeenCalled()
    })

    it('still redirects on a genuine 404, unchanged', async () => {
      mockFetch.mockImplementation((url: string) => {
        if (url === '/api/agents/uuid-1') {
          return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'not found' }) })
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
      })

      render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

      await waitFor(() => {
        expect(mockPush).toHaveBeenCalledWith('/agents')
      })
      expect(screen.queryByTestId('agent-detail-error')).not.toBeInTheDocument()
    })
  })

  // app#499: the same raw-GUID rendering fixed in the knowledge graph, in
  // this table's own "Created ... by" line. Truncated sub for anyone else
  // was the old, wrong behavior — a resolved created_by_name must now
  // render in full.
  describe('the "Created ... by" line (app#499)', () => {
    it('shows the resolved creator name in full, not a truncated sub', async () => {
      mockFetchDefaults({
        ...MOCK_AGENT,
        created_by: 'kc-sub-95f7362e-8918-485f-aba2-0e7684270003',
        created_by_name: 'Dev Local',
      } as any)

      render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

      await waitFor(() => {
        expect(screen.getByText('ResearchBot')).toBeInTheDocument()
      })
      expect(screen.getByText(/Created .* by Dev Local/)).toBeInTheDocument()
      expect(screen.queryByText(/kc-sub-9/)).not.toBeInTheDocument()
    })

    it('falls back to the truncated sub when no name could ever be resolved for this row', async () => {
      mockFetchDefaults({
        ...MOCK_AGENT,
        created_by: 'kc-sub-95f7362e-8918-485f-aba2-0e7684270003',
        created_by_name: null,
      } as any)

      render(<AgentDetailClient agentId="uuid-1" session={ADMIN_SESSION as any} />)

      await waitFor(() => {
        expect(screen.getByText('ResearchBot')).toBeInTheDocument()
      })
      expect(screen.getByText(/Created .* by kc-sub-9…/)).toBeInTheDocument()
    })

    it("shows the viewer's OWN session name for their own agent, unaffected by created_by_name", async () => {
      // The self-viewing branch (session.user.sub === agent.created_by) reads
      // the VIEWER's own session name, not created_by_name off the agent
      // row — that branch is unrelated to this fix and must stay so.
      mockFetchDefaults({
        ...MOCK_AGENT,
        created_by: 'viewer-sub',
        created_by_name: 'Should Not Appear',
      } as any)
      const sessionAsCreator = {
        user: { name: 'Viewer', email: 'viewer@hill90.com', roles: ['admin'], sub: 'viewer-sub' },
        expires: '2026-12-31',
      }

      render(<AgentDetailClient agentId="uuid-1" session={sessionAsCreator as any} />)

      await waitFor(() => {
        expect(screen.getByText('ResearchBot')).toBeInTheDocument()
      })
      expect(screen.getByText(/Created .* by Viewer/)).toBeInTheDocument()
      expect(screen.queryByText(/Should Not Appear/)).not.toBeInTheDocument()
    })
  })
})
