/**
 * A search result count must report MATCHES, not the size of the page.
 *
 * THE DEFECT (from the #197 sweep). Both surfaces rendered
 * `searchResults.length`, and every layer beneath them caps the page at 20:
 * services/knowledge internal_admin.py had `LIMIT 20` with `count: len(...)`, and
 * services/api knowledge.ts sliced to 20 and reported `limited.length`. A search
 * over 500 matching entries rendered "20 results".
 *
 * WHY IT WAS INVISIBLE, and why the fixture below is the whole test: the figure
 * AGREED WITH ITSELF. Twenty rows on screen, the word twenty above them. There
 * was nothing to notice, and no fixture with fewer than 20 matches can tell the
 * broken version from the fixed one — they return the identical string.
 *
 * SO THE FIXTURE MUST HAVE MORE MATCHES THAN THE CAP. 20 rows returned, 137
 * matched. The broken version renders "20 results"; the fixed one renders
 * "Showing 20 of 137 results". Any fixture with fewer matches than the cap passes
 * on the broken code, which is exactly how this survived until it was swept for.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

vi.mock('next/link', () => ({
  default: ({ children, href, ...p }: any) => <a href={href} {...p}>{children}</a>,
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import AgentMemory from '@/app/agents/[id]/AgentMemory'

/** `returned` rows in the page, `matched` in the corpus — deliberately unequal. */
function searchResponse(returned: number, matched: number) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: () =>
      Promise.resolve({
        query: 'deploy',
        results: Array.from({ length: returned }, (_, i) => ({
          id: `e${i}`,
          agent_id: 'scout',
          path: `notes/${i}.md`,
          title: `Entry ${i}`,
          entry_type: 'note',
          headline: 'a **deploy** note',
          score: 1 - i / 100,
          tags: [],
        })),
        count: returned,
        total_matches: matched,
        truncated: matched > returned,
      }),
  }
}

describe('AgentMemory search count', () => {
  beforeEach(() => mockFetch.mockReset())
  afterEach(() => cleanup())

  function wire(returned: number, matched: number) {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('/api/knowledge/search')) {
        return Promise.resolve(searchResponse(returned, matched))
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve({ entries: [] }),
      })
    })
  }

  /** The search is a FORM SUBMIT, not a debounced change — typing alone fires nothing. */
  async function search(term = 'deploy') {
    const box = await screen.findByPlaceholderText(/search/i)
    fireEvent.change(box, { target: { value: term } })
    const form = box.closest('form')
    if (!form) throw new Error('search input is not inside a form')
    fireEvent.submit(form)
  }

  it('POSITIVE CONTROL: reports MATCHES when more matched than fit in the page', async () => {
    // 20 back, 137 matched. With fewer than 20 matches both versions agree.
    wire(20, 137)
    render(<AgentMemory agentId="scout" />)

    await search()

    await waitFor(() => expect(screen.getByText(/137/)).toBeInTheDocument())
    // The old figure, and the one a naive fix would still render.
    expect(screen.queryByText('20 results')).toBeNull()
  })

  it('says plainly that the list is cut, not just how many exist', async () => {
    wire(20, 137)
    render(<AgentMemory agentId="scout" />)

    await search()

    // "137 results" over a list of 20 rows would be its own kind of lie.
    await waitFor(() => expect(screen.getByText(/Showing 20 of 137/)).toBeInTheDocument())
  })

  it('reads naturally when nothing was cut', async () => {
    wire(3, 3)
    render(<AgentMemory agentId="scout" />)

    await search()

    await waitFor(() => expect(screen.getByText(/3 results/)).toBeInTheDocument())
    expect(screen.queryByText(/Showing/)).toBeNull()
  })

  it('falls back to the row count if an older api sends no total', async () => {
    // Undercounting is the safe direction: it can only understate, and it never
    // claims a total nobody computed.
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('/api/knowledge/search')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: () => Promise.resolve({ query: 'deploy', results: [{ id: 'e0', agent_id: 'scout', path: 'a.md', title: 'A', entry_type: 'note', headline: 'x', score: 1, tags: [] }] }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve({ entries: [] }) })
    })
    render(<AgentMemory agentId="scout" />)

    await search()

    await waitFor(() => expect(screen.getByText(/1 result/)).toBeInTheDocument())
  })
})
