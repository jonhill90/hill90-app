import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

import AgentMemory from '@/app/agents/[id]/AgentMemory'
import AgentNotebook from '@/app/agents/[id]/AgentNotebook'
import { describePage, parseTotal } from '@/utils/knowledge-page'

/**
 * Truncation must be VISIBLE. This is the last hop where it was still silent.
 *
 * knowledge bounds the query (#182, #186), the api reads and forwards the
 * total (#190) — and until now the UI still rendered a short list with nothing
 * saying it was short. A list of 2 that looks like the whole set is the exact
 * failure this chain exists to remove.
 *
 * Every fixture here makes the page length and the real total DISAGREE: 2 rows
 * with `X-Total-Count: 40000`. A fixture where they match is passed by an
 * implementation that renders `entries.length` as the total, which is the
 * defect, so it would prove nothing.
 */

function row(i: number) {
  return {
    id: `e${i}`,
    agent_id: 'bot-1',
    path: `notes/${i}.md`,
    title: `Entry ${i}`,
    entry_type: 'notebook',
    tags: [],
    status: 'active',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: `2026-01-0${i + 1}T00:00:00Z`,
  }
}

const PAGE_1 = [row(0), row(1)]
const PAGE_2 = [row(2)]
const TOTAL = 40000

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function respond(rows: unknown[], total: number | null) {
  return {
    ok: true,
    json: async () => rows,
    headers: { get: (h: string) => (h.toLowerCase() === 'x-total-count' && total !== null ? String(total) : null) },
  }
}

describe('describePage — the sentence itself', () => {
  it('says "showing N of M" when the page is smaller than the set', () => {
    expect(describePage(500, 40000)).toBe('showing 500 of 40,000')
  })

  it('does NOT claim completeness when the total is unknown', () => {
    // The dangerous fallback would be `${shown} entries`, which reads as the
    // whole set. An unknown total must read as unknown.
    expect(describePage(500, null)).toBe('500 shown')
    expect(describePage(500, null)).not.toContain('of')
  })

  it('reads as a plain count only when the page IS the set', () => {
    expect(describePage(3, 3)).toBe('3 entries')
    expect(describePage(1, 1)).toBe('1 entry')
  })
})

describe('parseTotal — a bad header must not become NaN on screen', () => {
  it.each([
    ['40000', 40000],
    ['0', 0],
    [null, null],
    ['', null],
    ['not-a-number', null],
    ['-1', null],
    ['1.5', null],
  ])('parseTotal(%s) === %s', (header, expected) => {
    expect(parseTotal(header as string | null)).toBe(expected)
  })
})

describe('AgentMemory renders the truncation rather than hiding it', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/knowledge/entries?agent_id=')) {
        const offset = Number(new URL(url, 'http://t').searchParams.get('offset') || 0)
        return respond(offset === 0 ? PAGE_1 : PAGE_2, TOTAL)
      }
      return { ok: false, json: async () => ({}) }
    })
  })
  afterEach(() => cleanup())

  it('shows the real total, which DIFFERS from the number of rows rendered', async () => {
    render(<AgentMemory agentId="bot-1" />)

    await waitFor(() => expect(screen.getByTestId('entry-list')).toBeInTheDocument())

    expect(screen.getAllByTestId('entry-item')).toHaveLength(2)   // the page
    const summary = screen.getByTestId('entry-count-summary')
    expect(summary).toHaveTextContent('showing 2 of 40,000')      // the set
  })

  it('suppresses the per-type breakdown, which cannot be right from one page', async () => {
    render(<AgentMemory agentId="bot-1" />)
    await waitFor(() => expect(screen.getByTestId('entry-count-summary')).toBeInTheDocument())

    // "2 notebook" out of 40,000 is a small number that looks like an answer.
    expect(screen.getByTestId('entry-count-summary')).not.toHaveTextContent('notebook)')
  })

  it('offers more, and asks for the next page by offset', async () => {
    render(<AgentMemory agentId="bot-1" />)
    await waitFor(() => expect(screen.getByTestId('load-more')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('load-more'))

    await waitFor(() => expect(screen.getAllByTestId('entry-item')).toHaveLength(3))
    const urls = mockFetch.mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.includes('offset=2'))).toBe(true)
  })

  it('requests a bounded page in the first place', async () => {
    render(<AgentMemory agentId="bot-1" />)
    await waitFor(() => expect(screen.getByTestId('entry-list')).toBeInTheDocument())

    expect(String(mockFetch.mock.calls[0][0])).toMatch(/limit=\d+/)
  })
})

describe('AgentMemory when no hop reports a total', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation(async (url: string) =>
      url.includes('/api/knowledge/entries?agent_id=')
        ? respond(PAGE_1, null)
        : { ok: false, json: async () => ({}) },
    )
  })
  afterEach(() => cleanup())

  it('says how many are shown without implying that is all of them', async () => {
    render(<AgentMemory agentId="bot-1" />)
    await waitFor(() => expect(screen.getByTestId('entry-count-summary')).toBeInTheDocument())

    const summary = screen.getByTestId('entry-count-summary')
    expect(summary).toHaveTextContent('2 shown')
    // An older api or ui proxy in the chain must not be reported as "2 entries".
    expect(summary).not.toHaveTextContent('2 entries')
  })

  it('offers no Load more, because it cannot know there is more', async () => {
    render(<AgentMemory agentId="bot-1" />)
    await waitFor(() => expect(screen.getByTestId('entry-list')).toBeInTheDocument())

    expect(screen.queryByTestId('load-more')).not.toBeInTheDocument()
  })
})

describe('AgentNotebook — the same bound, from the shared helper', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/knowledge/entries?agent_id=')) {
        const offset = Number(new URL(url, 'http://t').searchParams.get('offset') || 0)
        return respond(offset === 0 ? PAGE_1 : PAGE_2, TOTAL)
      }
      return { ok: false, json: async () => ({}) }
    })
  })
  afterEach(() => cleanup())

  it('shows the total rather than the page length', async () => {
    render(<AgentNotebook agentId="bot-1" />)
    await waitFor(() => expect(screen.getByTestId('entry-list')).toBeInTheDocument())

    expect(screen.getAllByTestId('entry-item')).toHaveLength(2)
    expect(screen.getByTestId('entry-count')).toHaveTextContent('showing 2 of 40,000')
  })

  it('keeps the accumulated list sorted across pages, not each page alone', async () => {
    render(<AgentNotebook agentId="bot-1" />)
    await waitFor(() => expect(screen.getByTestId('load-more')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('load-more'))
    await waitFor(() => expect(screen.getAllByTestId('entry-item')).toHaveLength(3))

    // Page 2 holds the NEWEST row, so a sort applied per-page would leave it
    // last. Newest-first means it must be first.
    const titles = screen.getAllByTestId('entry-item').map(el => el.textContent || '')
    expect(titles[0]).toContain('Entry 2')
  })
})
