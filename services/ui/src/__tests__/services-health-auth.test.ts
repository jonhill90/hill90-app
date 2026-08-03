/**
 * `/api/services/health` must require a session.
 *
 * THE DEFECT. This route probes API, AI, Keycloak and MCP on the internal
 * network and returns each one's name, up/down state and response time. It was
 * reachable anonymously in production:
 *
 *     GET https://hill90.com/api/services/health        -> 200, full inventory
 *     GET https://hill90.com/api/admin/services/health  -> 401
 *     GET https://hill90.com/api/agents                 -> 401
 *
 * Every sibling route under /api refused an anonymous caller. This one answered,
 * because Next's middleware matcher covers page paths only — `/dashboard`,
 * `/admin`, `/agents` and so on — and never `/api`. The other routes are gated
 * inside their handlers, through `proxyToApi` or an explicit `auth()` call. This
 * one had neither, so nothing was left to stop it.
 *
 * WHY AUTHENTICATION AND NOT THE ADMIN ROLE. The admin-only twin already exists
 * at /api/admin/services/health and is used by the admin page. This route is
 * used by DashboardClient, which any signed-in user reaches, so requiring
 * `admin` here would break the dashboard for ordinary users. The gate that
 * matches its caller is a session — the same gate `proxyToApi` applies.
 *
 * The Cache-Control directive moves with it. `public` invited any shared cache
 * in front of the site to store internal infrastructure state and hand it to the
 * next caller; a per-session response must be `private`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ORIGINAL_ENV = { ...process.env }

let mockSession: unknown = null

vi.mock('@/auth', () => ({
  auth: vi.fn(() => Promise.resolve(mockSession)),
}))

async function callGet(session: unknown) {
  mockSession = session
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 })
  vi.stubGlobal('fetch', fetchMock)
  vi.resetModules()

  const mod = await import('@/app/api/services/health/route')
  const res = await mod.GET()
  return { res, fetchMock }
}

describe('/api/services/health requires a session', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('refuses an anonymous caller with 401 — the production defect', async () => {
    const { res } = await callGet(null)
    expect(res.status).toBe(401)
  })

  it('refuses a session that carries no access token', async () => {
    // A half-established session is not a signed-in user. `proxyToApi` draws the
    // line at the access token rather than at the session object, and this route
    // must draw it in the same place or the two disagree about who is signed in.
    const { res } = await callGet({ user: { name: 'someone' } })
    expect(res.status).toBe(401)
  })

  it('probes NOTHING when the caller is anonymous', async () => {
    // The status code is only half of it. Answering 401 after having already
    // opened four internal connections still lets an anonymous caller drive
    // traffic into the internal network, and still leaks timing. The refusal has
    // to come first.
    const { fetchMock } = await callGet(null)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('serves the inventory to a signed-in user', async () => {
    const { res, fetchMock } = await callGet({ accessToken: 'tok' })
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalled()

    const body = await res.json()
    expect(Array.isArray(body.services)).toBe(true)
    expect(body.services.map((s: { name: string }) => s.name)).toEqual(
      ['API', 'AI', 'Keycloak', 'MCP'],
    )
  })

  it('does not require the admin role — the dashboard is not an admin page', async () => {
    // Guards the fix against being "tightened" into a copy of its admin twin,
    // which would 403 every ordinary user on /dashboard.
    const { res } = await callGet({ accessToken: 'tok', user: { roles: [] } })
    expect(res.status).toBe(200)
  })

  it('marks the response private, so no shared cache may serve it on', async () => {
    const { res } = await callGet({ accessToken: 'tok' })
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=10')
  })
})
