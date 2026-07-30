/**
 * An absent roles claim must be LOUD, not silently empty.
 *
 * The jwt callback read
 *
 *     decoded.resource_access?.[CLIENT]?.roles ?? []
 *
 * which converts "the claim was absent" into "this user has no roles" with no signal
 * at all. That is the same shape as every bug removed from this estate in two days: a
 * fallback that turns a missing thing into a plausible empty thing.
 *
 * Two states that must be distinguishable but were not:
 *
 *   - a user genuinely holds no roles         -> [] is correct and expected
 *   - the mapper, client id or realm is wrong -> [] is a MISCONFIGURATION
 *
 * The second is exactly what happened in production for a day: an app whose
 * authorisation silently emptied while every health check passed. Empty is still the
 * value returned -- failing closed on permissions is right, since an empty role set
 * denies rather than grants -- but it must be observable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rolesFromAccessToken } from '@/auth-roles'

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
const tokenWith = (payload: unknown) => `h.${b64(payload)}.s`

describe('rolesFromAccessToken', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
  afterEach(() => { warn.mockRestore(); vi.unstubAllEnvs?.() })

  it('returns the client roles when the claim is present', () => {
    const t = tokenWith({ resource_access: { 'hill90-ui': { roles: ['admin', 'user'] } } })
    expect(rolesFromAccessToken(t)).toEqual(['admin', 'user'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('an EMPTY array is a legitimate answer and stays quiet', () => {
    // A user who holds no client roles is not a misconfiguration.
    const t = tokenWith({ resource_access: { 'hill90-ui': { roles: [] } } })
    expect(rolesFromAccessToken(t)).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('WARNS when resource_access is absent entirely', () => {
    const t = tokenWith({ sub: 'u1' })
    expect(rolesFromAccessToken(t)).toEqual([])
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls[0][0])).toMatch(/resource_access/)
  })

  it('WARNS when the client is missing from resource_access, and names it', () => {
    const t = tokenWith({ resource_access: { grafana: { roles: ['admin'] } } })
    expect(rolesFromAccessToken(t)).toEqual([])
    const msg = String(warn.mock.calls[0][0])
    expect(msg).toMatch(/hill90-ui/)
    // The clients that WERE present are the useful diagnostic.
    expect(msg).toMatch(/grafana/)
  })

  it('WARNS when roles is present but not an array', () => {
    const t = tokenWith({ resource_access: { 'hill90-ui': { roles: 'admin' } } })
    expect(rolesFromAccessToken(t)).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('never returns realm roles, even when the client claim is missing', () => {
    // The whole point of client roles: realm-role admin grants Grafana Admin and
    // OpenBao access, and must never be read as an app role.
    const t = tokenWith({ realm_access: { roles: ['admin'] }, realm_roles: ['admin'] })
    expect(rolesFromAccessToken(t)).toEqual([])
  })

  it('warns rather than throwing on an undecodable token', () => {
    expect(rolesFromAccessToken('not-a-jwt')).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('honours AUTH_KEYCLOAK_ID when the client is named differently', () => {
    vi.stubEnv('AUTH_KEYCLOAK_ID', 'other-client')
    const t = tokenWith({ resource_access: { 'other-client': { roles: ['user'] } } })
    expect(rolesFromAccessToken(t)).toEqual(['user'])
  })
})
