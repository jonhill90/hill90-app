import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// #380: KnowledgeGraph reads the session (to resolve a `user` node's own
// sub to "You") and throws without a SessionProvider unless mocked. The
// "You"/fallback resolution itself is exercised directly against labelFor()
// below, not through this mock — a fixed value that matches nothing is
// enough to let the component mount for the other tests in this file.
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: { user: { sub: 'no-such-sub-matches-a-fixture' } }, status: 'authenticated' }),
}))

import SharedKnowledgeClient from '@/app/harness/shared-knowledge/SharedKnowledgeClient'
import { colorForType, baseRadiusForType, labelFor, legendTypes, type GraphNode } from '@/app/harness/shared-knowledge/KnowledgeGraph'

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

/**
 * #380: the knowledge service (#379) started emitting a `user` node type —
 * requester_type='user' from shared_retrievals, id `user-{sub}`, label the
 * RAW sub, meta.retrieval_count. This renderer had only ever seen collection/
 * source/agent. `user` fell through every lookup to the shared '#6b7280'
 * grey and the raw-UUID label — on the node that is structurally the hub
 * connecting all three collections into one component.
 *
 * Transcribed verbatim from Jon's report of the live response, not composed
 * from this component's own assumptions — the file's own docstring above
 * already explains why a fixture the test author writes cannot catch this
 * class: it would just re-encode whatever the component already believes.
 */
const LIVE_USER_NODE: GraphNode = {
  id: 'user-95f7362e-8918-485f-aba2-0e7684270003',
  type: 'user',
  label: '95f7362e-8918-485f-aba2-0e7684270003',
  meta: { retrieval_count: 11 },
}

const LIVE_WITH_USER = {
  ...LIVE,
  nodes: [...LIVE.nodes, LIVE_USER_NODE],
  edges: [
    ...LIVE.edges,
    {
      source: LIVE_USER_NODE.id,
      target: 'src-6b0e7f22-84f7-4dc7-82df-1c25745054b4',
      label: 'retrieved',
    },
  ],
}

describe('KnowledgeGraph — a producer-added node type (#380)', () => {
  beforeEach(() => mockFetch.mockReset())
  afterEach(() => cleanup())

  it('mounts and renders counts with a user node present, same as any other type', async () => {
    mockGraph(LIVE_WITH_USER)
    await openGraphTab()

    await waitFor(() => {
      expect(screen.getByTestId('graph-counts')).toBeInTheDocument()
    })
    expect(screen.getByTestId('knowledge-graph-canvas')).toBeInTheDocument()
    expect(screen.queryByText(/Failed to load graph/)).not.toBeInTheDocument()
  })

  // The mount-level test above cannot reach the actual bug: jsdom's
  // HTMLCanvasElement.getContext returns undefined (no `canvas` npm package
  // installed), so the component's `if (!ctx) return` guard exits before
  // colorForType/baseRadiusForType/labelFor/legendTypes are ever called —
  // a component test would pass here whether or not the fix is real. These
  // assert the actual decision functions directly, against the transcribed
  // fixture, which is the only way this class of defect is catchable in
  // this test environment.
  it('gives `user` its own colour, not the shared unknown-type grey', () => {
    const color = colorForType('user')
    expect(color).not.toBe('#6b7280')
    expect(color).toBe('#c026d3')
    expect(color).not.toBe(colorForType('collection'))
    expect(color).not.toBe(colorForType('source'))
    expect(color).not.toBe(colorForType('agent'))
  })

  it('gives `user` a base radius larger than `source` — it is a hub, not a leaf', () => {
    expect(baseRadiusForType('user')).toBeGreaterThan(baseRadiusForType('source'))
  })

  it('labels the current session user "You" instead of their raw sub', () => {
    expect(labelFor(LIVE_USER_NODE, LIVE_USER_NODE.label)).toBe('You')
  })

  it('labels a DIFFERENT user with a short fragment, never the full UUID, and never fabricates a name', () => {
    const label = labelFor(LIVE_USER_NODE, 'some-other-users-sub')
    expect(label).not.toBe(LIVE_USER_NODE.label)
    expect(label.length).toBeLessThan(LIVE_USER_NODE.label.length)
    expect(label).not.toBe('You')
  })

  it('leaves non-user node labels untouched', () => {
    expect(labelFor(LIVE.nodes[0] as GraphNode, 'anything')).toBe(LIVE.nodes[0].label)
  })

  // app#499: "we don't want that strange guid to represent users... we want
  // the names." The server now resolves a `user` node's `label` to the
  // requester's own Keycloak name at write time when it can (see
  // shared-knowledge.ts / knowledge_graph()) — this is the UI half: a
  // resolved name must render in full, not get truncated to a fragment the
  // way the raw-sub fallback above still correctly does.
  const NAMED_USER_NODE: GraphNode = {
    id: 'user-95f7362e-8918-485f-aba2-0e7684270003',
    type: 'user',
    label: 'Dev Local',
    meta: { retrieval_count: 4 },
  }

  it('renders a resolved display name in full — the whole point of app#499', () => {
    expect(labelFor(NAMED_USER_NODE, 'some-other-users-sub')).toBe('Dev Local')
  })

  it('still says "You" for a resolved-name node when it is the current session', () => {
    // "You" must win over the resolved name for your OWN node — comparing by
    // id (which always carries the sub) rather than label (which no longer
    // always does) is exactly the fix that keeps this working once label
    // stops being the sub.
    expect(labelFor(NAMED_USER_NODE, '95f7362e-8918-485f-aba2-0e7684270003')).toBe('You')
  })

  it('includes `user` in the legend once it is actually present in the data', () => {
    expect(legendTypes(LIVE_WITH_USER.nodes as GraphNode[])).toContain('user')
  })

  it('does not include `user` in the legend when no user node is present', () => {
    expect(legendTypes(LIVE.nodes as GraphNode[])).not.toContain('user')
  })

  it('CONTROL: a type this component has truly never seen still gets a real colour and a legend entry', () => {
    // Proves the fallback path itself, not just the now-known `user` case —
    // the whole point of #380 is that the NEXT unseen type must not repeat
    // this exact defect.
    const mysteryNode: GraphNode = { id: 'mystery-1', type: 'widget', label: 'A Widget' }
    expect(colorForType('widget')).not.toBe('#6b7280')
    expect(legendTypes([mysteryNode])).toContain('widget')
  })
})

// app#501: the private-memory graph's own node type — a SECOND producer
// (knowledge_store.py's entries_graph()) into the same renderer this file
// already proves agrees with docs/contracts/graph-node-types.json
// (KnowledgeGraphNodeTypes.test.tsx). `entry` gets its own explicit colour
// (not the hash fallback) the same way `user` did in #380 — the fallback is
// the safety net for the type NOBODY registered yet, not the intended
// treatment for one this PR knows about in advance.
describe('KnowledgeGraph — the private-memory graph\'s own node type (app#501)', () => {
  it('gives `entry` its own colour, distinct from every other known type', () => {
    const color = colorForType('entry')
    expect(color).not.toBe('#6b7280')
    expect(color).not.toBe(colorForType('collection'))
    expect(color).not.toBe(colorForType('source'))
    expect(color).not.toBe(colorForType('agent'))
    expect(color).not.toBe(colorForType('user'))
  })

  it('`agent` is the SAME id scheme and colour in both graphs — it is the same kind of thing, an agent identity, not two meanings sharing one type name', () => {
    // This is the one type BOTH producers emit. Nothing about app#501
    // should have touched its existing treatment.
    expect(colorForType('agent')).toBe('#f59e0b')
    expect(baseRadiusForType('agent')).toBe(11)
  })

  it('labelFor leaves an `entry` node\'s label untouched — no #499-style sub resolution applies here, it is just a title', () => {
    const entryNode: GraphNode = { id: 'entry-e1', type: 'entry', label: 'Onboarding Plan' }
    expect(labelFor(entryNode, 'anything')).toBe('Onboarding Plan')
  })

  it('includes `entry` in the legend once present, alongside `agent`', () => {
    const nodes: GraphNode[] = [
      { id: 'agent-scout', type: 'agent', label: 'scout' },
      { id: 'entry-e1', type: 'entry', label: 'Onboarding Plan' },
    ]
    expect(legendTypes(nodes)).toEqual(expect.arrayContaining(['agent', 'entry']))
  })
})
