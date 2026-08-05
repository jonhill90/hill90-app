/**
 * app#380/#381: the consumer half of the graph node-type contract.
 *
 * WHAT HAPPENED. #379 added `type: "user"` to `knowledge_graph()`'s node
 * output. #378, built and merged the same night by a different lane with no
 * visibility into #379, styled only the three node types that existed when
 * it was written — `KnowledgeGraph.tsx`'s `TYPE_COLORS` and
 * `TYPE_BASE_RADIUS` both had a defensive fallback (`|| '#6b7280'`, `?? 6`),
 * so the new type rendered as a small grey dot with a raw UUID label instead
 * of erroring. Fixed once, ad hoc, in #382. This file is the mechanism that
 * stops it happening a third time on the next new type.
 *
 * `docs/contracts/graph-node-types.json` is the shared statement of what the
 * type set IS — owned by neither service, read directly by both rather than
 * one reaching into the other's source. `services/knowledge`'s half
 * (test_graph_node_type_contract.py, #381) proves the function's real output
 * agrees with the manifest. This file proves the RENDERER agrees with it —
 * both maps that decide how a node looks, not just colour. A missing radius
 * entry falls through `?? 6` and is the exact same defect as the grey dot,
 * only less visible, which makes it worse, not better: nobody notices a
 * slightly-wrong-sized circle the way they notice grey-and-unlabelled.
 *
 * Exact equality (`toEqual` on two Sets), not "renderer supports at least
 * these" — a colour/radius entry for a type the producer no longer emits is
 * drift worth catching too, not just the reverse.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, it, expect } from 'vitest'
import { TYPE_COLORS, TYPE_BASE_RADIUS } from '../app/harness/shared-knowledge/KnowledgeGraph'

// Resolved from THIS FILE's own location (__dirname), not process.cwd() —
// CI runs vitest with `working-directory: services/ui`
// (.github/workflows/ci.yml), and every local invocation in this repo's own
// convention also runs from services/ui, so a cwd-relative path would
// probably agree between the two today. "Probably agrees today" is exactly
// the kind of thing this contract exists to stop relying on: a path
// resolved from the test file's own location is correct regardless of what
// directory vitest happened to be launched from, in CI, locally, or from an
// editor's "run this test" button, none of which this file can predict.
// (Checked `import.meta.url` first — vitest's transform resolves it to
// something other than this file's real absolute path here, silently
// producing a wrong-but-plausible-looking directory. __dirname does not
// have that problem, matches what vitest.config.ts itself already relies
// on, and matches the Python side's own `Path(__file__).resolve()`.)
//
// No try/catch around the read: a missing or unreadable manifest must throw
// and fail this file loudly at collection time. A caught error that skipped
// these assertions would be the exact "instrument reports nothing was wrong"
// shape this whole contract exists to prevent — silently reporting agreement
// because the comparison never ran is worse than the grey dot it replaces.
declare const __dirname: string
const MANIFEST_PATH = join(__dirname, '../../../../docs/contracts/graph-node-types.json')
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as {
  types: { name: string; description: string }[]
}
const manifestTypes = new Set(manifest.types.map(t => t.name))

describe('KnowledgeGraph node-type contract (docs/contracts/graph-node-types.json)', () => {
  it('the manifest exists where this test assumes it does', () => {
    // Redundant with the module-level read above in the success case —
    // stated as its own assertion so a failure here reads as "the manifest
    // moved or the path assumption is wrong" rather than a bare parse crash
    // with no test name attached to it.
    expect(manifestTypes.size).toBeGreaterThan(0)
  })

  it('TYPE_COLORS covers exactly the node types the contract declares — no more, no fewer', () => {
    expect(new Set(Object.keys(TYPE_COLORS))).toEqual(manifestTypes)
  })

  it('TYPE_BASE_RADIUS covers exactly the node types the contract declares — no more, no fewer', () => {
    expect(new Set(Object.keys(TYPE_BASE_RADIUS))).toEqual(manifestTypes)
  })
})

// ---------------------------------------------------------------------------
// POSITIVE CONTROL, run and captured before this shipped — see the PR that
// added this file for the real failing output, produced by temporarily
// adding a fifth type to the manifest only (not to either map) and running
// the suite. That red state is not committed; this file stays permanently
// green as the record of what the mechanism checks.
// ---------------------------------------------------------------------------

describe('CONTROL: the equality check itself, isolated from the real manifest', () => {
  it('a type present in the manifest but missing from a renderer map fails toEqual', () => {
    const rendererTypes = new Set(['collection', 'source', 'agent', 'user'])
    const regressedManifestTypes = new Set(['collection', 'source', 'agent', 'user', 'phantom'])
    expect(() => expect(rendererTypes).toEqual(regressedManifestTypes)).toThrow()
  })

  it('a type present in a renderer map but removed from the manifest also fails toEqual', () => {
    const staleRendererTypes = new Set(['collection', 'source', 'agent', 'user', 'retired'])
    const currentManifestTypes = new Set(['collection', 'source', 'agent', 'user'])
    expect(() => expect(staleRendererTypes).toEqual(currentManifestTypes)).toThrow()
  })
})
