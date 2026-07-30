/**
 * The issuer and the JWKS URI now come from one place.
 *
 * They used to be two lines copied into three files, each with its own literal
 * fallback. These tests pin the precedence so the consolidation cannot silently
 * change behaviour, and so a later edit cannot reintroduce a divergent copy
 * without a failure.
 */
import { getIssuer, getJwksUri } from '../keycloak-config';

const ORIGINAL = { ...process.env };

describe('keycloak-config', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL };
    delete process.env.KEYCLOAK_ISSUER;
    delete process.env.KEYCLOAK_JWKS_URI;
  });

  afterAll(() => {
    process.env = { ...ORIGINAL };
  });

  describe('getIssuer', () => {
    it('prefers an explicit override over everything', () => {
      process.env.KEYCLOAK_ISSUER = 'https://from-env/realms/x';
      expect(getIssuer('https://from-opts/realms/y')).toBe('https://from-opts/realms/y');
    });

    it('falls back to KEYCLOAK_ISSUER, which every deployment sets', () => {
      process.env.KEYCLOAK_ISSUER = 'https://app-auth.hill90.com/realms/hill90';
      expect(getIssuer()).toBe('https://app-auth.hill90.com/realms/hill90');
    });

    it('THROWS when nothing is set — there is deliberately no fallback', () => {
      // The fallback used to be https://auth.hill90.com/realms/hill90. That realm no
      // longer exists, and repointing it at the live realm would be worse: it would
      // become silently correct, so a service with no KEYCLOAK_ISSUER would look fine.
      expect(() => getIssuer()).toThrow(/KEYCLOAK_ISSUER is not set/);
    });

    it('ignores an empty override rather than treating it as a choice', () => {
      process.env.KEYCLOAK_ISSUER = 'https://app-auth.hill90.com/realms/hill90';
      expect(getIssuer('')).toBe('https://app-auth.hill90.com/realms/hill90');
    });
  });

  describe('getJwksUri', () => {
    it('derives from the issuer — the behaviour PR #26 made production use', () => {
      expect(getJwksUri('https://app-auth.hill90.com/realms/hill90')).toBe(
        'https://app-auth.hill90.com/realms/hill90/protocol/openid-connect/certs',
      );
    });

    it('derives from getIssuer() when called with no argument', () => {
      process.env.KEYCLOAK_ISSUER = 'https://app-auth.hill90.com/realms/hill90';
      expect(getJwksUri()).toBe(
        'https://app-auth.hill90.com/realms/hill90/protocol/openid-connect/certs',
      );
    });

    it('still honours KEYCLOAK_JWKS_URI, which local development requires', () => {
      // deploy/compose/overrides/local.api.yml sets this deliberately and is
      // marked DIVERGENCE-INTENTIONAL: a container cannot resolve the
      // browser-facing Traefik hostname.
      process.env.KEYCLOAK_JWKS_URI = 'http://app-keycloak:8080/realms/hill90/protocol/openid-connect/certs';
      expect(getJwksUri('https://app-auth.localtest.me/realms/hill90')).toBe(
        'http://app-keycloak:8080/realms/hill90/protocol/openid-connect/certs',
      );
    });
  });
});
