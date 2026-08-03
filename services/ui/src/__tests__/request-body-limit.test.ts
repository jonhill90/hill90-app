/**
 * The body limit must be a LIMIT, not a REPORT.
 *
 * The distinction these cases pin: a Content-Length check tells you how big the
 * caller SAYS the body is. Counting during the read tells you how big it IS.
 * Only the second bounds memory, because the header is absent on a chunked
 * request and is a client-supplied claim on every other one.
 *
 * So the load-bearing assertions here are the ones about what was actually
 * pulled off the stream — `pulled` counts real reads. A version that checked
 * the header and then called `arrayBuffer()` would pass a naive status-code
 * test and fail every one of those.
 */
import { describe, it, expect } from 'vitest'
import {
  readBodyLimited,
  readTextLimited,
  bodyTooLargeResponse,
  BodyTooLargeError,
  BODY_LIMIT_JSON,
  BODY_LIMIT_AVATAR,
  BODY_LIMIT_UPLOAD,
} from '@/utils/request-body'

/**
 * A request whose stream reports how much was actually pulled from it, and
 * whether it was cancelled. `declared` is set independently of the real size so
 * a lying header can be expressed.
 */
function makeRequest(opts: {
  totalBytes: number
  chunkSize?: number
  declared?: number | null
}) {
  const chunkSize = opts.chunkSize ?? 64 * 1024
  const state = { pulled: 0, cancelled: false }
  let remaining = opts.totalBytes

  // highWaterMark: 0 is load-bearing in the FIXTURE, not the subject. With the
  // default of 1 the stream eagerly pulls one chunk at construction, before the
  // code under test calls read() at all — so `pulled` measured the fixture's
  // own buffering and the "without reading a byte" case failed at 65536 against
  // an implementation that was correct. An instrument that moves the thing it
  // is measuring.
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (remaining <= 0) {
          controller.close()
          return
        }
        const n = Math.min(chunkSize, remaining)
        remaining -= n
        state.pulled += n
        controller.enqueue(new Uint8Array(n))
      },
      cancel() {
        state.cancelled = true
      },
    },
    { highWaterMark: 0 },
  )

  const declared =
    opts.declared === undefined ? opts.totalBytes : opts.declared

  return {
    req: {
      headers: {
        get: (name: string) =>
          name.toLowerCase() === 'content-length' && declared !== null
            ? String(declared)
            : null,
      },
      body,
    },
    state,
  }
}

describe('readBodyLimited', () => {
  it('returns the body when it is under the limit', async () => {
    const { req } = makeRequest({ totalBytes: 1000 })
    const out = await readBodyLimited(req, BODY_LIMIT_JSON)
    expect(out.byteLength).toBe(1000)
  })

  // ---------------------------------------------------- the cheap refusal ---

  it('refuses on a declared length over the limit WITHOUT reading a byte', async () => {
    // The property that makes the header worth checking at all: when it is
    // present and honest, nothing is allocated.
    const { req, state } = makeRequest({ totalBytes: 200 * 1024 * 1024 })

    await expect(readBodyLimited(req, BODY_LIMIT_UPLOAD)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    )
    expect(state.pulled).toBe(0)
  })

  // ------------------------------------------------- the actual control -----

  it('refuses a body with NO Content-Length at all — the chunked case', async () => {
    // A chunked request carries no length. A header-only check would let this
    // through entirely, which is the whole reason the counted read exists.
    const { req } = makeRequest({
      totalBytes: 4 * 1024 * 1024,
      declared: null,
    })

    await expect(readBodyLimited(req, 1024 * 1024)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    )
  })

  it('refuses a LYING Content-Length — the header is a claim, not a fact', async () => {
    const { req } = makeRequest({
      totalBytes: 4 * 1024 * 1024,
      declared: 10, // "trust me, it is ten bytes"
    })

    await expect(readBodyLimited(req, 1024 * 1024)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    )
  })

  it('a non-numeric Content-Length does not disable the counted read', async () => {
    const { req } = makeRequest({ totalBytes: 4 * 1024 * 1024, declared: null })
    const lying = {
      headers: { get: () => 'not-a-number' },
      body: req.body,
    }

    await expect(readBodyLimited(lying, 1024 * 1024)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    )
  })

  // ----------------------------------- and it STOPS reading when it refuses --

  it('stops pulling once the limit is crossed — it does not drain the stream', async () => {
    // THE ASSERTION THAT MAKES IT A LIMIT. Refusing after reading everything
    // would produce the right status code and the exact allocation this is
    // meant to prevent. 64MB offered, 1MB ceiling, 64KB chunks.
    const { req, state } = makeRequest({
      totalBytes: 64 * 1024 * 1024,
      chunkSize: 64 * 1024,
      declared: null,
    })

    await expect(readBodyLimited(req, 1024 * 1024)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    )

    // At most one chunk beyond the ceiling: the overrun is detected on the read
    // that crosses it, so the bound is limit + one chunk, not the whole body.
    expect(state.pulled).toBeLessThanOrEqual(1024 * 1024 + 64 * 1024)
    expect(state.pulled).toBeLessThan(64 * 1024 * 1024)
    expect(state.cancelled).toBe(true)
  })

  it('a body exactly at the limit is accepted, one byte over is not', async () => {
    const at = makeRequest({ totalBytes: 1024, chunkSize: 1024, declared: null })
    await expect(readBodyLimited(at.req, 1024)).resolves.toHaveProperty(
      'byteLength',
      1024,
    )

    const over = makeRequest({ totalBytes: 1025, chunkSize: 1025, declared: null })
    await expect(readBodyLimited(over.req, 1024)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    )
  })

  it('an absent body is an empty read, not an error', async () => {
    const out = await readBodyLimited(
      { headers: { get: () => null }, body: null },
      BODY_LIMIT_JSON,
    )
    expect(out.byteLength).toBe(0)
  })

  it('reassembles multi-chunk bodies in order', async () => {
    // Guards the copy loop: a wrong offset would silently corrupt every upload
    // large enough to arrive in more than one chunk.
    const parts = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]), new Uint8Array([6])]
    let i = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i >= parts.length) return c.close()
        c.enqueue(parts[i++])
      },
    })
    const out = await readBodyLimited(
      { headers: { get: () => null }, body },
      1024,
    )
    expect(Array.from(new Uint8Array(out))).toEqual([1, 2, 3, 4, 5, 6])
  })
})

describe('readTextLimited', () => {
  it('decodes under the limit and refuses over it', async () => {
    const text = 'hello world'
    const bytes = new TextEncoder().encode(text)
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(bytes)
        c.close()
      },
    })
    await expect(
      readTextLimited({ headers: { get: () => null }, body }, 1024),
    ).resolves.toBe(text)

    const big = makeRequest({ totalBytes: 4096, declared: null })
    await expect(readTextLimited(big.req, 1024)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    )
  })
})

describe('what the caller sees', () => {
  it('is a 413 with an explicit error, never a quiet empty success', async () => {
    // The silent-success family: a proxy that swallowed the refusal and returned
    // an empty 200 would surface to a user as "the upload worked, and the file
    // is empty". The status and the body both have to say no.
    const res = bodyTooLargeResponse(new BodyTooLargeError(BODY_LIMIT_UPLOAD, null))

    expect(res.status).toBe(413)
    const body = await res.json()
    expect(body.error).toMatch(/too large/i)
    expect(body.limit_bytes).toBe(BODY_LIMIT_UPLOAD)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })
})

describe('the ceilings sit at or above the API’s own', () => {
  // This bounds memory; it must not tighten the product's limits. If a ceiling
  // here dropped below what the API accepts, the ui would start refusing
  // requests that work today and the failure would look like a product change.
  it('upload ceiling clears multer’s 50MB', () => {
    expect(BODY_LIMIT_UPLOAD).toBeGreaterThan(50 * 1024 * 1024)
  })
  it('avatar ceiling clears multer’s 5MB', () => {
    expect(BODY_LIMIT_AVATAR).toBeGreaterThan(5 * 1024 * 1024)
  })
  it('json ceiling clears express.json’s 100kb default', () => {
    expect(BODY_LIMIT_JSON).toBeGreaterThan(100 * 1024)
  })
})
