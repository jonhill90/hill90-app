/**
 * app#383: clicking a graph node should navigate — this is the pure decision
 * logic behind that, tested directly rather than through simulated
 * PointerEvents on the canvas.
 *
 * WHY NOT AN INTEGRATION TEST THROUGH REAL POINTER EVENTS. Checked, not
 * assumed: `document.createElement('canvas').getContext('2d')` returns
 * `null` in this project's jsdom test environment (no canvas-mocking package
 * is installed). `KnowledgeGraph`'s physics/pointer effect bails out
 * immediately after `if (!ctx) return`, so dispatching PointerEvents at a
 * rendered `<canvas>` in a test never reaches the click-vs-drag logic at
 * all — there would be nothing to assert on. `resolveNavigationTarget` and
 * `isClickNotDrag` are exported specifically so the actual decisions a real
 * pointer interaction would make are testable without a working canvas.
 *
 * The two most important assertions, per the review this file answers: the
 * callback fires with the right target for a collection node and for a
 * source node, and — the one most likely to be skipped, most likely to
 * regress — a drag does NOT fire it.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveNavigationTarget,
  isClickNotDrag,
  CLICK_MAX_MOVE_PX,
  CLICK_MAX_DURATION_MS,
  type GraphNode,
} from '../app/harness/shared-knowledge/KnowledgeGraph'

const EDGES = [
  { source: 'col-c1', target: 'src-s1', label: 'contains' },
  { source: 'col-c2', target: 'src-s2', label: 'contains' },
  { source: 'user-u1', target: 'src-s1', label: 'retrieved', meta: { retrieval_count: 3 } },
]

function node(id: string, type: string, label = id): GraphNode {
  return { id, type, label }
}

describe('resolveNavigationTarget — what a click resolves to', () => {
  it('a collection node resolves to its own id, no sourceId', () => {
    expect(resolveNavigationTarget(node('col-c1', 'collection'), EDGES)).toEqual({
      collectionId: 'c1',
    })
  })

  it('a source node resolves to its parent collection AND its own id', () => {
    expect(resolveNavigationTarget(node('src-s1', 'source'), EDGES)).toEqual({
      collectionId: 'c1',
      sourceId: 's1',
    })
  })

  it('a source node in a different collection resolves to THAT collection, not the first one seen', () => {
    expect(resolveNavigationTarget(node('src-s2', 'source'), EDGES)).toEqual({
      collectionId: 'c2',
      sourceId: 's2',
    })
  })

  it('a source with no contains edge on this page resolves to nothing, not a guess', () => {
    expect(resolveNavigationTarget(node('src-orphan', 'source'), EDGES)).toBeNull()
  })

  it('a user node resolves to nothing — it gets the retrieved-sources panel instead, handled elsewhere', () => {
    expect(resolveNavigationTarget(node('user-u1', 'user'), EDGES)).toBeNull()
  })

  it('an agent node resolves to nothing — out of scope for #383, stays inert', () => {
    expect(resolveNavigationTarget(node('agent-scout', 'agent'), EDGES)).toBeNull()
  })

  it('zero edges does not throw for any node type', () => {
    expect(() => resolveNavigationTarget(node('col-c1', 'collection'), [])).not.toThrow()
    expect(resolveNavigationTarget(node('src-s1', 'source'), [])).toBeNull()
  })
})

describe('isClickNotDrag — the assertion most likely to be skipped', () => {
  it('no movement, no time — a real click — fires', () => {
    expect(isClickNotDrag(0, 0, 0)).toBe(true)
  })

  it('movement well under the threshold, released quickly — fires', () => {
    expect(isClickNotDrag(2, -1, 120)).toBe(true)
  })

  it('movement past the pixel threshold — a drag — does NOT fire, even if released instantly', () => {
    expect(isClickNotDrag(CLICK_MAX_MOVE_PX + 1, 0, 0)).toBe(false)
  })

  it('held past the duration threshold — a long press — does NOT fire, even with zero movement', () => {
    expect(isClickNotDrag(0, 0, CLICK_MAX_DURATION_MS + 1)).toBe(false)
  })

  it('a real drag: moved AND held — does NOT fire', () => {
    expect(isClickNotDrag(40, 25, 900)).toBe(false)
  })

  it('exactly at both thresholds still counts as a click — the boundary is inclusive', () => {
    expect(isClickNotDrag(CLICK_MAX_MOVE_PX, 0, CLICK_MAX_DURATION_MS)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// POSITIVE CONTROL — the movement check is real Euclidean distance
// (`dx*dx+dy*dy <= MAX*MAX`), not the sum of the two axes. This fixture is
// chosen so the two implementations DISAGREE, not just so it's diagonal:
// dx=4, dy=3 is real distance exactly 5 (a 3-4-5 triangle) — at the 5px
// threshold, so it must still count as a click — but summed axes gives
// 4+3=7, past the threshold, which would wrongly call it a drag. A fixture
// where both implementations happen to agree (e.g. dx=4, dy=4) would not
// have caught this; verified by actually reverting to summed-axes and
// re-running this suite — see the PR for the real failing output.
// ---------------------------------------------------------------------------
describe('CONTROL: movement is measured as real distance, not summed axes', () => {
  it('a 3-4-5 triangle move sits exactly at the threshold and must still count as a click', () => {
    expect(isClickNotDrag(4, 3, 0)).toBe(true)
  })
})
