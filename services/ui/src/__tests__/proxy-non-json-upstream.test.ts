/**
 * A non-JSON upstream body must not erase the upstream status (#223).
 *
 * THE DEFECT. `JSON.parse` sat inside the same `try` as the `fetch`, so a body
 * that is not JSON landed in the same `catch` as a connection failure and the
 * caller got `502 {"error":"API request failed"}`. The api has no 404 handler,
 * so an unmatched path falls through to Express's default — measured as
 * `404 text/html` — and every `[...path]` proxy turned that into a 502. The
 * specific truth was available and thrown away, which is the family this
 * repository has spent the day removing.
 *
 * THE FIXTURE'S BODY IS NOT JSON, and that is the whole test design. With a
 * well-formed JSON error body the fixed and unfixed versions are identical:
 * both forward the status and both return the parsed body. The only fixture
 * that separates them is one the parser rejects, so every positive control here
 * sends HTML or plain text, and each is paired with a JSON twin that must
 * behave the same either way.
 *
 * THE BOUNDARY, asserted rather than assumed: the STATUS is surfaced and the
 * BODY is not. The consumer is a browser, and an upstream body can carry a
 * stack trace, an internal hostname, or a token echoed back in an error. A 502
 * that quotes an internal stack trace is a different defect from this one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

let mockSession: unknown = { accessToken: 'tok' }

vi.mock('@/auth', () => ({
  auth: vi.fn(() => Promise.resolve(mockSession)),
}))

function request(url = 'https://hill90.com/api/agents/nope') {
  return {
    method: 'GET',
    nextUrl: new URL(url),
    headers: new Headers(),
    text: async () => '',
    arrayBuffer: async () => new ArrayBuffer(0),
    body: null,
  } as never
}

/** What Express's default 404 handler actually sends — measured in #223. */
const EXPRESS_404_HTML =
  '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
  '<title>Error</title>\n</head>\n<body>\n<pre>Cannot GET /agents/nope</pre>\n</body>\n</html>\n'

function upstream(status: number, body: string, contentType = 'text/html; charset=utf-8') {
  return {
    status,
    headers: new Headers({ 'content-type': contentType }),
    body: null,
    text: async () => body,
  }
}

beforeEach(() => {
  mockSession = { accessToken: 'tok' }
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('proxyToApi — the status survives a body the parser rejects', () => {
  it('POSITIVE CONTROL: a 404 of HTML arrives as 404, not 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(upstream(404, EXPRESS_404_HTML)))
    const { proxyToApi } = await import('@/utils/api-proxy')

    const res = await proxyToApi(request(), '/agents/nope')

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.upstream_status).toBe(404)
    expect(body.error).toMatch(/non-JSON/i)
  })

  it('TWIN: a 404 of JSON is unchanged — this fixture cannot tell the versions apart', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(upstream(404, '{"error":"Agent not found"}', 'application/json')),
    )
    const { proxyToApi } = await import('@/utils/api-proxy')

    const res = await proxyToApi(request(), '/agents/nope')

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Agent not found' })
  })

  it('a 500 of plain text arrives as 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(upstream(500, 'Internal Server Error', 'text/plain')),
    )
    const { proxyToApi } = await import('@/utils/api-proxy')

    const res = await proxyToApi(request(), '/agents')

    expect(res.status).toBe(500)
    expect((await res.json()).upstream_status).toBe(500)
  })

  it('a 2xx whose body will not parse is 502, NOT a success', async () => {
    // A success status carrying an error envelope is the shape #260 was about.
    // "Bad Gateway" is the literal meaning of an invalid response from upstream.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(upstream(200, '<html>not json</html>')))
    const { proxyToApi } = await import('@/utils/api-proxy')

    const res = await proxyToApi(request(), '/agents')

    expect(res.status).toBe(502)
    expect((await res.json()).upstream_status).toBe(200)
  })

  it('a transport failure is still a generic 502 — there is no upstream status to report', async () => {
    // The distinction the old code collapsed: could not reach it, versus
    // reached it and could not read what it said.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    const { proxyToApi } = await import('@/utils/api-proxy')

    const res = await proxyToApi(request(), '/agents')

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toBe('API request failed')
    expect(body.upstream_status).toBeUndefined()
  })
})

describe('the boundary: the status is surfaced, the body is not', () => {
  const LEAKY =
    'Error: connect ECONNREFUSED 10.0.0.7:5432\n' +
    '    at /opt/hill90-app/services/api/src/db/pool.ts:31:11\n' +
    '    with token sk-live-abcdef0123456789'

  it('the upstream body does not reach the caller', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(upstream(500, LEAKY, 'text/plain')))
    const { proxyToApi } = await import('@/utils/api-proxy')

    const res = await proxyToApi(request(), '/agents')
    const text = await res.text()

    expect(text).not.toContain('sk-live')
    expect(text).not.toContain('10.0.0.7')
    expect(text).not.toContain('pool.ts')
    // What it does carry: the fact and the number.
    expect(JSON.parse(text)).toEqual({
      error: 'Upstream returned a non-JSON response',
      upstream_status: 500,
    })
  })

  it('but the body IS logged server-side, where the cause lives', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(upstream(500, LEAKY, 'text/plain')))
    const { proxyToApi } = await import('@/utils/api-proxy')

    await proxyToApi(request(), '/agents')

    const logged = err.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('non-JSON')
    expect(logged).toContain('ECONNREFUSED')
  })

  it('a very long body is truncated in the log rather than copied whole', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(upstream(500, 'x'.repeat(5000), 'text/plain')))
    const { proxyToApi } = await import('@/utils/api-proxy')

    await proxyToApi(request(), '/agents')

    const logged = err.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged.length).toBeLessThan(1200)
  })
})

describe('the three hand-written copies, because a fix to the helper alone would miss them', () => {
  it('the agents proxy forwards the status too', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(upstream(404, EXPRESS_404_HTML)))
    const { GET } = await import('@/app/api/agents/[...path]/route')

    const res = await GET(request(), { params: Promise.resolve({ path: ['nope'] }) } as never)

    expect(res.status).toBe(404)
    expect((await res.json()).upstream_status).toBe(404)
  })

  it('the profile proxy forwards the status too — it named it and still sent 502', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(upstream(404, EXPRESS_404_HTML)))
    const { GET } = await import('@/app/api/profile/[...path]/route')

    const res = await GET(request('https://hill90.com/api/profile/nope'), {
      params: Promise.resolve({ path: ['nope'] }),
    } as never)

    expect(res.status).toBe(404)
    expect((await res.json()).upstream_status).toBe(404)
  })

  it('the openapi proxy forwards the status too', async () => {
    // This route gates on an admin role before it ever fetches.
    mockSession = { accessToken: 'tok', user: { roles: ['admin'] } }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(upstream(404, EXPRESS_404_HTML)))
    const { GET } = await import('@/app/api/docs/openapi/route')

    const res = await GET()

    expect(res.status).toBe(404)
    expect((await res.json()).upstream_status).toBe(404)
  })
})
