/**
 * Wires the real config into `attachTerminalProxy` — extracted from `index.ts`
 * so the wiring itself is importable and testable (#313).
 *
 * `index.ts` runs `dieOnStartupFailure(start())` at module load, so nothing in
 * it can be imported by a test without also running migrations and opening a
 * database connection. This file has no side effects at import time; it is a
 * function `index.ts` calls, not a script.
 *
 * BEFORE THIS EXTRACTION, no test could tell the difference between the right
 * issuer and key resolver reaching `attachTerminalProxy` and the wrong ones —
 * `terminal-upgrade.test.ts` and `terminal-session-endings.test.ts` both
 * construct their own `verifyToken`, so a future edit here that passed the
 * wrong `issuer` into `getJwksUri` would leave every existing terminal test
 * green. See `terminal-wiring.test.ts` for the control that closes that gap,
 * including a demonstration that it actually goes red on the wrong wiring.
 */
import type { Server } from 'http';
import { attachTerminalProxy, TerminalProxyHandle } from './terminal-proxy';
import { verifyTerminalToken } from './terminal-token';
import { createJwksKeyResolver } from '../middleware/auth';
import { getIssuer, getJwksUri } from '../middleware/keycloak-config';

export function attachTerminalProxyFromConfig(server: Server): TerminalProxyHandle {
  const issuer = getIssuer();
  const jwksUri = getJwksUri(issuer);
  const getSigningKey = createJwksKeyResolver(jwksUri);

  return attachTerminalProxy(server, (token: string) =>
    verifyTerminalToken(token, { issuer, getSigningKey }),
  );
}
