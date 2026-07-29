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

const FALLBACK_ISSUER = 'https://auth.hill90.com/realms/hill90';

/**
 * The OIDC issuer. In every deployed environment `KEYCLOAK_ISSUER` is set from
 * compose, so the fallback is inert there.
 */
export function getIssuer(override?: string): string {
  return override || process.env.KEYCLOAK_ISSUER || FALLBACK_ISSUER;
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
