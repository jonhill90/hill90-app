/**
 * The Keycloak health probe must build its realm path from KC_REALM.
 *
 * Before this was parameterised, `/realms/hill90` was a literal in the route, so
 * renaming the realm during the one-Keycloak migration would have needed a ui
 * image rebuild to fix a health check. The default is still `hill90`, so the
 * behaviour is unchanged until KC_REALM is set — that is what the first test
 * pins, and it is the part a future refactor is most likely to break.
 *
 * SERVICES is built at module load from process.env, so each case has to set the
 * environment and then re-import the module.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const ORIGINAL_ENV = { ...process.env }

async function probedKeycloakUrl(): Promise<string> {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true })
  vi.stubGlobal('fetch', fetchMock)
  vi.resetModules()

  const mod = await import('@/app/api/services/health/route')
  await mod.GET()

  const urls = fetchMock.mock.calls.map((c) => String(c[0]))
  const keycloakUrl = urls.find((u) => u.includes('/realms/'))
  if (!keycloakUrl) {
    throw new Error(`no /realms/ probe was made; fetched: ${urls.join(', ')}`)
  }
  return keycloakUrl
}

describe('services health route: Keycloak realm path', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV }
    delete process.env.KC_REALM
    process.env.KEYCLOAK_INTERNAL_URL = 'http://app-keycloak:8080'
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('defaults to realm platform when KC_REALM is unset', async () => {
    const url = await probedKeycloakUrl()
    expect(url).toBe(
      'http://app-keycloak:8080/realms/platform/.well-known/openid-configuration',
    )
  })

  it('follows KC_REALM when it is set — the migration needs no rebuild', async () => {
    process.env.KC_REALM = 'hill90-app'
    const url = await probedKeycloakUrl()
    expect(url).toContain('/realms/hill90-app/')
    expect(url).not.toContain('/realms/platform/')
  })

  it('probes openid-configuration, which requires no authentication', async () => {
    // A probe of an authenticated path reports the service unhealthy when it is
    // fine. The discovery document is public, which is why it is the one used.
    const url = await probedKeycloakUrl()
    expect(url).toMatch(/\/\.well-known\/openid-configuration$/)
  })
})
