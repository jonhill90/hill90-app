/**
 * The remaining gap in #313, item 1: nothing asserted that `index.ts` hands
 * `attachTerminalProxy` the CORRECT issuer and key resolver — only that a
 * verifier built with SOME issuer and SOME resolver behaves correctly, which
 * `terminal-upgrade.test.ts` and `terminal-session-endings.test.ts` already
 * cover by constructing their own `verifyToken` from scratch.
 *
 * A future edit could hand `attachTerminalProxyFromConfig` the wrong issuer
 * or the wrong JWKS URI and every existing terminal test would still pass,
 * because none of them import the real wiring — they supply their own. That
 * is a test that certifies the unit while the surface stays unproven, the
 * same shape as a check that cannot fail.
 *
 * This test imports the REAL wiring (`terminal-wiring.ts`, extracted from
 * `index.ts` for exactly this reason — see that file's own comment) and
 * proves the issuer and key resolver reaching `verifyTerminalToken` are the
 * ones the real config functions produced, not merely that a plausible pair
 * of arguments arrived.
 *
 * PROVEN TO GO RED, not just shown green: see the bottom of this file for
 * the transcript of deliberately wiring the wrong issuer into
 * `terminal-wiring.ts` and watching this test fail while
 * `terminal-upgrade.test.ts` and `terminal-session-endings.test.ts` both
 * stayed green against the same broken wiring — which is the exact gap this
 * test exists to close.
 */

const mockAttachTerminalProxy = jest.fn();
jest.mock('../services/terminal-proxy', () => ({
  attachTerminalProxy: (...args: unknown[]) => mockAttachTerminalProxy(...args),
}));

const mockVerifyTerminalToken = jest.fn().mockResolvedValue(null);
jest.mock('../services/terminal-token', () => ({
  verifyTerminalToken: (...args: unknown[]) => mockVerifyTerminalToken(...args),
}));

// A sentinel, not a real key resolver: identifies exactly which jwksUri
// createJwksKeyResolver was built from, without needing a real jwks-rsa
// network client.
const mockCreateJwksKeyResolver = jest.fn((jwksUri: string) => ({ __builtFrom: jwksUri }));
jest.mock('../middleware/auth', () => ({
  createJwksKeyResolver: (...args: [string]) => mockCreateJwksKeyResolver(...args),
}));

// keycloak-config is DELIBERATELY NOT MOCKED. getIssuer/getJwksUri are the
// real functions under test — the whole point is proving the real config
// reader's output is what reaches the verifier, not a stand-in's.
import { getIssuer, getJwksUri } from '../middleware/keycloak-config';

describe('terminal-wiring: the real config reaches the verifier, not just a plausible one', () => {
  const ORIGINAL_ISSUER = process.env.KEYCLOAK_ISSUER;
  const ORIGINAL_JWKS = process.env.KEYCLOAK_JWKS_URI;

  beforeEach(() => {
    jest.resetModules();
    mockAttachTerminalProxy.mockReset();
    mockVerifyTerminalToken.mockReset().mockResolvedValue(null);
    mockCreateJwksKeyResolver.mockClear();
    process.env.KEYCLOAK_ISSUER = 'https://auth.example.com/realms/wiring-test';
    delete process.env.KEYCLOAK_JWKS_URI;
  });

  afterEach(() => {
    if (ORIGINAL_ISSUER === undefined) delete process.env.KEYCLOAK_ISSUER;
    else process.env.KEYCLOAK_ISSUER = ORIGINAL_ISSUER;
    if (ORIGINAL_JWKS === undefined) delete process.env.KEYCLOAK_JWKS_URI;
    else process.env.KEYCLOAK_JWKS_URI = ORIGINAL_JWKS;
  });

  it('POSITIVE CONTROL: the verifier attachTerminalProxy receives calls verifyTerminalToken with the REAL issuer and a key resolver built from the REAL JWKS URI', async () => {
    const { attachTerminalProxyFromConfig } = require('../services/terminal-wiring');
    const fakeServer = {} as never;

    attachTerminalProxyFromConfig(fakeServer);

    // attachTerminalProxy was called once, with the fake server and a verifier closure.
    expect(mockAttachTerminalProxy).toHaveBeenCalledTimes(1);
    const [passedServer, verifyToken] = mockAttachTerminalProxy.mock.calls[0];
    expect(passedServer).toBe(fakeServer);

    // The key resolver was built from EXACTLY the jwks URI the real
    // getJwksUri() derives from the real issuer — not a hardcoded or
    // mismatched one.
    const expectedIssuer = getIssuer();
    const expectedJwksUri = getJwksUri(expectedIssuer);
    expect(expectedIssuer).toBe('https://auth.example.com/realms/wiring-test');
    expect(mockCreateJwksKeyResolver).toHaveBeenCalledWith(expectedJwksUri);

    // Invoking the wired verifier is what actually exercises the wiring —
    // reading the source would only prove the code LOOKS wired correctly.
    await verifyToken('some-token');

    expect(mockVerifyTerminalToken).toHaveBeenCalledWith('some-token', {
      issuer: expectedIssuer,
      getSigningKey: { __builtFrom: expectedJwksUri },
    });
  });

  it('a different issuer produces a different wired JWKS URI — proves the wiring is not a hardcoded pass-through', async () => {
    process.env.KEYCLOAK_ISSUER = 'https://auth.other-example.com/realms/second-realm';
    const { attachTerminalProxyFromConfig } = require('../services/terminal-wiring');

    attachTerminalProxyFromConfig({} as never);
    const [, verifyToken] = mockAttachTerminalProxy.mock.calls[0];
    await verifyToken('another-token');

    const call = mockVerifyTerminalToken.mock.calls[0][1];
    expect(call.issuer).toBe('https://auth.other-example.com/realms/second-realm');
    expect(call.getSigningKey).toEqual({
      __builtFrom: 'https://auth.other-example.com/realms/second-realm/protocol/openid-connect/certs',
    });
  });
});

/*
 * TRANSCRIPT — actually run, not written from prediction. This test proven to
 * go red on wrong wiring, and the two existing terminal-surface tests proven
 * to stay green on the SAME breakage, before this line was reverted.
 *
 * Edited terminal-wiring.ts to hardcode a wrong JWKS URI in place of the
 * derived one:
 *
 *     const issuer = getIssuer();
 *   -  const jwksUri = getJwksUri(issuer);
 *   +  const jwksUri = 'https://wrong-issuer.example.com/protocol/openid-connect/certs'; // DELIBERATE BREAKAGE
 *     const getSigningKey = createJwksKeyResolver(jwksUri);
 *
 * `npx jest terminal-wiring --no-coverage`:
 *
 *   FAIL src/__tests__/terminal-wiring.test.ts
 *     ✕ POSITIVE CONTROL: the verifier attachTerminalProxy receives calls
 *       verifyTerminalToken with the REAL issuer and a key resolver built
 *       from the REAL JWKS URI
 *         Expected: "https://auth.example.com/realms/wiring-test/protocol/openid-connect/certs"
 *         Received: "https://wrong-issuer.example.com/protocol/openid-connect/certs"
 *     ✕ a different issuer produces a different wired JWKS URI — proves the
 *       wiring is not a hardcoded pass-through
 *         - Expected: { "__builtFrom": "https://auth.other-example.com/realms/second-realm/protocol/openid-connect/certs" }
 *         + Received: { "__builtFrom": "https://wrong-issuer.example.com/protocol/openid-connect/certs" }
 *   Tests: 2 failed, 2 total
 *
 * `npx jest terminal-upgrade terminal-session-endings --no-coverage`,
 * against the identical breakage, same run:
 *
 *   PASS src/__tests__/terminal-upgrade.test.ts
 *   PASS src/__tests__/terminal-session-endings.test.ts
 *   Test Suites: 2 passed, 2 total
 *   Tests:       21 passed, 21 total
 *
 * That is the gap #313 named, reproduced exactly: a wrong resolver reaching
 * production would have shipped behind two fully green terminal-proxy test
 * files, because neither imports the real wiring. The breakage was reverted
 * immediately after this transcript was captured.
 */
