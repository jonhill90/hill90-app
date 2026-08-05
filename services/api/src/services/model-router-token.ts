/**
 * Model-router token generation.
 *
 * Generates Ed25519 JWTs for agent containers to authenticate with the AI service
 * (model-router). Mirrors the AKM token pattern but with audience 'hill90-model-router'.
 * JWT carries identity only — no model scopes in claims.
 */

import * as crypto from 'crypto';

const MODEL_ROUTER_URL = process.env.MODEL_ROUTER_URL || 'http://ai:8000';
const MODEL_ROUTER_SIGNING_PRIVATE_KEY = process.env.MODEL_ROUTER_SIGNING_PRIVATE_KEY;

let cachedPrivateKey: crypto.KeyObject | null = null;

function getPrivateKey(): crypto.KeyObject {
  if (cachedPrivateKey) return cachedPrivateKey;
  if (!MODEL_ROUTER_SIGNING_PRIVATE_KEY) {
    throw new Error('MODEL_ROUTER_SIGNING_PRIVATE_KEY not configured');
  }
  cachedPrivateKey = crypto.createPrivateKey(MODEL_ROUTER_SIGNING_PRIVATE_KEY.replace(/\\n/g, '\n'));
  return cachedPrivateKey;
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64url');
}

export interface ModelRouterTokenResult {
  token: string;
  jti: string;
  refreshSecret: string;
  expiresAt: number;
}

const WORKLOAD_V2 = process.env.WORKLOAD_PRINCIPAL_V2 === 'true';

export interface ModelRouterTokenOptions {
  agentSlug: string;
  agentUuid: string;
  owner: string;
  scopes?: string[];
  correlationId?: string;
}

/**
 * Generate an Ed25519 JWT for an agent to authenticate with the model-router.
 * AI-115: Now emits WorkloadClaims (principal_type, scopes, agent_slug when V2).
 */
let cachedPublicKey: crypto.KeyObject | undefined;

/** Derived from the private key — Ed25519 makes this exact, not an approximation. */
function getPublicKey(): crypto.KeyObject {
  if (!cachedPublicKey) cachedPublicKey = crypto.createPublicKey(getPrivateKey());
  return cachedPublicKey;
}

export async function generateAgentModelRouterToken(
  agentIdOrOpts: string | ModelRouterTokenOptions,
  owner?: string,
): Promise<ModelRouterTokenResult> {
  let agentSlug: string;
  let agentUuid: string;
  let effectiveOwner: string;
  let effectiveScopes: string[];
  let correlationId: string | undefined;

  if (typeof agentIdOrOpts === 'string') {
    // Legacy call: generateAgentModelRouterToken(agentId, owner)
    agentSlug = agentIdOrOpts;
    agentUuid = agentIdOrOpts;
    effectiveOwner = owner!;
    effectiveScopes = [];
  } else {
    agentSlug = agentIdOrOpts.agentSlug;
    agentUuid = agentIdOrOpts.agentUuid;
    effectiveOwner = agentIdOrOpts.owner;
    effectiveScopes = agentIdOrOpts.scopes || [];
    correlationId = agentIdOrOpts.correlationId;
  }

  const privateKey = getPrivateKey();
  const jti = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 3600; // 1 hour

  // AI-115: WorkloadClaims — sub is UUID when V2, slug when V1
  const claims: Record<string, unknown> = {
    sub: WORKLOAD_V2 ? agentUuid : agentSlug,
    principal_type: 'agent',
    iss: 'hill90-api',
    aud: 'hill90-model-router',
    exp: expiresAt,
    iat: now,
    jti,
    owner: effectiveOwner,
    scopes: effectiveScopes,
  };
  if (WORKLOAD_V2) claims.agent_slug = agentSlug;
  if (correlationId) claims.correlation_id = correlationId;

  const header = base64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(claims));

  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign(null, Buffer.from(signingInput), privateKey);
  const token = `${signingInput}.${signature.toString('base64url')}`;

  const refreshSecret = crypto.randomUUID();

  return { token, jti, refreshSecret, expiresAt };
}

/**
 * Get the model-router env vars to inject into an agent container.
 * Includes refresh URL and secret for token renewal before expiry.
 */
export function getModelRouterEnvVars(tokenResult: ModelRouterTokenResult): string[] {
  const API_URL = process.env.API_INTERNAL_URL || 'http://api:3000';
  return [
    `MODEL_ROUTER_TOKEN=${tokenResult.token}`,
    // AI_SERVICE_URL is the name hill90/agentbox:latest actually reads
    // (chat.py:58, confirmed against the running image — app#355).
    // MODEL_ROUTER_URL is kept alongside it for one release so a container
    // still running an older image, which never read AI_SERVICE_URL, is
    // unaffected. Both carry the same value; there is only one URL.
    `AI_SERVICE_URL=${MODEL_ROUTER_URL}`,
    `MODEL_ROUTER_URL=${MODEL_ROUTER_URL}`,
    `MODEL_ROUTER_REFRESH_URL=${API_URL}/internal/model-router/refresh-token`,
    `MODEL_ROUTER_REFRESH_SECRET=${tokenResult.refreshSecret}`,
  ];
}

/**
 * Check if model-router integration is configured.
 */
/**
 * Verify a model-router JWT this service issued.
 *
 * The signing key is Ed25519, so the public half is DERIVED from the private
 * key already configured here — verification needs no new environment
 * variable and no key distribution. That is why this can live next to the
 * signer instead of waiting on config.
 *
 * `allowExpired` exists for the refresh flow, which is defined by the token
 * being at or past its expiry. It disables the `exp` check and NOTHING else:
 * signature, algorithm, issuer and audience are all still enforced. This
 * mirrors the knowledge service's `verify_agent_token(..., allow_expired=True)`,
 * which is the sibling this file's own header says it mirrors.
 */
export function verifyModelRouterToken(
  token: string,
  opts: { allowExpired?: boolean } = {},
): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed JWT: expected three segments');
  const [headerB64, payloadB64, signatureB64] = parts;

  // The algorithm is checked BEFORE the signature, deliberately. A token
  // claiming `alg: none` with an empty signature is the canonical JWT forgery,
  // and it must be refused for being the wrong algorithm rather than reaching
  // a verify call whose behaviour on an empty signature we would have to
  // reason about.
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
  if (header.alg !== 'EdDSA') {
    throw new Error(`unexpected JWT alg: ${String(header.alg)} (expected EdDSA)`);
  }

  const signed = crypto.verify(
    null,
    Buffer.from(`${headerB64}.${payloadB64}`),
    getPublicKey(),
    Buffer.from(signatureB64, 'base64url'),
  );
  if (!signed) throw new Error('JWT signature does not verify');

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
  if (payload.iss !== 'hill90-api') {
    throw new Error(`unexpected issuer: ${String(payload.iss)}`);
  }
  if (payload.aud !== 'hill90-model-router') {
    throw new Error(`unexpected audience: ${String(payload.aud)}`);
  }
  if (!opts.allowExpired) {
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && payload.exp < now) {
      throw new Error('token has expired');
    }
  }
  return payload;
}

export function isModelRouterConfigured(): boolean {
  return !!MODEL_ROUTER_SIGNING_PRIVATE_KEY;
}
