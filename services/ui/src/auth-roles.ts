/**
 * The app's roles, read from the access token's client-role claim.
 *
 * WHY THIS IS NOT AN INLINE `?? []`
 *
 * The jwt callback used to read
 *
 *     decoded.resource_access?.[CLIENT]?.roles ?? []
 *
 * which collapses two very different situations into one silent answer:
 *
 *   - the user genuinely holds no client roles   -> [] is correct
 *   - the mapper, client id or realm is wrong    -> [] is a MISCONFIGURATION
 *
 * The second is what production ran on for a day: authorisation silently empty while
 * every health check passed. Empty is still what we return, because failing closed on
 * permissions denies rather than grants — but it must be possible to tell the two
 * apart afterwards, and a log line is the cheapest way to do that.
 *
 * Realm roles are never consulted, deliberately. In the shared `platform` realm the
 * realm roles `admin` and `user` grant Grafana Admin and OpenBao access, so reading
 * them here would make every app admin a platform admin.
 */

const CLIENT = () => process.env.AUTH_KEYCLOAK_ID || 'hill90-ui'

export function rolesFromAccessToken(accessToken?: string): string[] {
  const client = CLIENT()

  if (!accessToken) {
    console.warn(
      `[auth] no access token to read roles from; treating ${client} roles as empty`,
    )
    return []
  }

  let decoded: Record<string, unknown>
  try {
    decoded = JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64url').toString(),
    )
  } catch {
    console.warn(
      `[auth] access token payload could not be decoded; treating ${client} roles as empty`,
    )
    return []
  }

  const resourceAccess = decoded.resource_access as
    | Record<string, { roles?: unknown }>
    | undefined

  if (!resourceAccess) {
    console.warn(
      `[auth] token carries no resource_access claim, so ${client} roles are empty. ` +
        `Expected the realm's stock "roles" client scope to emit ` +
        `resource_access.${client}.roles. This is a configuration problem, not a ` +
        `user without permissions.`,
    )
    return []
  }

  const entry = resourceAccess[client]
  if (!entry) {
    console.warn(
      `[auth] resource_access has no entry for ${client}, so its roles are empty. ` +
        `Clients present in the token: ${Object.keys(resourceAccess).join(', ') || '<none>'}. ` +
        `Check AUTH_KEYCLOAK_ID and that the user holds client roles on that client.`,
    )
    return []
  }

  if (!Array.isArray(entry.roles)) {
    console.warn(
      `[auth] resource_access.${client}.roles is ${typeof entry.roles}, not an array; ` +
        `treating as empty.`,
    )
    return []
  }

  // An empty array here is a legitimate answer: a user with no client roles. It is
  // deliberately NOT warned about, so the warnings above stay meaningful.
  return entry.roles as string[]
}
