/**
 * The agents proxy must not drop `X-Total-Count` on the way through.
 *
 * `GET /agents/:id/stats` and `/:id/artifacts` both set that header from their own
 * COUNT(*) — `agents.ts:2591` says so in as many words, "each count is its own
 * X-Total-Count, not a filter over one page (#188)". The ui's hand-rolled agents
 * proxy then returned the body without it, so a total computed correctly on the
 * server reached the browser as nothing.
 *
 * A HEADER DROPPED IN TRANSIT IS THE SAME DEFECT AS A TOTAL COMPUTED FROM THE
 * PAGE, relocated one hop. Either way the caller has a number it cannot trust, or
 * none. Three layers were changed this session to report real totals; one silent
 * hop at the end undoes all of it.
 *
 * THE FIXTURE MUST CARRY THE HEADER. Without it in the upstream response the
 * dropping and the forwarding versions return byte-identical objects, and the test
 * passes on the defect — the same fixture mistake as a total that agrees with
 * itself, a search count below the cap, an optimistic UI on a successful response,
 * and a succeeding command with a hardcoded exit code. Five this session.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockAuth = vi.fn()
vi.mock('@/auth', () => ({ auth: () => mockAuth() }))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { GET } from '@/app/api/agents/[...path]/route'

function upstream(body: unknown, headers: Record<string, string> = {}) {
  const h = new Headers({ 'content-type': 'application/json', ...headers })
  return {
    ok: true,
    status: 200,
    headers: h,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
    body: null,
  }
}

/** Matches the shape agents-proxy.test.ts already uses: the route reads nextUrl. */
const req = () =>
  ({
    method: 'GET',
    headers: { get: () => null },
    nextUrl: { searchParams: new URLSearchParams() },
  }) as never

const params = (path: string[]) => ({ params: Promise.resolve({ path }) })

beforeEach(() => {
  mockAuth.mockReset()
  mockFetch.mockReset()
  mockAuth.mockResolvedValue({ accessToken: 'tok', user: { roles: ['user'] } })
  process.env.API_URL = 'http://api:3000'
})
afterEach(() => {
  delete process.env.API_URL
})

describe('agents proxy header pass-through', () => {
  it('POSITIVE CONTROL: forwards X-Total-Count when the upstream sends it', async () => {
    // The header in the fixture IS the test. Without it both versions agree.
    mockFetch.mockResolvedValue(upstream({ total_inferences: 12 }, { 'x-total-count': '4217' }))

    const res = await GET(req(), params(['a1', 'stats']))

    expect(res.status).toBe(200)
    expect(res.headers.get('x-total-count')).toBe('4217')
    await expect(res.json()).resolves.toEqual({ total_inferences: 12 })
  })

  it('forwards it on the artifacts route too, not just stats', async () => {
    mockFetch.mockResolvedValue(
      upstream({ artifacts: [], earned_count: 0 }, { 'x-total-count': '9' }),
    )

    const res = await GET(req(), params(['a1', 'artifacts']))

    expect(res.headers.get('x-total-count')).toBe('9')
  })

  it('sends nothing when the upstream sent nothing — not an invented zero', async () => {
    // A fabricated "0" here would be its own confident-but-wrong number.
    mockFetch.mockResolvedValue(upstream({ ok: true }))

    const res = await GET(req(), params(['a1', 'stats']))

    expect(res.headers.get('x-total-count')).toBeNull()
  })

  it('still passes the upstream status through unchanged', async () => {
    // Guard rail: forwarding headers must not disturb what the caller is told
    // about success or failure.
    mockFetch.mockResolvedValue({
      ...upstream({ error: 'Agent not found' }),
      ok: false,
      status: 404,
    })

    const res = await GET(req(), params(['missing', 'stats']))

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({ error: 'Agent not found' })
  })
})
