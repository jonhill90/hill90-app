import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * The UI proxy was the second hop that silently dropped X-Total-Count.
 *
 * knowledge set it, the api forwarded it, and this proxy rebuilt the response
 * with `NextResponse.json(data, { status, headers: NO_SHARED_CACHE })` — so
 * the header died one hop from the component that needed it. Two
 * header-dropping proxies, not one (#180).
 */

vi.mock('@/auth', () => ({ auth: async () => ({ accessToken: 'tok' }) }))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function upstream(headers: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    status: 200,
    ok: true,
    body: null,
    text: async () => JSON.stringify([{ id: 'e1' }]),
    headers: { get: (n: string) => lower[n.toLowerCase()] ?? null },
  }
}

function request(url = 'http://ui/api/knowledge/entries?agent_id=a&limit=2') {
  const u = new URL(url)
  return {
    method: 'GET',
    nextUrl: u,
    headers: { get: () => null },
  } as never
}

describe('proxyToApi forwards X-Total-Count', () => {
  beforeEach(() => mockFetch.mockReset())

  it('passes the upstream total through to the browser', async () => {
    mockFetch.mockResolvedValue(upstream({ 'X-Total-Count': '40000', 'Content-Type': 'application/json' }))
    const { proxyToApi } = await import('@/utils/api-proxy')

    const res = await proxyToApi(request(), '/knowledge/entries')

    expect(res.headers.get('X-Total-Count')).toBe('40000')
  })

  it('still sets the private-cache header it already set', async () => {
    mockFetch.mockResolvedValue(upstream({ 'X-Total-Count': '40000' }))
    const { proxyToApi } = await import('@/utils/api-proxy')

    const res = await proxyToApi(request(), '/knowledge/entries')

    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('omits the header when the upstream did not send one', async () => {
    mockFetch.mockResolvedValue(upstream({}))
    const { proxyToApi } = await import('@/utils/api-proxy')

    const res = await proxyToApi(request(), '/knowledge/entries')

    // Absent, not zero: "no total reported" and "there are none" are
    // different claims, and only one of them is true here.
    expect(res.headers.get('X-Total-Count')).toBeNull()
  })

  it('does not forward upstream body-framing headers, which describe bytes we re-serialised', async () => {
    mockFetch.mockResolvedValue(
      upstream({ 'X-Total-Count': '7', 'Content-Length': '999999', 'Content-Encoding': 'gzip' }),
    )
    const { proxyToApi } = await import('@/utils/api-proxy')

    const res = await proxyToApi(request(), '/knowledge/entries')

    expect(res.headers.get('X-Total-Count')).toBe('7')
    expect(res.headers.get('Content-Encoding')).toBeNull()
  })

  it('forwards the query string, so limit and offset reach the api', async () => {
    mockFetch.mockResolvedValue(upstream({ 'X-Total-Count': '40000' }))
    const { proxyToApi } = await import('@/utils/api-proxy')

    await proxyToApi(request('http://ui/api/knowledge/entries?agent_id=a&limit=2&offset=4'), '/knowledge/entries')

    const called = String(mockFetch.mock.calls[0][0])
    expect(called).toContain('limit=2')
    expect(called).toContain('offset=4')
  })
})
