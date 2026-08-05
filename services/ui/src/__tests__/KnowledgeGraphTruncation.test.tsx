import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import SharedKnowledgeClient from '@/app/harness/shared-knowledge/SharedKnowledgeClient'

/**
 * A partial graph must say it is partial (#215).
 *
 * `stats` is now the corpus measured with COUNT(*), while the drawing is a
 * bounded page. Those are different numbers on purpose, and without a notice a
 * user would see accurate totals over an incomplete picture and have no way to
 * tell which was which.
 *
 * Every fixture makes the two DISAGREE — 2 drawn, 40,000 in the corpus. One
 * where they match cannot detect the defect.
 *
 * WHAT THIS FILE CANNOT SEE, and did not, for the whole life of #303: these
 * fixtures say `stats`, because they were written from the component. The
 * knowledge service sends `total`. Every test here passed while the Graph tab
 * threw on `data.stats.collections` in production. The fixtures are kept as
 * they are — they are now the back-compat arm for a pre-#303 api — and the
 * live shape is covered in `KnowledgeGraphContract.test.tsx`, whose fixtures
 * are transcribed from a real response rather than composed here.
 */

const GRAPH = {
  nodes: [
    { id: 'col-c1', type: 'collection', label: 'A' },
    { id: 'src-s1', type: 'source', label: 'S1' },
  ],
  edges: [{ source: 'col-c1', target: 'src-s1', label: 'contains' }],
  stats: { collections: 40000, sources: 900, agents_with_knowledge: 7 },
  shown: { collections: 1, sources: 1, agents_with_knowledge: 0 },
  truncated: true,
}

function respond(url: string) {
  if (url.includes('/graph')) return { ok: true, json: async () => GRAPH }
  return { ok: true, json: async () => [] }
}

async function openGraphTab() {
  render(<SharedKnowledgeClient />)
  const tab = await screen.findByText('Graph', {}, { timeout: 3000 }).catch(() => null)
  if (tab) fireEvent.click(tab)
}

describe('KnowledgeGraph truncation notice', () => {
  beforeEach(() => {
    mockFetch.mockReset()
    mockFetch.mockImplementation(async (url: string) => respond(String(url)))
  })
  afterEach(() => cleanup())

  it('says how much of the corpus is drawn when the graph is truncated', async () => {
    await openGraphTab()

    await waitFor(() => {
      expect(screen.getByTestId('graph-truncated-notice')).toBeInTheDocument()
    })
    const notice = screen.getByTestId('graph-truncated-notice')
    expect(notice).toHaveTextContent('1 of 40000 collections')
    expect(notice).toHaveTextContent('1 of 900 sources')
  })

  it('shows no notice when the drawing IS the corpus', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/graph')) {
        return {
          ok: true,
          json: async () => ({
            ...GRAPH,
            stats: { collections: 1, sources: 1, agents_with_knowledge: 0 },
            shown: { collections: 1, sources: 1, agents_with_knowledge: 0 },
            truncated: false,
          }),
        }
      }
      return { ok: true, json: async () => [] }
    })

    await openGraphTab()
    await waitFor(() => expect(screen.queryByText(/Failed to load graph/)).not.toBeInTheDocument())
    expect(screen.queryByTestId('graph-truncated-notice')).not.toBeInTheDocument()
  })

  it('shows no notice when the api predates the field', async () => {
    // An older api sends neither `shown` nor `truncated`. Absence must read as
    // "nothing to say", never as a warning on a complete graph — the same
    // inference rule the entries work settled one hop at a time.
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('/graph')) {
        return {
          ok: true,
          json: async () => ({ nodes: GRAPH.nodes, edges: GRAPH.edges, stats: GRAPH.stats }),
        }
      }
      return { ok: true, json: async () => [] }
    })

    await openGraphTab()
    await waitFor(() => expect(screen.queryByText(/Failed to load graph/)).not.toBeInTheDocument())
    expect(screen.queryByTestId('graph-truncated-notice')).not.toBeInTheDocument()
  })
})
