import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import AgentMemory from '@/app/agents/[id]/AgentMemory'

const MOCK_ENTRIES = [
  { id: 'e1', agent_id: 'bot-1', path: 'notes/setup.md', title: 'Setup Notes', entry_type: 'note', tags: [], status: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
  { id: 'e2', agent_id: 'bot-1', path: 'plans/deploy.md', title: 'Deploy Plan', entry_type: 'plan', tags: [], status: 'active', created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
  { id: 'e3', agent_id: 'bot-1', path: 'journal/2026-01-03.md', title: 'Daily Journal', entry_type: 'journal', tags: [], status: 'active', created_at: '2026-01-03T00:00:00Z', updated_at: '2026-01-03T00:00:00Z' },
]

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('AgentMemory', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/knowledge/search')) {
        return { ok: true, json: async () => ({ results: [{ ...MOCK_ENTRIES[0], score: 0.95, headline: 'Setup **Notes** found' }] }) }
      }
      if (typeof url === 'string' && url.includes('/api/knowledge/entries?agent_id=')) {
        // The type filter is applied UPSTREAM now, so the double must honour
        // it — a double that ignores `type` would let a client-side filter
        // pass a test the real server-side one fails.
        const type = new URL(url, 'http://t').searchParams.get('type')
        const rows = type ? MOCK_ENTRIES.filter(e => e.entry_type === type) : MOCK_ENTRIES
        return {
          ok: true,
          json: async () => rows,
          headers: { get: (h: string) => (h.toLowerCase() === 'x-total-count' ? String(rows.length) : null) },
        }
      }
      if (typeof url === 'string' && url.includes('/api/knowledge/entries/')) {
        return { ok: true, json: async () => ({ content: 'Full entry content here' }) }
      }
      return { ok: false, json: async () => ({}) }
    })
  })

  afterEach(() => cleanup())

  it('T1: renders entry list', async () => {
    render(<AgentMemory agentId="bot-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('entry-list')).toBeInTheDocument()
    })

    const items = screen.getAllByTestId('entry-item')
    expect(items).toHaveLength(3)
    expect(screen.getByText('Setup Notes')).toBeInTheDocument()
    expect(screen.getByText('Deploy Plan')).toBeInTheDocument()
    expect(screen.getByText('Daily Journal')).toBeInTheDocument()
  })

  it('T2: filters entries by type, and asks the SERVER for the filtered set', async () => {
    render(<AgentMemory agentId="bot-1" />)

    await waitFor(() => {
      expect(screen.getAllByTestId('entry-item')).toHaveLength(3)
    })

    const filterBar = screen.getByTestId('type-filters')
    const noteButton = Array.from(filterBar.querySelectorAll('button')).find(b => b.textContent === 'note')
    expect(noteButton).toBeTruthy()
    fireEvent.click(noteButton!)

    await waitFor(() => {
      expect(screen.getAllByTestId('entry-item')).toHaveLength(1)
    })
    expect(screen.getByText('Setup Notes')).toBeInTheDocument()

    // The request carried type=note. Filtering the loaded page instead would
    // show 1 of the 3 fetched rows while thousands went unfetched.
    const urls = mockFetch.mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.includes('type=note'))).toBe(true)
  })

  it('T3: shows entry count summary', async () => {
    render(<AgentMemory agentId="bot-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('entry-count-summary')).toBeInTheDocument()
    })

    const summary = screen.getByTestId('entry-count-summary')
    // 3 shown out of 3 total: the page IS the set, so it reads as a plain
    // count and the per-type breakdown is trustworthy.
    expect(summary).toHaveTextContent('3 entries')
    expect(summary).toHaveTextContent('1 note')
    expect(summary).toHaveTextContent('1 plan')
    expect(summary).toHaveTextContent('1 journal')
  })

  it('T4: search shows results', async () => {
    render(<AgentMemory agentId="bot-1" />)

    await waitFor(() => {
      expect(screen.getByTestId('entry-list')).toBeInTheDocument()
    })

    const input = screen.getByPlaceholderText('Search memory entries...')
    fireEvent.change(input, { target: { value: 'setup' } })
    fireEvent.submit(input.closest('form')!)

    await waitFor(() => {
      expect(screen.getByTestId('search-result')).toBeInTheDocument()
    })

    expect(screen.getByText('1 results')).toBeInTheDocument()
  })

  it('T5: click entry loads content', async () => {
    render(<AgentMemory agentId="bot-1" />)

    await waitFor(() => {
      expect(screen.getAllByTestId('entry-item')).toHaveLength(3)
    })

    fireEvent.click(screen.getAllByTestId('entry-item')[0])

    await waitFor(() => {
      expect(screen.getByTestId('entry-content')).toBeInTheDocument()
    })

    expect(screen.getByText('Full entry content here')).toBeInTheDocument()
    expect(screen.getByTestId('back-to-list')).toBeInTheDocument()
  })

  it('T6: shows empty state', async () => {
    mockFetch.mockImplementation(async () => ({
      ok: true,
      json: async () => [],
    }))

    render(<AgentMemory agentId="bot-empty" />)

    await waitFor(() => {
      expect(screen.getByTestId('empty-state')).toBeInTheDocument()
    })

    expect(screen.getByText(/No memory entries/)).toBeInTheDocument()
  })
})
