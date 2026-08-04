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

    // A TOKEN WITH NO SUBJECT IS NOT A PRINCIPAL (#313, following #306).
    //
    // This boundary must not be more permissive than the HTTP one #306 already
    // closed — both are the same claim, that the caller is identifiable, and a
    // terminal session with no identifiable owner is worse than a request with
    // one: it persists and does things after this check has passed. Before this,
    // `sub` fell back to '', which reached `isParticipant(threadId, '')` in
    // terminal-proxy.ts — reliably false since no real participant row ever has
    // an empty participant_id, so the caller was refused, but with a 403
    // "not a participant" instead of a 401 naming the actual defect: the
    // credential itself carried no identity. An ADMIN token with no `sub` was
    // worse — both uses of `user.sub` in terminal-proxy.ts are skipped for
    // admins, so it sailed through with no consequence at all.
    //
    // REFUSED HERE, AT VERIFY TIME — not downstream in terminal-proxy.ts. A
    // sub-less token must never reach `wss.handleUpgrade`; refusing after the
    // socket is already upgraded would be a different and worse thing than
    // refusing before it.
    //
    // WHAT TODAY'S EXPOSURE ACTUALLY IS: production's hill90-ui carries the
    // `basic` client scope (#278, #306), so no production token lacks `sub`.
    // This path is reachable on a misconfigured or local realm only — the same
    // bound #306 stated for the HTTP boundary. That bound is real, not a reason
    // to leave this boundary looser than the one already closed.
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      return refuse('no sub claim — the caller cannot be identified');
    }

    // rolesFrom() reads ONLY resource_access.<client>.roles. This used to read
    // realm_access.roles FIRST, which in the shared platform realm would honour a
    // platform admin's realm role `admin` here.
    const roles: string[] = rolesFrom(payload);

    // exp is passed through, not just checked. The proxy ends the session when the
    // credential does; without this it had no way to know when that was.
    return { sub: payload.sub, roles, exp: payload.exp };
  } catch (err) {
    const e = err as Error & { expiredAt?: Date };
    const detail = e && e.name ? `${e.name}: ${e.message}` : 'unknown error';
    const when = e && e.expiredAt ? ` (expiredAt ${new Date(e.expiredAt).toISOString()})` : '';
    return refuse(`${detail}${when}`);
  }
}
