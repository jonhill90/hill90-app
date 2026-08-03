/**
 * Every proxied API response varies by session and must not be storable by a
 * shared cache.
 *
 * `proxyToApi` attaches the caller's own access token and returns whatever the
 * API answers for THAT user. It set no `Cache-Control` at all, and no
 * `Vary: Cookie` either — and RFC 9111 permits an intermediary to heuristically
 * cache a 200 that carries no freshness information. The same shape as
 * `/api/services/health` serving `public, max-age=10` (#134), one step milder:
 * there the directive invited storage, here nothing forbade it.
 *
 * No shared cache sits in front of hill90.com today — measured, `cf-ray` and
 * `cf-cache-status` are both absent and Traefik terminates TLS directly — so
 * this closes a latent hole rather than a live leak. It is still the cheaper end
 * of the trade: one header versus depending on nobody ever putting a CDN in
 * front of the site.
 *
 * The storage upload path is asserted separately because it does NOT go through
 * proxyToApi — it has its own fetch, and a fix applied only to the shared helper
 * would miss it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

let mockSession: unknown = { accessToken: 'tok' }

vi.mock('@/auth', () => ({
  auth: vi.fn(() => Promise.resolve(mockSession)),
}))

function jsonRequest(url: string, method = 'GET') {
  return {
    method,
    nextUrl: new URL(url),
    headers: new Headers(),
    text: async () => '',
    arrayBuffer: async () => new ArrayBuffer(0),
  } as never
}

const upstream = (body: unknown) => ({
  status: 200,
  headers: new Headers({ 'content-type': 'application/json' }),
  json: async () => body,
})

describe('proxied API responses are not storable by a shared cache', () => {
  beforeEach(() => {
    mockSession = { accessToken: 'tok' }
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('proxyToApi marks the response private and no-store', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(upstream({ ok: true })))
    const { proxyToApi } = await import('@/utils/api-proxy')

    const res = await proxyToApi(
      jsonRequest('https://hill90.com/api/agents'),
      '/agents',
    )

    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('the 401 refusal is not storable either', async () => {
    // A cached 401 would be served to a signed-in user, and a cached 200 to an
    // anonymous one. The refusal path returns before any fetch, so it needs the
    // header in its own right.
    mockSession = null
    vi.stubGlobal('fetch', vi.fn())
    const { proxyToApi } = await import('@/utils/api-proxy')

    const res = await proxyToApi(
      jsonRequest('https://hill90.com/api/agents'),
      '/agents',
    )

    expect(res.status).toBe(401)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('the storage upload route sets it too — it does not use proxyToApi', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(upstream({ key: 'a.txt' })))
    const mod = await import('@/app/api/storage/[...path]/route')

    const res = await mod.POST(
      jsonRequest('https://hill90.com/api/storage/buckets/chat-attachments/upload', 'POST'),
      { params: Promise.resolve({ path: ['buckets', 'chat-attachments', 'upload'] }) },
    )

    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('an SSE stream keeps its own no-cache and is not overwritten', async () => {
    // The streaming branch returns before the JSON one. Pinning it stops a later
    // edit from folding the two together and breaking live event delivery.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      body: null,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
    }))
    const { proxyToApi } = await import('@/utils/api-proxy')

    const res = await proxyToApi(
      jsonRequest('https://hill90.com/api/agents?follow=true'),
      '/agents',
      { sse: true },
    )

    expect(res.headers.get('Cache-Control')).toBe('no-cache')
  })
})
