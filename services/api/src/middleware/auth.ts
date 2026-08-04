import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

interface AuthOptions {
  issuer: string;
  getSigningKey: (header: jwt.JwtHeader) => Promise<string>;
}

export function createRequireAuth(opts: AuthOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.slice(7);

    try {
      const decoded = jwt.decode(token, { complete: true });
      if (!decoded || typeof decoded === 'string') {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }

      const signingKey = await opts.getSigningKey(decoded.header);

      const payload = jwt.verify(token, signingKey, {
        algorithms: ['RS256'],
        issuer: opts.issuer,
      }) as jwt.JwtPayload;

      if (typeof payload.exp !== 'number') {
        res.status(401).json({ error: 'Token missing exp claim' });
        return;
      }

      // A TOKEN WITH NO SUBJECT IS NOT A PRINCIPAL (#278).
      //
      // `req.user` is handed straight to the routes, and `user.sub` is read at 158
      // sites to answer "is this yours?" — `owner = $1`, `created_by = $1`, the
      // ownership scoping in agents and chat. When `sub` is undefined those reads
      // match nothing and return a clean empty answer, and those WRITES store NULL,
      // which is exactly how this codebase marks a PLATFORM resource only an admin
      // may create. Reproduced: a non-admin `POST /provider-connections` landed with
      // `created_by = NULL`, and the `if (platform && !isAdmin) 403` guard was never
      // reached because the request never claimed to be platform-scoped.
      //
      // WHY THIS IS SAFE TO REFUSE, checked rather than assumed:
      //   * Keycloak emits `sub` via the `basic` client scope. PRODUCTION's
      //     hill90-ui has it (`web-origins, acr, profile, roles, basic, email`,
      //     read 2026-08-04), so no production caller is affected.
      //   * every `requireAuth` mount is a human-facing product surface; the one
      //     router without it, `/internal/discord`, authenticates with a shared
      //     service token and never reaches this code;
      //   * `serviceAccountsEnabled` is false on both hill90-ui and hill90-api, so
      //     no client-credentials principal exists to lose (and one would carry the
      //     service account's own `sub` anyway);
      //   * agent tokens are Ed25519 and are already refused by `algorithms:
      //     ['RS256']` above — they authenticate to the model router, not here.
      //
      // WHAT IT DOES BREAK, deliberately: a LOCAL stack whose realm lacks `basic`
      // now gets a named 401 instead of silently writing NULL-owned rows. That is
      // the point — the local directory is wrong and was hiding it. See #278 for the
      // one-line fix to the local client.
      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        console.warn('[auth] token rejected — no sub claim; the issuer is not emitting it (Keycloak: the `basic` client scope)');
        res.status(401).json({ error: 'Token missing sub claim' });
        return;
      }

      (req as any).user = payload;
      next();
    } catch (err) {
      // THE CAUSE MUST SURVIVE. This was a bare `catch {}`, and it is why 623 logs
      // of this suite contained six 401s that could not be told apart: an expired
      // token, a token signed with the wrong key, and a request reaching a verifier
      // configured for a different issuer all produced the same silent 401.
      //
      // A failure that reports nothing is the same family as every defect chased in
      // docs/decisions/api-suite-flakiness.md.
      //
      // The token is NEVER logged. jsonwebtoken's name/message carry the cause and
      // no credential material: 'TokenExpiredError: jwt expired',
      // 'JsonWebTokenError: invalid signature', 'JsonWebTokenError: jwt issuer
      // invalid'. expiredAt is a timestamp, not a secret, and it is what separates
      // a genuinely stale token from clock skew.
      const e = err as Error & { expiredAt?: Date };
      const detail = e && e.name ? `${e.name}: ${e.message}` : 'unknown error';
      const when = e && e.expiredAt ? ` (expiredAt ${new Date(e.expiredAt).toISOString()})` : '';
      console.warn(`[auth] token rejected — ${detail}${when}`);
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

// Default JWKS-based key resolver for production
export function createJwksKeyResolver(jwksUri: string) {
  const client = jwksClient({
    jwksUri,
    cache: true,
    cacheMaxAge: 3600000,
  });

  return async (header: jwt.JwtHeader): Promise<string> => {
    if (!header.kid) {
      throw new Error('Token header missing kid');
    }
    const key = await client.getSigningKey(header.kid);
    return key.getPublicKey();
  };
}
