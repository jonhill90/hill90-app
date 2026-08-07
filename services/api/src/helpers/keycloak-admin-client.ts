/**
 * Keycloak admin API client for app#500's user-management surface.
 *
 * Authenticates as the `hill90-realm-admin` service account (client_credentials
 * grant — a different Keycloak toggle from Direct Access Grants, which stays
 * disabled everywhere) via KEYCLOAK_REALM_ADMIN_CLIENT_ID/SECRET. That client's
 * service account holds exactly `view-users` and `view-clients` on
 * `realm-management` — never `manage-users`, never `realm-admin`. See app#500's
 * design comment for why those two are sufficient for a read-only user list and
 * why even the future write slice never needs more than `manage-users` on top.
 *
 * FAILS LOUD, NOT SILENT, when the credential is absent. This client does not
 * exist in the production realm yet — that is a deliberate, separate decision
 * (creating a service account with realm-management rights on the live identity
 * provider is Jon's call, not something that ships inside a feature PR) — so an
 * admin visiting this page in production today gets a clear 503 explaining
 * exactly that, not an empty table that looks like "there are no users". An
 * empty-list-from-a-missing-credential is this estate's own most-repeated defect
 * shape (CONTRIBUTING.md, "The Other Half: An Operation That Fails and Reports
 * Success") and this file exists specifically not to add another instance of it.
 */
import { getIssuer } from '../middleware/keycloak-config';

export class KeycloakAdminNotConfiguredError extends Error {
  constructor() {
    super(
      'KEYCLOAK_REALM_ADMIN_CLIENT_ID / KEYCLOAK_REALM_ADMIN_CLIENT_SECRET are not ' +
      'set. This is expected in production until the hill90-realm-admin service ' +
      'account is created on the live Keycloak and its secret is added to SOPS ' +
      '(app#500) — it is not yet, deliberately. There is nothing to fall back to.',
    );
    this.name = 'KeycloakAdminNotConfiguredError';
  }
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;

function getClientId(): string {
  const id = process.env.KEYCLOAK_REALM_ADMIN_CLIENT_ID;
  if (!id) throw new KeycloakAdminNotConfiguredError();
  return id;
}

function getClientSecret(): string {
  const secret = process.env.KEYCLOAK_REALM_ADMIN_CLIENT_SECRET;
  if (!secret) throw new KeycloakAdminNotConfiguredError();
  return secret;
}

/**
 * The base URL admin API calls are actually reachable at from inside this
 * container. Defaults to the issuer's own origin (correct in production: the
 * app is a tenant with no internal shortcut to Hill90's Keycloak, so the
 * externally-reachable https://auth.hill90.com IS the right address — the same
 * reasoning docker-compose.api.yml already documents for why KEYCLOAK_JWKS_URI
 * is deliberately unset there). KEYCLOAK_ADMIN_URL exists only to override this
 * for --standalone local dev, where the api container must reach the keycloak
 * container as http://keycloak:8080, not through the browser-facing
 * localhost:18080 the issuer carries — mirroring KEYCLOAK_JWKS_URI's existing
 * override for exactly the same local-only reachability gap.
 */
function getAdminBaseUrl(): string {
  if (process.env.KEYCLOAK_ADMIN_URL) return process.env.KEYCLOAK_ADMIN_URL;
  const issuer = getIssuer();
  return issuer.slice(0, issuer.indexOf('/realms/'));
}

function getRealm(): string {
  const issuer = getIssuer();
  const marker = '/realms/';
  const idx = issuer.indexOf(marker);
  if (idx === -1) {
    throw new Error(`KEYCLOAK_ISSUER does not contain ${marker}: ${issuer}`);
  }
  return issuer.slice(idx + marker.length);
}

async function fetchServiceAccountToken(): Promise<CachedToken> {
  const base = getAdminBaseUrl();
  const realm = getRealm();
  const res = await fetch(`${base}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: getClientId(),
      client_secret: getClientSecret(),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Keycloak client_credentials grant failed (${res.status}) for ` +
      `hill90-realm-admin: ${body}`,
    );
  }

  const json = (await res.json()) as { access_token: string; expires_in: number };
  return {
    token: json.access_token,
    // Refresh 30s early so a request never races an expiry mid-flight.
    expiresAt: Date.now() + (json.expires_in - 30) * 1000,
  };
}

async function getServiceAccountToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }
  cachedToken = await fetchServiceAccountToken();
  return cachedToken.token;
}

async function adminApiFetch(path: string): Promise<Response> {
  const token = await getServiceAccountToken();
  const base = getAdminBaseUrl();
  const realm = getRealm();
  return fetch(`${base}/admin/realms/${realm}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

export interface KeycloakUser {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled: boolean;
}

export interface KeycloakClientRole {
  id: string;
  name: string;
}

/** Every user in the realm. Keycloak paginates at 100 by default server-side. */
export async function listUsers(): Promise<KeycloakUser[]> {
  const users: KeycloakUser[] = [];
  const pageSize = 100;
  for (let first = 0; ; first += pageSize) {
    const res = await adminApiFetch(`/users?first=${first}&max=${pageSize}&briefRepresentation=true`);
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Keycloak GET /users failed (${res.status}): ${body}`);
    }
    const page = (await res.json()) as KeycloakUser[];
    users.push(...page);
    if (page.length < pageSize) break;
  }
  return users;
}

/** hill90-ui's own client UUID — needed before its role mappings are reachable at all. */
export async function getClientUuid(clientId: string): Promise<string> {
  const res = await adminApiFetch(`/clients?clientId=${encodeURIComponent(clientId)}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Keycloak GET /clients failed (${res.status}): ${body}`);
  }
  const clients = (await res.json()) as { id: string; clientId: string }[];
  const match = clients.find((c) => c.clientId === clientId);
  if (!match) {
    throw new Error(`No client found in the realm with clientId=${clientId}`);
  }
  return match.id;
}

/** The client roles a single user currently holds on the given client. */
export async function getUserClientRoles(
  userId: string,
  clientUuid: string,
): Promise<KeycloakClientRole[]> {
  const res = await adminApiFetch(`/users/${userId}/role-mappings/clients/${clientUuid}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Keycloak GET user role-mappings failed (${res.status}): ${body}`);
  }
  return (await res.json()) as KeycloakClientRole[];
}
