import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// app#501: the Graph tab mounts KnowledgeGraph.tsx, which reads the session
// (to resolve a `user` node's own sub to "You" — irrelevant here, this
// graph has no `user` nodes at all, but the hook is called unconditionally)
// and throws without a SessionProvider unless mocked. Same fixed value
// KnowledgeGraphContract.test.tsx already uses for the same reason.
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { sub: 'no-such-sub-matches-a-fixture' } }, status: 'authenticated' }),
}))

import KnowledgeClient from '@/app/harness/knowledge/KnowledgeClient'

const MOCK_AGENTS = [
  { id: 'agent-uuid-1', name: 'ResearchBot', agent_id: 'research-bot' },
  { id: 'agent-uuid-2', name: 'WriterBot', agent_id: 'writer-bot' },
]

const MOCK_KNOWLEDGE_AGENTS = [
  { agent_id: 'agent-uuid-1', entry_count: 5, last_updated: '2026-02-28T12:00:00Z' },
  { agent_id: 'agent-uuid-2', entry_count: 3, last_updated: '2026-02-27T12:00:00Z' },
]

const MOCK_ENTRIES = [
  {
    id: 'entry-1',
    agent_id: 'agent-uuid-1',
    path: 'notes/setup.md',
    title: 'Setup Notes',
    entry_type: 'note',
    tags: ['setup'],
    status: 'active',
    created_at: '2026-02-25T00:00:00Z',
    updated_at: '2026-02-28T12:00:00Z',
  },
  {
    id: 'entry-2',
    agent_id: 'agent-uuid-1',
    path: 'plans/migration.md',
    title: 'Migration Plan',
    entry_type: 'plan',
    tags: ['migration', 'database'],
    status: 'active',
    created_at: '2026-02-26T00:00:00Z',
    updated_at: '2026-02-28T12:00:00Z',
  },
]

const MOCK_ENTRY_FULL = {
  ...MOCK_ENTRIES[0],
  content: '# Setup Notes\n\nThis is the content of the entry.',
}

const MOCK_SEARCH_RESULTS = {
  results: [
    {
      id: 'entry-1',
      agent_id: 'agent-uuid-1',
      path: 'notes/setup.md',
      title: 'Setup Notes',
      entry_type: 'note',
      tags: ['setup'],
      score: 0.95,
      headline: 'This is the <b>setup</b> guide',
      created_at: '2026-02-25T00:00:00Z',
      updated_at: '2026-02-28T12:00:00Z',
    },
  ],
  count: 1,
  search_type: 'text',
  score_type: 'ts_rank',
}

// app#501: a well-formed empty envelope, not `{}` — KnowledgeGraph.tsx does
// `data.nodes.map(...)` unconditionally once `data` is non-null, so an
// unmatched-URL fallback of `{}` would throw the moment any test actually
// opens the Graph tab. Overridable per-test via a second mockFetch call.
const MOCK_EMPTY_MEMORY_GRAPH = {
  nodes: [], edges: [],
  total: { agents: 0, entries: 0 }, shown: { agents: 0, entries: 0 },
  dangling_edges: 0, truncated: false,
}

function mockFetchDefaults() {
  mockFetch.mockImplementation((url: string) => {
    if (url === '/api/knowledge/agents') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_KNOWLEDGE_AGENTS) })
    }
    if (url === '/api/agents') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
    }
    if (typeof url === 'string' && url.startsWith('/api/knowledge/entries?')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_ENTRIES) })
    }
    if (typeof url === 'string' && url.startsWith('/api/knowledge/entries/')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_ENTRY_FULL) })
    }
    if (typeof url === 'string' && url.startsWith('/api/knowledge/search')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_SEARCH_RESULTS) })
    }
    if (url === '/api/knowledge/graph') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_EMPTY_MEMORY_GRAPH) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  })
}

describe('KnowledgeClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchDefaults()
  })

  afterEach(() => {
    cleanup()
  })

  it('renders agent list with names and entry counts', async () => {
    render(<KnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
      expect(screen.getByText('WriterBot')).toBeInTheDocument()
    })

    // Entry count badges show agent entry counts
    expect(screen.getAllByText(/5/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/3/).length).toBeGreaterThanOrEqual(1)
  })

  it('shows placeholder when no agent selected', async () => {
    render(<KnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('Select an agent to browse knowledge')).toBeInTheDocument()
    })
  })

  it('fetches entries when agent is selected', async () => {
    render(<KnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('ResearchBot'))

    await waitFor(() => {
      expect(screen.getByText('Setup Notes')).toBeInTheDocument()
      expect(screen.getByText('Migration Plan')).toBeInTheDocument()
    })

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/knowledge/entries?agent_id=agent-uuid-1')
    )
  })

  it('shows type filter badges', async () => {
    render(<KnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('ResearchBot'))

    await waitFor(() => {
      expect(screen.getByText('Setup Notes')).toBeInTheDocument()
    })

    // Type filter buttons (include counts now, e.g. "All (2)", "note (1)")
    const buttons = screen.getAllByRole('button')
    const buttonTexts = buttons.map(b => b.textContent || '')
    expect(buttonTexts.some(t => t.startsWith('All'))).toBe(true)
    expect(buttonTexts.some(t => t.startsWith('note'))).toBe(true)
    expect(buttonTexts.some(t => t.startsWith('plan'))).toBe(true)
    expect(buttonTexts.some(t => t.startsWith('decision'))).toBe(true)
    expect(buttonTexts.some(t => t.startsWith('journal'))).toBe(true)
    expect(buttonTexts.some(t => t.startsWith('research'))).toBe(true)
  })

  it('fetches and displays entry content on click', async () => {
    render(<KnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('ResearchBot'))

    await waitFor(() => {
      expect(screen.getByText('Setup Notes')).toBeInTheDocument()
    })

    // Click the entry row in the table
    fireEvent.click(screen.getByText('Setup Notes'))

    await waitFor(() => {
      // Content is rendered in a <pre> tag
      const preElement = document.querySelector('pre')
      expect(preElement).not.toBeNull()
      expect(preElement!.textContent).toContain('# Setup Notes')
      expect(preElement!.textContent).toContain('This is the content of the entry.')
    })

    // Verify the fetch was called with the correct path
    expect(mockFetch).toHaveBeenCalledWith('/api/knowledge/entries/agent-uuid-1/notes/setup.md')
  })

  it('performs search and shows results', async () => {
    render(<KnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    const searchInput = screen.getByPlaceholderText('Search across all knowledge entries...')
    fireEvent.change(searchInput, { target: { value: 'setup' } })

    // Click the Search button
    const searchButton = screen.getAllByRole('button').find(b => b.textContent === 'Search')!
    fireEvent.click(searchButton)

    await waitFor(() => {
      expect(screen.getByText(/1 result/)).toBeInTheDocument()
    })

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/knowledge/search?q=setup')
    )
  })

  it('clears search and returns to browse view', async () => {
    render(<KnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    const searchInput = screen.getByPlaceholderText('Search across all knowledge entries...')
    fireEvent.change(searchInput, { target: { value: 'setup' } })

    const searchButton = screen.getAllByRole('button').find(b => b.textContent === 'Search')!
    fireEvent.click(searchButton)

    await waitFor(() => {
      expect(screen.getByText(/1 result/)).toBeInTheDocument()
    })

    const clearButton = screen.getAllByRole('button').find(b => b.textContent === 'Clear')!
    fireEvent.click(clearButton)

    // Should return to agent browse view
    await waitFor(() => {
      expect(screen.getByText('Select an agent to browse knowledge')).toBeInTheDocument()
    })
  })

  it('shows empty state when no knowledge agents', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/knowledge/agents') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      }
      if (url === '/api/agents') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<KnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('No agents with knowledge entries yet')).toBeInTheDocument()
    })
  })

  // app#410: fetchKnowledgePage throws on a failed fetch now, instead of
  // returning the same shape as a genuinely-empty page.
  it('shows an error, not "No entries found", when the entries fetch fails', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/knowledge/agents') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_KNOWLEDGE_AGENTS) })
      }
      if (url === '/api/agents') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
      }
      if (typeof url === 'string' && url.startsWith('/api/knowledge/entries?')) {
        return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<KnowledgeClient />)

    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('ResearchBot'))

    await waitFor(() => {
      expect(screen.getByTestId('entries-error')).toBeInTheDocument()
    })
    expect(screen.getByText('Could not load entries — try refreshing the page')).toBeInTheDocument()
    expect(screen.queryByText('No entries found')).not.toBeInTheDocument()
  })
})

// app#501: "I want a knowledge graph for the memories for the agent. The
// non-shared ones, but I can view." Reuses KnowledgeGraph.tsx wholesale —
// these tests are about THIS harness wiring it to /api/knowledge/graph with
// its own corpus-summary text, not re-proving the renderer itself (that's
// KnowledgeGraphContract.test.tsx's job).
describe('KnowledgeClient — private-memory graph tab (app#501)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchDefaults()
  })

  afterEach(() => {
    cleanup()
  })

  it('defaults to the Browse tab — the agent list is visible with no click', async () => {
    render(<KnowledgeClient />)
    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })
  })

  it('switching to the Graph tab fetches /api/knowledge/graph and mounts the canvas', async () => {
    render(<KnowledgeClient />)
    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByText('Graph'))

    await waitFor(() => {
      expect(screen.getByTestId('knowledge-graph-canvas')).toBeInTheDocument()
    })
    expect(mockFetch).toHaveBeenCalledWith('/api/knowledge/graph')
  })

  it('the private-memory graph header says "agents"/"entries", never "collections"/"sources" — the shared graph\'s own words, wrong for this corpus', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/knowledge/agents') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_KNOWLEDGE_AGENTS) })
      if (url === '/api/agents') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
      if (url === '/api/knowledge/graph') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            nodes: [], edges: [],
            total: { agents: 3, entries: 12 }, shown: { agents: 3, entries: 12 },
            dangling_edges: 0, truncated: false,
          }),
        })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<KnowledgeClient />)
    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('Graph'))

    await waitFor(() => {
      expect(screen.getByTestId('graph-counts')).toBeInTheDocument()
    })
    const counts = screen.getByTestId('graph-counts')
    expect(counts).toHaveTextContent('3 agents')
    expect(counts).toHaveTextContent('12 entries')
    expect(counts).not.toHaveTextContent('collections')
    expect(counts).not.toHaveTextContent('sources')
  })

  it('the truncation notice, when present, also uses "agents"/"entries"', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === '/api/knowledge/agents') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_KNOWLEDGE_AGENTS) })
      if (url === '/api/agents') return Promise.resolve({ ok: true, json: () => Promise.resolve(MOCK_AGENTS) })
      if (url === '/api/knowledge/graph') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            nodes: [], edges: [],
            total: { agents: 5, entries: 50 }, shown: { agents: 2, entries: 20 },
            dangling_edges: 0, truncated: true,
          }),
        })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    })

    render(<KnowledgeClient />)
    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('Graph'))

    await waitFor(() => {
      expect(screen.getByTestId('graph-truncated-notice')).toBeInTheDocument()
    })
    const notice = screen.getByTestId('graph-truncated-notice')
    expect(notice).toHaveTextContent('2 of 5 agents')
    expect(notice).toHaveTextContent('20 of 50 entries')
  })

  it('switching back to Browse after Graph still shows the agent list, not a blank page', async () => {
    render(<KnowledgeClient />)
    await waitFor(() => {
      expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('Graph'))
    await waitFor(() => {
      expect(screen.getByTestId('knowledge-graph-canvas')).toBeInTheDocument()
    })
    fireEvent.click(screen.getByText('Browse'))
    expect(screen.getByText('ResearchBot')).toBeInTheDocument()
    expect(screen.queryByTestId('knowledge-graph-canvas')).not.toBeInTheDocument()
  })
})
