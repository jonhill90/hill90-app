/**
 * The profile proxy must pass a bodiless response through, not turn it into a 502.
 *
 * route.ts special-cases 304 (`:72`) and then calls `res.json()` unconditionally
 * (`:76`). Any other status with an empty body throws `SyntaxError: Unexpected end of
 * JSON input`, which is caught at `:78` and reported as `502 API request failed` — with
 * the real cause only in the log as `[profile-proxy] Error:`.
 *
 * That became live when GET /profile/avatar started returning **204** for "this user has
 * no avatar" (#32). Measured in production: three consecutive logins, three 502s, and
 * four of those log lines per page load. The visible behaviour is unchanged only because
 * AuthButtons treats any non-ok response as "no avatar", so a 502 and a 204 look the same
 * to the user — which is exactly why it went unnoticed.
 *
 * The bug is the proxy's, not the api's: 204 with no body is a correct HTTP response.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/auth', () => ({ auth: vi.fn(async () => ({ accessToken: 'tok' })) }))

const makeReq = () =>
  ({
    method: 'GET',
    headers: { get: () => null },
    nextUrl: { searchParams: new URLSearchParams() },
    arrayBuffer: async () => new ArrayBuffer(0),
  }) as never
const params = Promise.resolve({ path: ['avatar'] })

function stubUpstream(status: number, body: string | null, contentType?: string) {
  const headers = new Map<string, string>()
  if (contentType) headers.set('content-type', contentType)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    status,
    ok: status < 400,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    body: null,
    text: async () => body ?? '',
    // matches a real Response: .json() on an empty body rejects
    json: async () => JSON.parse(body ?? ''),
  }))
}

describe('profile proxy: bodiless upstream responses', () => {
  let err: ReturnType<typeof vi.spyOn>
  beforeEach(() => { err = vi.spyOn(console, 'error').mockImplementation(() => {}) })
  afterEach(() => { err.mockRestore(); vi.unstubAllGlobals(); vi.resetModules() })

  it('passes a 204 through as 204, not 502', async () => {
    stubUpstream(204, '')
    const { GET } = await import('@/app/api/profile/[...path]/route')
    const res = await GET(makeReq(), { params })
    expect(res.status).toBe(204)
  })

  it('a 204 carries no body', async () => {
    stubUpstream(204, '')
    const { GET } = await import('@/app/api/profile/[...path]/route')
    const res = await GET(makeReq(), { params })
    expect(await res.text()).toBe('')
  })

  it('does not log a parse error for a legitimate empty body', async () => {
    stubUpstream(204, '')
    const { GET } = await import('@/app/api/profile/[...path]/route')
    await GET(makeReq(), { params })
    const logged = err.mock.calls.map((c) => String(c[0]) + String(c[1] ?? '')).join(' ')
    expect(logged).not.toMatch(/profile-proxy/)
  })

  it('still passes a JSON body through with its status', async () => {
    stubUpstream(200, '{"firstName":"Test"}', 'application/json')
    const { GET } = await import('@/app/api/profile/[...path]/route')
    const res = await GET(makeReq(), { params })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ firstName: 'Test' })
  })

  it('still passes a JSON ERROR body through with its status', async () => {
    // The api's dangling-avatar case: 404 with a real JSON body.
    stubUpstream(404, '{"error":"No avatar found"}', 'application/json')
    const { GET } = await import('@/app/api/profile/[...path]/route')
    const res = await GET(makeReq(), { params })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'No avatar found' })
  })

  it('still returns 304 with no body', async () => {
    stubUpstream(304, '')
    const { GET } = await import('@/app/api/profile/[...path]/route')
    const res = await GET(makeReq(), { params })
    expect(res.status).toBe(304)
  })

  it('a genuinely malformed body is still an error, not silently swallowed', async () => {
    // The guard must not become "ignore all parse failures". A 200 promising JSON and
    // delivering garbage is a real fault and must still surface.
    stubUpstream(200, 'Internal Server Error', 'application/json')
    const { GET } = await import('@/app/api/profile/[...path]/route')
    const res = await GET(makeReq(), { params })
    expect(res.status).toBe(502)
  })
})
