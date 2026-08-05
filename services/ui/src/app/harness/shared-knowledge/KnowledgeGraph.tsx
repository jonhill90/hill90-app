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
  meta?: Record<string, unknown>
}

// app#383: where a click on a node should navigate. `sourceId` is present
// only for a source-node click (a collection click has nowhere finer to
// point). The caller (SharedKnowledgeClient) owns tabs/selection state;
// this component only ever resolves WHICH node was clicked and what that
// implies, never reaches into tab state itself.
export interface GraphNavigationTarget {
  collectionId: string
  sourceId?: string
}

// Node ids are constructed in services/knowledge's shared_store.py as
// f"col-{id}" / f"src-{id}" / f"agent-{id}" / f"{agent|user}-{id}" — NOT a
// uniform `${type}-` prefix (collection/source abbreviate, agent/user don't).
// Hardcoded here rather than derived from `type`, because a wrong derivation
// would fail silently (a truncated id that still looks plausible), not loudly.
const ID_PREFIX: Record<string, string> = { collection: 'col-', source: 'src-', agent: 'agent-', user: 'user-' }
function idWithoutPrefix(node: GraphNode): string {
  const prefix = ID_PREFIX[node.type] ?? `${node.type}-`
  return node.id.startsWith(prefix) ? node.id.slice(prefix.length) : node.id
}

// Pure and standalone (takes edges as a param rather than closing over
// component state) so both the canvas's imperative click handler and the
// user-panel's plain React onClick can call the same resolution — one
// navigation primitive, not two, per #383.
export function resolveNavigationTarget(node: GraphNode, edges: GraphEdge[]): GraphNavigationTarget | null {
  if (node.type === 'collection') {
    return { collectionId: idWithoutPrefix(node) }
  }
  if (node.type === 'source') {
    // A source's parent collection isn't in its own meta — resolved from the
    // `contains` edge whose target is this source, same as the renderer
    // already has to do nothing special for (that edge exists purely for
    // drawing the tree). No edge means a dangling/truncated source (#377's
    // own dangling-edge accounting) — nothing sensible to navigate to.
    const containsEdge = edges.find(e => e.label === 'contains' && e.target === node.id)
    if (!containsEdge) return null
    const collectionId = containsEdge.source.startsWith('col-')
      ? containsEdge.source.slice('col-'.length)
      : containsEdge.source
    return { collectionId, sourceId: idWithoutPrefix(node) }
  }
  // agent/user nodes have no tab to navigate to — `user` gets the retrieved-
  // sources panel instead (handled by the caller of resolveNavigationTarget,
  // not here), `agent` is out of scope for #383 and stays inert on click,
  // same as before this file existed.
  return null
}

// d3-force mutates link.source/target from string ids into node object
// references once the simulation initializes — this is the post-init shape.
type SimLink = SimulationLinkDatum<GraphNode> & { label?: string; meta?: Record<string, unknown> }

// `retrieved` edges (#379) carry a real usage weight; `contains` edges carry
// none — 0 means "no weight signal", not "weight of zero", and every caller
// below treats 0 as leaving the length-based defaults alone.
function edgeWeight(link: SimLink): number {
  const v = link.meta?.retrieval_count
  return typeof v === 'number' && v > 0 ? v : 0
}

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
// Both color shapes colorForType can return — '#rrggbb' and 'hsl(h, s%, l%)'
// — need an alpha channel for edge gradients and layered glow, and canvas
// doesn't accept a separate alpha alongside either string form.
export function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('#') && color.length === 7) {
    const r = parseInt(color.slice(1, 3), 16)
    const g = parseInt(color.slice(3, 5), 16)
    const b = parseInt(color.slice(5, 7), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  if (color.startsWith('hsl(')) {
    return `hsla(${color.slice(4, -1)}, ${alpha})`
  }
  return color
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

interface KnowledgeGraphProps {
  // Optional: KnowledgeGraph works standalone (e.g. under test) with clicks
  // simply doing nothing if this isn't supplied.
  onNavigate?: (target: GraphNavigationTarget) => void
}

// A click must be distinguishable from the drag this canvas already
// supports — a node released within this many pixels of where it was
// picked up, within this long, counts as a click; anything past either
// threshold is a drag that happened to end near its start, not a click.
//
// NOT verified against real trackpad hardware from this environment — 5px
// is the conventional click/drag tolerance several browsers and toolkits
// use (roughly what a dblclick's own movement tolerance allows), chosen by
// that precedent, not by testing this exact canvas on a trackpad. Said
// here rather than implied: if a tap-with-a-pixel-or-two-of-drift turns
// out to need more slack in practice, this is the one constant to widen.
export const CLICK_MAX_MOVE_PX = 5
export const CLICK_MAX_DURATION_MS = 400

// Pure and standalone so it's testable without a canvas 2D context — jsdom
// (this project's test environment) returns `null` from
// `canvas.getContext('2d')`, so the pointer listeners below never attach
// during a test render. This is the actual decision they'd make, extracted
// so drag-vs-click has a test that doesn't depend on canvas support existing.
export function isClickNotDrag(dxPx: number, dyPx: number, elapsedMs: number): boolean {
  return dxPx * dxPx + dyPx * dyPx <= CLICK_MAX_MOVE_PX * CLICK_MAX_MOVE_PX
    && elapsedMs <= CLICK_MAX_DURATION_MS
}

export default function KnowledgeGraph({ onNavigate }: KnowledgeGraphProps = {}) {
  const [data, setData] = useState<GraphData | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const { data: session } = useSession()
  // Read via ref inside the draw loop below, not the `session` value
  // directly — the physics effect keys off `[data]` only, and re-running the
  // whole simulation setup because the session object identity changed
  // (routine with next-auth) would restart the layout for no visual reason.
  const currentUserSubRef = useRef<string | undefined>(undefined)
  useEffect(() => { currentUserSubRef.current = session?.user?.sub }, [session])
  // Same reasoning, same fix, for onNavigate: a fresh function identity on
  // every parent render must not restart the simulation. Read the current
  // callback through this ref inside the pointer handlers below instead.
  const onNavigateRef = useRef(onNavigate)
  useEffect(() => { onNavigateRef.current = onNavigate }, [onNavigate])

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
      .map(e => ({ source: e.source, target: e.target, label: e.label, meta: e.meta }))

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
    // app#383: recorded only when a node was actually hit at pointerdown —
    // panning never sets this, so a pan gesture can never accidentally
    // resolve as a click no matter how short or small it is.
    let pointerDownInfo: { node: GraphNode; x: number; y: number; t: number } | null = null

    function handleNodeClick(node: GraphNode) {
      if (node.type === 'user') {
        // Toggle: clicking the same hub again closes its panel rather than
        // requiring the panel's own close button every time.
        setSelectedUserId(prev => (prev === node.id ? null : node.id))
        return
      }
      if (!data) return
      const target = resolveNavigationTarget(node, data.edges)
      if (target) onNavigateRef.current?.(target)
    }

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

    // ── Idle drift (visual polish, see PR for measurement) ─────────────
    //
    // A per-node stable phase (hashed from id, not random — the same node
    // drifts the same way every frame, not a new random walk each render)
    // so the whole graph doesn't sway in lockstep, which would read as one
    // rigid object breathing rather than many independent things settled
    // near equilibrium. This NEVER touches n.x/n.y (the simulation's real
    // state) — it is a screen-space-only offset added at draw time, so it
    // cannot destabilize the settled layout, feed back into the physics, or
    // accumulate energy. Amplitude is deliberately sub-pixel-to-a-couple-
    // pixels: enough to read as alive, not enough to be distracting, and
    // small enough that hit-testing (nodeAt, keyed off the true n.x/n.y)
    // does not need to account for it.
    const DRIFT_AMPLITUDE_PX = 0.6
    function driftOffset(n: GraphNode, now: number): { dx: number; dy: number } {
      if (reducedMotion) return { dx: 0, dy: 0 }
      const seed = hashType(n.id)
      const phaseX = (seed % 997) / 997 * Math.PI * 2
      const phaseY = (Math.floor(seed / 997) % 997) / 997 * Math.PI * 2
      return {
        dx: Math.sin(now / 4200 + phaseX) * DRIFT_AMPLITUDE_PX,
        dy: Math.cos(now / 5100 + phaseY) * DRIFT_AMPLITUDE_PX,
      }
    }

    // ── Layered glow (real bloom, not a single shadowBlur ring) ────────
    //
    // [radius multiplier, alpha] pairs, drawn outer-to-inner as flat filled
    // circles UNDER the crisp node — no `shadowBlur` at all. This is not
    // only prettier (a graduated falloff instead of one hard-edged glow
    // ring) — it measures cheaper too: `shadowBlur` forces a real blur
    // convolution over the shadow-casting shape's bounding box on every
    // draw, on every node, and browsers do not cache that between frames.
    // A handful of flat alpha-blended arcs is compositing, not convolution.
    // Measured via the Playwright harness in this PR, not assumed — see the
    // PR description for the actual per-frame timing at this corpus size.
    const GLOW_RINGS: readonly [mult: number, alpha: number][] = [
      [2.4, 0.035],
      [1.8, 0.07],
      [1.35, 0.12],
    ]
    // The user node is the graph's visual anchor (its structural role: the
    // hub that turns three disconnected collection-trees into one connected
    // component, #377/#379) and gets one extra, wider, brighter ring rather
    // than a separate effect (a pulsing or rotating ring was considered and
    // rejected — it would fight the "not enough to be distracting" bar the
    // idle drift is already held to, and the size/glow/colour treatment
    // already gives it primacy without extra chrome).
    const GLOW_RINGS_HUB: readonly [mult: number, alpha: number][] = [
      [3.0, 0.04],
      [2.3, 0.08],
      [1.7, 0.13],
      [1.3, 0.17],
    ]

    function labelAlphaFor(n: GraphNode, isHovered: boolean, isNeighbor: boolean, dimmed: boolean): number {
      if (dimmed) return 0
      if (isHovered) return 1
      if (isNeighbor) return 0.9
      // Collections and the user hub stay structurally labeled regardless
      // of zoom or connectivity — same reasoning as before this file's
      // visual pass, just no longer a hard on/off for everything else.
      if (n.type === 'collection' || n.type === 'user') return 1
      // Everything else fades in smoothly from two independent signals —
      // degree (a well-connected node earns its label even at rest) and
      // zoom (get close enough and the resting state should read like
      // Obsidian's own: labels appear as you approach, not all at once).
      // Summed and capped, not multiplied, so either signal alone can
      // still bring a label most of the way in.
      //
      // zoomAlpha's threshold is deliberately ABOVE the default view.scale
      // of 1 — checked visually (see the PR's screenshots), not just by
      // formula: a lower threshold made every source label visible at rest
      // simply because 1.0 already cleared it, which is the exact "becomes
      // noise fast" problem this pass exists to fix, just moved from "always
      // on" to "always on, slightly fainter". Below 1.3x zoom, only degree
      // contributes; past that, zooming in progressively reveals the rest.
      const deg = degree.get(n.id) || 0
      const degreeAlpha = Math.min(deg / 4, 1) * 0.55
      const zoomAlpha = Math.min(Math.max((view.scale - 1.3) / 1.0, 0), 1) * 0.55
      return Math.min(degreeAlpha + zoomAlpha, 1)
    }

    function draw(now: number = performance.now()) {
      if (!ctx) return
      ctx.save()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = '#0f1923'
      ctx.fillRect(0, 0, w, h)

      ctx.translate(view.tx, view.ty)
      ctx.scale(view.scale, view.scale)

      const activeNeighbors = hoveredId ? neighbors.get(hoveredId) ?? new Set<string>() : null

      // Edges — gradient between the two endpoints' own colours (not a flat
      // neutral line), opacity by length as before PLUS a boost for
      // `retrieved` edges' real usage weight (chunk_hits, #379) so a
      // heavily-used link reads as heavier, not just "a line exists".
      // Thickness gets the same weight boost.
      for (const link of links) {
        const s = link.source as GraphNode
        const t = link.target as GraphNode
        if (s.x == null || s.y == null || t.x == null || t.y == null) continue
        const sOff = driftOffset(s, now)
        const tOff = driftOffset(t, now)
        const sx = s.x + sOff.dx, sy = s.y + sOff.dy
        const tx2 = t.x + tOff.dx, ty2 = t.y + tOff.dy
        const dx = tx2 - sx
        const dy = ty2 - sy
        const len = Math.sqrt(dx * dx + dy * dy)
        const isFocused = hoveredId != null && (s.id === hoveredId || t.id === hoveredId)
        const weight = edgeWeight(link)
        const lengthAlpha = Math.max(0.08, Math.min(0.5, 140 / (len + 60)))
        const weightAlphaBoost = weight > 0 ? Math.min(Math.sqrt(weight) * 0.08, 0.25) : 0
        const base = Math.min(lengthAlpha + weightAlphaBoost, 0.75)
        const alpha = hoveredId == null ? base : (isFocused ? Math.min(base + 0.35, 0.9) : base * 0.15)

        const grad = ctx.createLinearGradient(sx, sy, tx2, ty2)
        grad.addColorStop(0, withAlpha(colorForType(s.type), alpha))
        grad.addColorStop(1, withAlpha(colorForType(t.type), alpha))
        ctx.strokeStyle = grad
        ctx.lineWidth = (isFocused ? 1.6 : 1) + Math.min(Math.sqrt(weight) * 0.5, 2.2)
        ctx.beginPath()
        ctx.moveTo(sx, sy)
        ctx.lineTo(tx2, ty2)
        ctx.stroke()
      }

      // Nodes — layered glow (bloom) under a crisp core, radius by degree,
      // colour by type; hover highlights the node and its direct neighbours
      // and dims the rest.
      for (const n of nodes) {
        if (n.x == null || n.y == null) continue
        const { dx, dy } = driftOffset(n, now)
        const nx = n.x + dx, ny = n.y + dy
        const r = radiusOf(n)
        const color = colorForType(n.type)
        const isHovered = n.id === hoveredId
        const isNeighbor = activeNeighbors?.has(n.id) ?? false
        const dimmed = hoveredId != null && !isHovered && !isNeighbor

        if (!dimmed) {
          const rings = n.type === 'user' ? GLOW_RINGS_HUB : GLOW_RINGS
          const boost = isHovered ? 1.7 : 1
          for (const [mult, a] of rings) {
            ctx.beginPath()
            ctx.fillStyle = withAlpha(color, Math.min(a * boost, 0.5))
            ctx.arc(nx, ny, r * mult, 0, Math.PI * 2)
            ctx.fill()
          }
        }

        ctx.save()
        ctx.globalAlpha = dimmed ? 0.22 : 1
        ctx.fillStyle = color + '33'
        ctx.strokeStyle = color
        ctx.lineWidth = isHovered ? 2.5 : 1.5
        ctx.beginPath()
        ctx.arc(nx, ny, r, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        ctx.restore()

        const la = labelAlphaFor(n, isHovered, isNeighbor, dimmed)
        if (la > 0.03) {
          ctx.globalAlpha = la
          ctx.fillStyle = isHovered ? '#ffffff' : '#c9d1d9'
          ctx.font = `${isHovered ? 'bold ' : ''}${n.type === 'collection' ? 11 : 10}px system-ui, sans-serif`
          ctx.textAlign = 'center'
          const resolved = labelFor(n, currentUserSubRef.current)
          const label = resolved.length > 22 ? `${resolved.slice(0, 20)}…` : resolved
          ctx.fillText(label, nx, ny + r + 13)
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

    // Idle drift's own rAF loop — separate from d3-force's internal timer,
    // which stops calling the tick handler once alpha decays below
    // alphaMin. This loop exists ONLY to keep redrawing (with the tiny
    // screen-space drift offset above) after the physics has genuinely
    // settled; it is never started at all when `reducedMotion` is true —
    // the ABSOLUTE constraint from the review that authorized this file:
    // reduced motion settles once and stays still, full stop.
    let idleRafId: number | null = null
    function stopIdleDrift() {
      if (idleRafId != null) { cancelAnimationFrame(idleRafId); idleRafId = null }
    }
    function startIdleDrift() {
      if (reducedMotion || idleRafId != null) return
      function loop(now: number) {
        draw(now)
        idleRafId = requestAnimationFrame(loop)
      }
      idleRafId = requestAnimationFrame(loop)
    }

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
        .on('tick', () => draw())

      if (reducedMotion) {
        // Settle synchronously — run the simulation to completion before the
        // first paint instead of animating toward it. tick() advances alpha
        // by alphaDecay each call; alphaMin defaults to 0.001, so ~300
        // iterations reaches it from the default starting alpha of 1.
        sim.stop()
        for (let i = 0; i < 300; i++) sim.tick()
        draw()
      } else {
        // Fires whenever alpha decays past alphaMin — including again after
        // a drag's alphaTarget(0) lets it settle back down, not just once.
        sim.on('end', startIdleDrift)
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
        pointerDownInfo = { node: hit, x: sx, y: sy, t: performance.now() }
        hit.fx = hit.x
        hit.fy = hit.y
        if (sim && !reducedMotion) {
          stopIdleDrift()
          sim.alphaTarget(0.3).restart()
        }
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
        // Click resolution BEFORE releasing fx/fy — both happen for a
        // released-in-place node (this is intentional, matches Obsidian's
        // own graph: releasing a node both re-settles it into the
        // simulation and, if it never really moved, selects it).
        if (pointerDownInfo && pointerDownInfo.node === draggingNode) {
          const rect = canvas.getBoundingClientRect()
          const sx = e.clientX - rect.left
          const sy = e.clientY - rect.top
          const elapsedMs = performance.now() - pointerDownInfo.t
          if (isClickNotDrag(sx - pointerDownInfo.x, sy - pointerDownInfo.y, elapsedMs)) {
            handleNodeClick(draggingNode)
          }
        }
        draggingNode.fx = null
        draggingNode.fy = null
        if (sim && !reducedMotion) sim.alphaTarget(0)
        draggingNode = null
      }
      pointerDownInfo = null
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

    // Tab hidden → stop the simulation's timer AND idle drift's own loop
    // outright (either one left running off-screen is a real battery/CPU
    // cost); tab visible again → reheat the simulation, which will refire
    // 'end' and resume idle drift once it resettles, so a mid-motion layout
    // doesn't look frozen and drift doesn't need its own separate resume path.
    function onVisibilityChange() {
      if (!sim) return
      if (document.hidden) {
        sim.stop()
        stopIdleDrift()
      } else {
        sim.alpha(Math.max(sim.alpha(), 0.1)).restart()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    function onResize() {
      resizeCanvas()
      // Force targets are world-space (0, 0), which doesn't move on resize —
      // only the canvas backing store and the redraw need updating.
      if (reducedMotion) {
        draw()
      } else {
        stopIdleDrift()
        // Pre-existing bug, unrelated to this PR's own changes, fixed while
        // touching this line rather than left or silently patched: `sim`
        // can be null (zero-node graph) and the un-guarded `sim.alpha()`
        // inside `Math.max` below would throw on a resize in that case,
        // before the outer `sim?.` optional chain ever got a chance to
        // short-circuit anything.
        sim?.alpha(Math.max(sim?.alpha() ?? 0, 0.15)).restart()
      }
    }
    window.addEventListener('resize', onResize)

    return () => {
      sim?.stop()
      stopIdleDrift()
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

  // app#383: the user-node panel. Derived entirely from `data`, already in
  // memory — no new fetch. Nothing existing shows "what did this requester
  // retrieve", so unlike collection/source clicks (which navigate to an
  // existing tab) this is genuinely new surface, kept as small as the data
  // it's showing rather than a new tab of its own.
  const selectedUserNode = selectedUserId ? data.nodes.find(n => n.id === selectedUserId) ?? null : null
  const retrievedBySelectedUser = selectedUserId
    ? data.edges
        .filter(e => e.label === 'retrieved' && e.source === selectedUserId)
        .map(e => {
          const target = data.nodes.find(n => n.id === e.target)
          return target ? { node: target, retrievalCount: e.meta?.retrieval_count } : null
        })
        .filter((x): x is { node: GraphNode; retrievalCount: unknown } => x !== null)
        .sort((a, b) => (Number(b.retrievalCount) || 0) - (Number(a.retrievalCount) || 0))
    : []

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
        <span className="text-xs text-mountain-500">scroll to zoom · drag to pan · click a node to open it · drag a node to move it</span>
      </div>
      <div className="relative rounded-lg border border-navy-700 bg-[#0f1923] overflow-hidden">
        <canvas ref={canvasRef} className="w-full touch-none" style={{ height: '450px' }} data-testid="knowledge-graph-canvas" />
        {selectedUserNode && (
          <div
            className="absolute top-3 right-3 w-64 max-h-96 overflow-y-auto rounded-lg border border-navy-600 bg-navy-900/95 backdrop-blur-sm p-3 text-sm shadow-xl"
            data-testid="graph-user-retrieved-panel"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-mountain-300 font-medium">
                {labelFor(selectedUserNode, session?.user?.sub)} retrieved
              </span>
              <button
                onClick={() => setSelectedUserId(null)}
                className="text-mountain-500 hover:text-white cursor-pointer leading-none"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            {retrievedBySelectedUser.length === 0 ? (
              <p className="text-mountain-500 text-xs">Nothing resolvable on this page of the graph.</p>
            ) : (
              <ul className="space-y-1.5">
                {retrievedBySelectedUser.map(({ node, retrievalCount }) => (
                  <li key={node.id}>
                    <button
                      onClick={() => {
                        const target = resolveNavigationTarget(node, data.edges)
                        if (target) onNavigate?.(target)
                      }}
                      className="text-left w-full text-mountain-300 hover:text-white truncate cursor-pointer"
                    >
                      {node.label}
                      {typeof retrievalCount === 'number' && (
                        <span className="text-mountain-500"> · {retrievalCount}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
