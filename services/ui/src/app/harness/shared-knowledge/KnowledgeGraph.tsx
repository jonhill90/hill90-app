'use client'

import { useEffect, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { GitBranch } from 'lucide-react'
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force'

// ── Knowledge Graph — force-directed "neural map" rendering ──────────
//
// DEPENDENCY DECISION, checked rather than assumed: d3-force pulled in via
// exactly the imports used here (forceSimulation, forceManyBody, forceLink,
// forceCollide, forceX, forceY), bundled and minified with esbuild, comes to
// 13.6kb minified / 5.5kb gzipped — d3-force's package.json exports a plain
// ESM `src/index.js`, so a bundler tree-shakes unused force types (forceRadial,
// forceCenter, etc.) rather than pulling in the whole library. That is a small
// enough cost for quadtree-based O(n log n) repulsion that is already tested
// against edge cases a hand-rolled velocity-Verlet sim would have to
// rediscover (numerical stability at zero/one node, overlapping start
// positions, link distance vs. charge equilibrium). Hand-rolling stays
// tempting only up to a few dozen nodes; this estate's corpus is already
// past "a few dozen" once sources are counted, so the quadtree matters now,
// not hypothetically.

export interface GraphNode extends SimulationNodeDatum {
  id: string
  type: string
  label: string
  meta?: Record<string, unknown>
}

interface GraphEdge {
  source: string
  target: string
  label?: string
}

// d3-force mutates link.source/target from string ids into node object
// references once the simulation initializes — this is the post-init shape.
type SimLink = SimulationLinkDatum<GraphNode> & { label?: string }

// The corpus counts, whatever the upstream calls them.
//
// #215 built the graph in the api and named this object `stats`. #303 moved
// the query into the knowledge service — the service that owns the tables —
// and named it `total`. The api proxies the body through untouched, so from
// #303 onward the UI was reading `data.stats` off a response that has no
// `stats` key: `data.stats.collections` threw and the Graph tab rendered
// nothing, while the endpoint answered 200 throughout.
//
// `total` is the live name and is read first. `stats` stays as a fallback so
// the component does not care which side of #303 the api is on, and the empty
// object means the NEXT rename costs a missing headline, not a blank page.
function corpusCounts(d: { total?: Record<string, number>; stats?: Record<string, number> }) {
  return d.total ?? d.stats ?? {}
}

// #380: `user` added here 2026-08-05 (the knowledge service's requester
// -> source edges, #379). Explicit colours/radii stay for the types we
// actually design around; anything the producer adds after this falls
// through to colorForType/baseRadiusForType's deterministic fallback below
// instead of a shared grey dot, and the legend (legendTypes, further down)
// derives from what the response actually contains rather than this map —
// the map alone is not what decides whether a type is visible.
//
// Both exported maps are checked, key-for-key, against
// docs/contracts/graph-node-types.json in KnowledgeGraphNodeTypes.test.tsx —
// the shared manifest services/knowledge's producer side (#381) also
// asserts against. Add a type to BOTH maps in the same PR that adds it to
// the manifest; that test is what stops this file quietly falling behind
// again.
export const TYPE_COLORS: Record<string, string> = {
  collection: '#5b9a2f',
  source: '#3b82f6',
  agent: '#f59e0b',
  // A hub colour distinct from the other three — magenta reads as "different
  // kind of thing" against the green/blue/amber palette, which matters here
  // since a user node is structurally the thing holding disconnected
  // collections together, not a peer of source/agent.
  user: '#c026d3',
}
export const TYPE_BASE_RADIUS: Record<string, number> = {
  collection: 16,
  source: 7,
  agent: 11,
  // Bigger than a source at rest — retrieval_count (see radiusOf) does the
  // rest of the hub-prominence work per-node, on top of this floor.
  user: 12,
}
// Types are producer-defined and this file cannot know about the next one
// in advance (that is the whole lesson of this file's own history — #354,
// then #380). A hash-derived HSL hue is deterministic per type string, so
// the same unknown type always gets the same colour across renders instead
// of the shared '#6b7280' every previously-unseen type collapsed into.
function hashType(type: string): number {
  let hash = 0
  for (let i = 0; i < type.length; i++) hash = (hash * 31 + type.charCodeAt(i)) >>> 0
  return hash
}
export function colorForType(type: string): string {
  const known = TYPE_COLORS[type]
  if (known) return known
  return `hsl(${hashType(type) % 360}, 65%, 55%)`
}
export function baseRadiusForType(type: string): number {
  return TYPE_BASE_RADIUS[type] ?? 8
}
// Preferred legend order for the types this component was actually
// designed around; anything else present in the data is appended after,
// alphabetically, rather than being silently omitted.
const KNOWN_TYPE_ORDER = ['collection', 'source', 'agent', 'user']
export function legendTypes(nodes: GraphNode[]): string[] {
  const present = new Set(nodes.map(n => n.type))
  const known = KNOWN_TYPE_ORDER.filter(t => present.has(t))
  const unknown = [...present].filter(t => !KNOWN_TYPE_ORDER.includes(t)).sort()
  return [...known, ...unknown]
}

// A `user` node's label is a raw Keycloak sub (#379: `"label": requester_id`,
// unmodified). Rendering that verbatim is a UUID nobody reads. The knowledge
// service has no access to Keycloak's user table and deliberately shouldn't
// gain one for a label — so only the CURRENT session's own sub can ever be
// resolved to something human ("You"); every other user node gets a short,
// honestly-still-a-fragment prefix rather than a fabricated name.
export function labelFor(n: GraphNode, currentUserSub: string | undefined): string {
  if (n.type === 'user') {
    if (currentUserSub && n.label === currentUserSub) return 'You'
    return n.label.length > 8 ? `${n.label.slice(0, 8)}…` : n.label
  }
  return n.label
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

interface GraphData {
  nodes: GraphNode[]
  edges: GraphEdge[]
  total?: Record<string, number>
  stats?: Record<string, number>
  shown?: Record<string, number>
  truncated?: boolean
}

export default function KnowledgeGraph() {
  const [data, setData] = useState<GraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { data: session } = useSession()
  // Read via ref inside the draw loop below, not the `session` value
  // directly — the physics effect keys off `[data]` only, and re-running the
  // whole simulation setup because the session object identity changed
  // (routine with next-auth) would restart the layout for no visual reason.
  const currentUserSubRef = useRef<string | undefined>(undefined)
  useEffect(() => { currentUserSubRef.current = session?.user?.sub }, [session])

  useEffect(() => {
    fetch('/api/shared-knowledge/graph')
      .then(r => r.ok ? r.json() : null)
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!data || !canvasRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Nodes/edges are cloned so d3-force's in-place mutation (x, y, vx, vy,
    // and rewriting link.source/target from ids to node references) never
    // touches the fetched `data` this component's React state holds.
    const nodes: GraphNode[] = data.nodes.map(n => ({ ...n }))
    const nodeById = new Map(nodes.map(n => [n.id, n]))
    const links: SimLink[] = data.edges
      .filter(e => nodeById.has(e.source) && nodeById.has(e.target))
      .map(e => ({ source: e.source, target: e.target, label: e.label }))

    // Degree (for radius scaling) and adjacency (for hover highlighting),
    // computed once up front rather than per frame.
    const degree = new Map<string, number>()
    const neighbors = new Map<string, Set<string>>()
    for (const n of nodes) { degree.set(n.id, 0); neighbors.set(n.id, new Set()) }
    for (const e of links) {
      degree.set(e.source as string, (degree.get(e.source as string) || 0) + 1)
      degree.set(e.target as string, (degree.get(e.target as string) || 0) + 1)
      neighbors.get(e.source as string)?.add(e.target as string)
      neighbors.get(e.target as string)?.add(e.source as string)
    }

    function radiusOf(n: GraphNode): number {
      const base = baseRadiusForType(n.type)
      const d = degree.get(n.id) || 0
      // retrieval_count (#379/#380) is a second, independent size input —
      // a hub like a `user` node can carry high retrieval activity with a
      // modest degree, and degree alone would under-represent it.
      const retrievals = typeof n.meta?.retrieval_count === 'number' ? n.meta.retrieval_count : 0
      const bonus = Math.sqrt(d) * 2.2 + Math.sqrt(retrievals) * 1.1
      return base + Math.min(bonus, 18)
    }

    const dpr = window.devicePixelRatio || 1
    let w = canvas.clientWidth
    let h = canvas.clientHeight

    function resizeCanvas() {
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
    }
    resizeCanvas()

    // World space is centered on the origin (0, 0) — the view transform
    // below maps world (0, 0) to screen center, so seeding/targeting nodes
    // at (w/2, h/2) here would double-apply that offset and push everything
    // toward the bottom-right corner. Seed in a small circle around center —
    // d3-force handles overlapping/identical starting points fine (its
    // default jitters ties deterministically), but a spread start converges
    // faster and looks less like an explosion on the first few ticks.
    nodes.forEach((n, i) => {
      const a = (i / Math.max(nodes.length, 1)) * Math.PI * 2
      n.x = Math.cos(a) * 40
      n.y = Math.sin(a) * 40
    })

    // ── Pan/zoom state — refs, not React state: updated on every wheel/
    // pointer event, and re-rendering React for that would be its own
    // performance problem separate from the canvas redraw itself. `tx`/`ty`
    // is the screen point world-origin (0, 0) currently maps to — starts at
    // canvas center.
    const view = { scale: 1, tx: w / 2, ty: h / 2 }
    const MIN_SCALE = 0.15
    const MAX_SCALE = 4

    function screenToWorld(sx: number, sy: number) {
      return { x: (sx - view.tx) / view.scale, y: (sy - view.ty) / view.scale }
    }

    let hoveredId: string | null = null
    let draggingNode: GraphNode | null = null
    let isPanning = false
    let panStart = { x: 0, y: 0 }
    let viewStart = { tx: 0, ty: 0 }

    function nodeAt(worldX: number, worldY: number): GraphNode | null {
      // Reverse order so a node drawn on top (later in the array) wins a hit.
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]
        if (n.x == null || n.y == null) continue
        const r = radiusOf(n) + 3
        const dx = worldX - n.x
        const dy = worldY - n.y
        if (dx * dx + dy * dy <= r * r) return n
      }
      return null
    }

    function draw() {
      if (!ctx) return
      ctx.save()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#0f1923'
      ctx.fillRect(0, 0, w, h)

      ctx.translate(view.tx, view.ty)
      ctx.scale(view.scale, view.scale)

      const activeNeighbors = hoveredId ? neighbors.get(hoveredId) ?? new Set<string>() : null

      // Edges — faded by length, dimmed further when a hover focuses attention
      // elsewhere.
      for (const link of links) {
        const s = link.source as GraphNode
        const t = link.target as GraphNode
        if (s.x == null || s.y == null || t.x == null || t.y == null) continue
        const dx = t.x - s.x
        const dy = t.y - s.y
        const len = Math.sqrt(dx * dx + dy * dy)
        const isFocused = hoveredId != null && (s.id === hoveredId || t.id === hoveredId)
        const base = Math.max(0.08, Math.min(0.5, 140 / (len + 60)))
        const alpha = hoveredId == null ? base : (isFocused ? Math.min(base + 0.35, 0.85) : base * 0.15)
        ctx.strokeStyle = `rgba(94, 130, 160, ${alpha})`
        ctx.lineWidth = isFocused ? 1.6 : 1
        ctx.beginPath()
        ctx.moveTo(s.x, s.y)
        ctx.lineTo(t.x, t.y)
        ctx.stroke()
      }

      // Nodes — glow via shadowBlur, radius by degree, colour by type; hover
      // highlights the node and its direct neighbours and dims the rest.
      for (const n of nodes) {
        if (n.x == null || n.y == null) continue
        const r = radiusOf(n)
        const color = colorForType(n.type)
        const isHovered = n.id === hoveredId
        const isNeighbor = activeNeighbors?.has(n.id) ?? false
        const dimmed = hoveredId != null && !isHovered && !isNeighbor

        ctx.save()
        if (!dimmed) {
          ctx.shadowColor = color
          ctx.shadowBlur = isHovered ? 22 : 10
        }
        ctx.globalAlpha = dimmed ? 0.22 : 1
        ctx.fillStyle = color + '33'
        ctx.strokeStyle = color
        ctx.lineWidth = isHovered ? 2.5 : 1.5
        ctx.beginPath()
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        ctx.restore()

        // Labels: always for hovered/neighbors, otherwise only for the
        // "always visible" tiers — collections, and `user` nodes (#380: a
        // user is structurally a hub, the same reason it gets a bigger base
        // radius above; sources stay hover-only, or the resting state is
        // unreadable noise).
        const showLabel = isHovered || isNeighbor || n.type === 'collection' || n.type === 'user'
        if (showLabel) {
          ctx.globalAlpha = dimmed ? 0.3 : 1
          ctx.shadowBlur = 0
          ctx.fillStyle = isHovered ? '#ffffff' : '#c9d1d9'
          ctx.font = `${isHovered ? 'bold ' : ''}${n.type === 'collection' ? 11 : 10}px system-ui, sans-serif`
          ctx.textAlign = 'center'
          const resolved = labelFor(n, currentUserSubRef.current)
          const label = resolved.length > 22 ? `${resolved.slice(0, 20)}…` : resolved
          ctx.fillText(label, n.x, n.y + r + 13)
          ctx.globalAlpha = 1
        }
      }

      ctx.restore()

      // Legend — fixed to the viewport, not the world transform. Derived
      // from the types actually present in this response (#380), not a
      // fixed list: the producer adding a type this component has never
      // seen must not make that type invisible in the legend the way it
      // was invisible on the node itself before this fix.
      ctx.font = '11px system-ui'
      ctx.textAlign = 'left'
      let ly = 20
      for (const type of legendTypes(nodes)) {
        ctx.fillStyle = colorForType(type)
        ctx.beginPath()
        ctx.arc(20, ly, 5, 0, Math.PI * 2)
        ctx.fill()
        ctx.fillStyle = '#c9d1d9'
        ctx.fillText(type.charAt(0).toUpperCase() + type.slice(1), 32, ly + 4)
        ly += 20
      }
    }

    // ── Simulation. Skipped entirely for zero nodes — nothing to settle,
    // and no timer should exist to do nothing forever.
    let sim: Simulation<GraphNode, SimLink> | null = null
    const reducedMotion = prefersReducedMotion()

    if (nodes.length > 0) {
      sim = forceSimulation<GraphNode>(nodes)
        .force('charge', forceManyBody().strength(-160))
        .force('link', forceLink<GraphNode, SimLink>(links).id(n => n.id).distance(70).strength(0.5))
        .force('collide', forceCollide<GraphNode>().radius(n => radiusOf(n) + 6))
        // Gentle centring, not a hard snap — forceX/Y at low strength pulls
        // the whole layout back toward the world origin over many ticks
        // without fighting the charge/link forces the way forceCenter's
        // single-shot recentring can. World (0, 0) is screen-centered by
        // the view transform, not by these targets — see the note above
        // the seed-position loop.
        .force('x', forceX<GraphNode>(0).strength(0.02))
        .force('y', forceY<GraphNode>(0).strength(0.02))
        .velocityDecay(0.35)
        .on('tick', draw)

      if (reducedMotion) {
        // Settle synchronously — run the simulation to completion before the
        // first paint instead of animating toward it. tick() advances alpha
        // by alphaDecay each call; alphaMin defaults to 0.001, so ~300
        // iterations reaches it from the default starting alpha of 1.
        sim.stop()
        for (let i = 0; i < 300; i++) sim.tick()
        draw()
      }
    } else {
      draw()
    }

    // ── Pan / zoom / drag / hover — pointer events on the canvas element.
    function onWheel(e: WheelEvent) {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      const before = screenToWorld(sx, sy)
      const factor = Math.exp(-e.deltaY * 0.0015)
      view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor))
      // Re-anchor so the point under the cursor stays under the cursor.
      view.tx = sx - before.x * view.scale
      view.ty = sy - before.y * view.scale
      draw()
    }

    function onPointerDown(e: PointerEvent) {
      const rect = canvas.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top
      const world = screenToWorld(sx, sy)
      const hit = nodeAt(world.x, world.y)
      canvas.setPointerCapture(e.pointerId)
      if (hit) {
        draggingNode = hit
        hit.fx = hit.x
        hit.fy = hit.y
        if (sim && !reducedMotion) sim.alphaTarget(0.3).restart()
      } else {
        isPanning = true
        panStart = { x: sx, y: sy }
        viewStart = { tx: view.tx, ty: view.ty }
      }
    }

    function onPointerMove(e: PointerEvent) {
      const rect = canvas.getBoundingClientRect()
      const sx = e.clientX - rect.left
      const sy = e.clientY - rect.top

      if (draggingNode) {
        const world = screenToWorld(sx, sy)
        draggingNode.fx = world.x
        draggingNode.fy = world.y
        if (reducedMotion) { sim?.tick(); draw() }
        return
      }
      if (isPanning) {
        view.tx = viewStart.tx + (sx - panStart.x)
        view.ty = viewStart.ty + (sy - panStart.y)
        draw()
        return
      }

      const world = screenToWorld(sx, sy)
      const hit = nodeAt(world.x, world.y)
      const nextHoveredId = hit?.id ?? null
      if (nextHoveredId !== hoveredId) {
        hoveredId = nextHoveredId
        canvas.style.cursor = hit ? 'pointer' : 'default'
        draw()
      }
    }

    function onPointerUp(e: PointerEvent) {
      canvas.releasePointerCapture(e.pointerId)
      if (draggingNode) {
        draggingNode.fx = null
        draggingNode.fy = null
        if (sim && !reducedMotion) sim.alphaTarget(0)
        draggingNode = null
      }
      isPanning = false
    }

    function onPointerLeave() {
      if (hoveredId != null) { hoveredId = null; draw() }
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointerleave', onPointerLeave)

    // Tab hidden → stop the simulation's timer outright (a rAF loop left
    // running off-screen is a real battery/CPU cost); tab visible again →
    // give it a small reheat so a mid-motion layout doesn't look frozen.
    function onVisibilityChange() {
      if (!sim) return
      if (document.hidden) sim.stop()
      else sim.alpha(Math.max(sim.alpha(), 0.1)).restart()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    function onResize() {
      resizeCanvas()
      // Force targets are world-space (0, 0), which doesn't move on resize —
      // only the canvas backing store and the redraw need updating.
      if (reducedMotion) draw()
      else sim?.alpha(Math.max(sim.alpha(), 0.15)).restart()
    }
    window.addEventListener('resize', onResize)

    return () => {
      sim?.stop()
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('resize', onResize)
    }
  }, [data])

  if (loading) return <div className="flex justify-center py-12"><div className="h-6 w-6 rounded-full border-2 border-brand-500 border-t-transparent animate-spin" /></div>
  if (!data) return <p className="text-mountain-500 text-center py-8">Failed to load graph</p>

  const counts = corpusCounts(data)

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-mountain-400" />
          <span className="text-sm text-mountain-300" data-testid="graph-counts">
            {counts.collections ?? 0} collections · {counts.sources ?? 0} sources · {counts.agents_with_knowledge ?? 0} agents
          </span>
          {data.truncated && data.shown && (
            <span
              className="text-xs text-amber-400/90 border border-amber-700/50 bg-amber-900/20 rounded px-1.5 py-0.5"
              data-testid="graph-truncated-notice"
            >
              graph shows {data.shown.collections} of {counts.collections} collections
              {' '}and {data.shown.sources} of {counts.sources} sources
            </span>
          )}
        </div>
        <span className="text-xs text-mountain-500">scroll to zoom · drag to pan · drag a node to move it</span>
      </div>
      <div className="rounded-lg border border-navy-700 bg-[#0f1923] overflow-hidden">
        <canvas ref={canvasRef} className="w-full touch-none" style={{ height: '450px' }} data-testid="knowledge-graph-canvas" />
      </div>
    </div>
  )
}
