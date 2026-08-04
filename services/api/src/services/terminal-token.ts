import * as jwt from 'jsonwebtoken';
import { rolesFrom } from '../middleware/keycloak-config';

/**
 * Verify the bearer token presented on the WebSocket terminal upgrade.
 *
 * EXTRACTED FROM index.ts so it can be tested. It lived inline in the startup
 * function, which meant the most privileged surface in this service — a live shell
 * inside an agent container — had a verifier nothing could exercise.
 *
 * A REFUSAL SAYS WHY. This was `catch { return null }`: an expired token, one signed
 * with the wrong key, one from another issuer and one that was never a JWT all
 * produced the same silent `null`, and an operator watching a user fail to open a
 * terminal had nothing to look at. That is the defect `middleware/auth.ts` fixed on
 * 2026-08-03 (#114) — "623 logs of this suite contained six 401s that could not be
 * told apart" — surviving in a second place because the fix went to one file.
 *
 * THE TOKEN IS NEVER LOGGED. jsonwebtoken's name and message carry the cause and no
 * credential material: `TokenExpiredError: jwt expired`, `JsonWebTokenError: invalid
 * signature`, `JsonWebTokenError: jwt issuer invalid`.
 */
export interface TerminalPrincipal {
  sub: string;
  roles: string[];
  exp: number;
}

export interface TerminalTokenOptions {
  issuer: string;
  getSigningKey: (header: jwt.JwtHeader) => Promise<string>;
}

export async function verifyTerminalToken(
  token: string,
  opts: TerminalTokenOptions
): Promise<TerminalPrincipal | null> {
  const refuse = (reason: string): null => {
    console.warn(`[terminal-proxy] token rejected — ${reason}`);
    return null;
  };

  try {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === 'string') {
      return refuse('not a decodable JWT (malformed or not three segments)');
    }

    const signingKey = await opts.getSigningKey(decoded.header);
    const payload = jwt.verify(token, signingKey, {
      algorithms: ['RS256'],
      issuer: opts.issuer,
    }) as jwt.JwtPayload;

    if (typeof payload.exp !== 'number') {
      return refuse('no exp claim — the proxy cannot end the session with the credential');
    }

    // rolesFrom() reads ONLY resource_access.<client>.roles. This used to read
    // realm_access.roles FIRST, which in the shared platform realm would honour a
    // platform admin's realm role `admin` here.
    const roles: string[] = rolesFrom(payload);

    // exp is passed through, not just checked. The proxy ends the session when the
    // credential does; without this it had no way to know when that was.
    //
    // NOTE, and it is deliberately left as it was: `sub` still falls back to ''.
    // #306 makes the HTTP boundary refuse a token with no `sub`; whether this path
    // should do the same is that issue's question, not this one's, and changing it
    // here would split the decision across two pull requests.
    return { sub: payload.sub || '', roles, exp: payload.exp };
  } catch (err) {
    const e = err as Error & { expiredAt?: Date };
    const detail = e && e.name ? `${e.name}: ${e.message}` : 'unknown error';
    const when = e && e.expiredAt ? ` (expiredAt ${new Date(e.expiredAt).toISOString()})` : '';
    return refuse(`${detail}${when}`);
  }
}
