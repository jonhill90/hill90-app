import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import SharedKnowledgeClient from '@/app/harness/shared-knowledge/SharedKnowledgeClient'

/**
 * The graph must render the shape the SERVICE actually sends.
 *
 * #215 built the graph in the api and called the corpus counts `stats`. #303
 * moved the query into the knowledge service — the service that owns the
 * tables — and that implementation named the same object `total`. The api
 * proxies it through untouched, so the UI has been reading `data.stats` off a
 * response that has no `stats` key since #303 merged. `data.stats.collections`
 * throws, and the Graph tab renders nothing.
 *
 * The endpoint answers 200 the whole time. That is the point: #300 traded a
 * visible 500 for an invisible client-side crash and reported success.
 *
 * The fixtures below are TRANSCRIBED from a live response, not written from
 * the component. `KnowledgeGraphTruncation.test.tsx` passed throughout because
 * its fixture supplied `stats` — the test author supplied the labels, so the
 * instrument could not see the fault it was built to catch.
 */

// Verbatim from `GET /internal/admin/shared/graph?limit=50` on the VPS,
// 2026-08-04, via app-api → app-knowledge:8002.
const LIVE = {
  nodes: [
    {
      id: 'col-a4c28013-8892-47f9-b466-9f691a1c4835',
      type: 'collection',
      label: 'DevOps',
      meta: { visibility: 'shared' },
    },
    {
      id: 'src-6b0e7f22-84f7-4dc7-82df-1c25745054b4',
      type: 'source',
      label: 'What is Azure DevOps?',
      meta: { source_type: 'web_page', chunk_count: 1 },
    },
  ],
  edges: [
    {
      source: 'col-a4c28013-8892-47f9-b466-9f691a1c4835',
      target: 'src-6b0e7f22-84f7-4dc7-82df-1c25745054b4',
      label: 'contains',
    },
  ],
  total: { collections: 1, sources: 1, agents_with_knowledge: 0 },
  shown: { collections: 1, sources: 1, agents_with_knowledge: 0 },
  dangling_edges: 0,
  truncated: false,
}

function mockGraph(body: unknown) {
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).includes('/graph')) return { ok: true, json: async () => body }
    return { ok: true, json: async () => [] }
  })
}

async function openGraphTab() {
  render(<SharedKnowledgeClient />)
  const tab = await screen.findByText('Graph', {}, { timeout: 3000 })
  fireEvent.click(tab)
}

describe('KnowledgeGraph — the live response contract', () => {
  beforeEach(() => mockFetch.mockReset())
  afterEach(() => cleanup())

  it('renders the corpus counts from the live response', async () => {
    mockGraph(LIVE)
    await openGraphTab()

    await waitFor(() => {
      expect(screen.getByTestId('graph-counts')).toBeInTheDocument()
    })
    const counts = screen.getByTestId('graph-counts')
    expect(counts).toHaveTextContent('1 collections')
    expect(counts).toHaveTextContent('1 sources')
    expect(counts).toHaveTextContent('0 agents')
    expect(screen.queryByText(/Failed to load graph/)).not.toBeInTheDocument()
  })

  it('says how much is drawn when the live shape is truncated', async () => {
    mockGraph({
      ...LIVE,
      total: { collections: 40000, sources: 900, agents_with_knowledge: 7 },
      truncated: true,
    })
    await openGraphTab()

    await waitFor(() => {
      expect(screen.getByTestId('graph-truncated-notice')).toBeInTheDocument()
    })
    const notice = screen.getByTestId('graph-truncated-notice')
    expect(notice).toHaveTextContent('1 of 40000 collections')
    expect(notice).toHaveTextContent('1 of 900 sources')
  })

  it('still renders when the counts object is missing entirely', async () => {
    // The defect this file exists for was a missing key taking out the whole
    // tab. Whatever the next rename is, the drawing must survive it — a graph
    // with no headline beats a blank page.
    mockGraph({ nodes: LIVE.nodes, edges: LIVE.edges })
    await openGraphTab()

    await waitFor(() => {
      expect(screen.getByTestId('graph-counts')).toBeInTheDocument()
    })
    expect(screen.queryByText(/Failed to load graph/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('graph-truncated-notice')).not.toBeInTheDocument()
  })

  // The force-directed rewrite (neural-map graph) skips creating a
  // d3-force simulation entirely when there are zero nodes — asserted here
  // because that path is exactly where a naive rewrite divides by zero
  // (empty-array averages, angle = i / length) or leaves a timer spinning
  // with nothing to settle. The estate's own corpus is three collections
  // and seven sources today, but a fresh install or a wiped knowledge base
  // starts here.
  it('renders with zero nodes — no crash, no division by zero, no spinning timer', async () => {
    mockGraph({
      nodes: [],
      edges: [],
      total: { collections: 0, sources: 0, agents_with_knowledge: 0 },
      shown: { collections: 0, sources: 0, agents_with_knowledge: 0 },
      truncated: false,
    })
    await openGraphTab()

    await waitFor(() => {
      expect(screen.getByTestId('graph-counts')).toBeInTheDocument()
    })
    const counts = screen.getByTestId('graph-counts')
    expect(counts).toHaveTextContent('0 collections')
    expect(counts).toHaveTextContent('0 sources')
    expect(counts).toHaveTextContent('0 agents')
    expect(screen.getByTestId('knowledge-graph-canvas')).toBeInTheDocument()
    expect(screen.queryByText(/Failed to load graph/)).not.toBeInTheDocument()
  })

  it('renders with exactly one node', async () => {
    mockGraph({
      nodes: [LIVE.nodes[0]],
      edges: [],
      total: { collections: 1, sources: 0, agents_with_knowledge: 0 },
      shown: { collections: 1, sources: 0, agents_with_knowledge: 0 },
      truncated: false,
    })
    await openGraphTab()

    await waitFor(() => {
      expect(screen.getByTestId('graph-counts')).toBeInTheDocument()
    })
    expect(screen.getByTestId('graph-counts')).toHaveTextContent('1 collections')
    expect(screen.getByTestId('knowledge-graph-canvas')).toBeInTheDocument()
    expect(screen.queryByText(/Failed to load graph/)).not.toBeInTheDocument()
  })
})
