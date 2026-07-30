/**
 * One place that knows the issuer and the JWKS URI.
 *
 * These two lines were copied into three files (`app.ts`, `index.ts`,
 * `routes/profile.ts`), each with its own hardcoded fallback to
 * `https://auth.hill90.com/realms/hill90`. Three copies of a URL that has to
 * change together is how one of them gets missed.
 *
 * Behaviour is deliberately unchanged, including the fallback. See
 * `docs/runbooks/one-keycloak-migration.md` §8 — whether that fallback should
 * exist at all is tied to the still-open choice of realm name, and is not a
 * decision this refactor makes.
 */

/**
 * The OIDC issuer. Required — there is deliberately NO fallback.
 *
 * There used to be one, to `https://auth.hill90.com/realms/hill90`. That realm no
 * longer exists, and repointing the fallback at the real realm would be worse than
 * deleting it: it would become silently correct, so a service started with no
 * KEYCLOAK_ISSUER at all would appear to work. Throwing means the container fails
 * its healthcheck and the deploy fails, which is the loud early failure this estate
 * keeps rediscovering it needs. Every compose file that runs this service sets it.
 */
export function getIssuer(override?: string): string {
  const issuer = override || process.env.KEYCLOAK_ISSUER;
  if (!issuer) {
    throw new Error(
      'KEYCLOAK_ISSUER is not set. It has no default: a default would make a ' +
      'misconfigured service look healthy. Set it to ' +
      'https://auth.hill90.com/realms/<realm>.',
    );
  }
  return issuer;
}

/**
 * The client whose CLIENT roles carry the app's authorisation.
 */
export function getClientId(): string {
  return process.env.KEYCLOAK_CLIENT_ID || 'hill90-ui';
}

/**
 * The app's roles, read from `resource_access.<client>.roles`.
 *
 * WHY NOT `realm_roles`, WHICH EVERY CALLER USED TO READ
 *
 * The app now lives in the shared `platform` realm, where realm roles `admin` and
 * `user` already exist and already mean something else: Hill90's
 * docker-compose.observability.yml:122 maps realm role `admin` to Grafana Admin, and
 * scripts/vault.sh:420 binds `realm_roles: [admin]` for OpenBao. Reusing realm roles
 * would make every app admin a platform admin.
 *
 * Client roles on `hill90-ui` are a different namespace, so that cannot happen — by
 * construction rather than by naming convention. The stock `roles` client scope
 * already emits `resource_access.<client>.roles`, so no custom mapper exists to be
 * forgotten.
 *
 * THERE IS DELIBERATELY NO FALLBACK TO `realm_roles`. It would be a privilege hole,
 * not a convenience: Hill90's `hill90-vault` client has a mapper that emits
 * `realm_roles` from REALM roles, so a vault token held by a platform admin would be
 * read here as app admin.
 */
export function rolesFrom(payload: unknown): string[] {
  const ra = (payload as any)?.resource_access?.[getClientId()]?.roles;
  return Array.isArray(ra) ? ra : [];
}

/**
 * The JWKS URI, derived from the issuer.
 *
 * `KEYCLOAK_JWKS_URI` is still honoured because local development needs it: an
 * app container cannot resolve the browser-facing Traefik hostname, so
 * `deploy/compose/overrides/local.api.yml` sets it deliberately and is marked
 * `DIVERGENCE-INTENTIONAL`. It is no longer set in production — see PR #26 —
 * where the derived value is what runs.
 */
export function getJwksUri(issuer: string = getIssuer()): string {
  return process.env.KEYCLOAK_JWKS_URI || `${issuer}/protocol/openid-connect/certs`;
}
