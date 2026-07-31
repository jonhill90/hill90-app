/**
 * Credential redaction.
 *
 * The case that motivated this file is `axiosErrorLeaksHeaderAndUrl` below: an
 * axios error carries `config.headers.Authorization` and `config.url`, and
 * Node's util.inspect prints an Error's own enumerable properties after the
 * stack — so `console.error('[svc] failed:', err)` wrote the bearer token
 * verbatim. That was reproduced before the redactor was written, and this test
 * fails if the redactor is removed.
 */
import { inspect } from 'util';
import {
  redactUrl,
  redactString,
  redactDeep,
  redactArgs,
  sanitizeAxiosError,
  installConsoleRedaction,
  __resetRedactionInstallState,
  REDACTED,
} from '../helpers/redact';

// Sentinels, so a test failure names WHICH value escaped without any real
// credential ever being in the repository.
const SENTINEL_BEARER = 'SENTINELbearerAAAAAAAAAAAAAAAAAAAAAA';
const SENTINEL_QS = 'SENTINELqsBBBBBBBBBBBBBBBBBBBBBBBBBB';
const SENTINEL_PW = 'SENTINELpwCCCCCCCC';
const SENTINEL_JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTRU5USU5FTGp3dCJ9.SENTINELsigDDDDDDDD';

beforeEach(() => __resetRedactionInstallState());

describe('redactUrl', () => {
  it('removes a token from a query string but keeps the rest of the URL', () => {
    const out = redactUrl(`https://api.hill90.com/terminal?token=${SENTINEL_QS}&agent=abc`);
    expect(out).not.toContain(SENTINEL_QS);
    expect(out).toContain('token=' + REDACTED);
    expect(out).toContain('agent=abc');
    expect(out).toContain('api.hill90.com/terminal');
  });

  it('removes the password from a database URL and keeps the user and host', () => {
    const out = redactUrl(`postgresql://hill90_app:${SENTINEL_PW}@postgres:5432/hill90_api`);
    expect(out).not.toContain(SENTINEL_PW);
    expect(out).toContain('hill90_app');
    expect(out).toContain('postgres:5432/hill90_api');
  });

  it('leaves an ordinary URL untouched', () => {
    const url = 'http://knowledge:8002/internal/admin/shared/search?q=quokka&limit=5';
    expect(redactUrl(url)).toBe(url);
  });
});

describe('redactString', () => {
  it('scrubs a bare JWT out of free text', () => {
    const out = redactString(`upstream said: ${SENTINEL_JWT} is expired`);
    expect(out).not.toContain('SENTINELjwt');
    expect(out).not.toContain('SENTINELsig');
    expect(out).toContain('is expired');
  });

  it('does not eat ordinary prose that merely mentions a token', () => {
    const msg = 'token refresh failed: the refresh token was rejected by Keycloak';
    expect(redactString(msg)).toBe(msg);
  });
});

describe('redactDeep', () => {
  it('redacts values of sensitive keys at any depth', () => {
    const out = redactDeep({
      ok: 'keep me',
      headers: { Authorization: `Bearer ${SENTINEL_BEARER}`, 'content-type': 'application/json' },
      nested: { db: { password: SENTINEL_PW, user: 'hill90_app' } },
    }) as any;
    expect(JSON.stringify(out)).not.toContain('SENTINEL');
    expect(out.ok).toBe('keep me');
    expect(out.headers['content-type']).toBe('application/json');
    expect(out.nested.db.user).toBe('hill90_app');
  });

  it('survives a circular structure instead of throwing', () => {
    const a: any = { name: 'a', password: SENTINEL_PW };
    a.self = a;
    const out = JSON.stringify(redactDeep(a));
    expect(out).not.toContain(SENTINEL_PW);
    expect(out).toContain('circular');
  });
});

describe('the axios error that leaked', () => {
  function axiosLikeError() {
    const err: any = new Error('Request failed with status code 401');
    err.name = 'AxiosError';
    err.config = {
      method: 'get',
      url: `http://knowledge:8002/internal/admin/shared/search?token=${SENTINEL_QS}`,
      headers: {
        Authorization: `Bearer ${SENTINEL_BEARER}`,
        'Content-Type': 'application/json',
      },
      data: { api_key: SENTINEL_PW },
    };
    err.response = { status: 401, headers: { 'set-cookie': SENTINEL_PW }, data: { error: 'nope' } };
    return err;
  }

  it('leaks through a raw console.error — the behaviour being fixed', () => {
    // Guards the premise. If a future Node stops printing own properties, this
    // fails and the redactor's justification needs rewriting rather than
    // silently becoming cargo cult.
    const raw = inspect(axiosLikeError(), { depth: 6 });
    expect(raw).toContain(SENTINEL_BEARER);
    expect(raw).toContain(SENTINEL_QS);
  });

  it('redactDeep removes the header, the URL token and the request body', () => {
    const out = JSON.stringify(redactDeep(axiosLikeError()));
    expect(out).not.toContain('SENTINEL');
    expect(out).toContain('Request failed with status code 401');
  });

  it('sanitizeAxiosError fixes the error at the source, for non-console paths', () => {
    const err = sanitizeAxiosError(axiosLikeError());
    const serialised = inspect(err, { depth: 6 });
    expect(serialised).not.toContain(SENTINEL_BEARER);
    expect(serialised).not.toContain(SENTINEL_QS);
    expect(serialised).not.toContain(SENTINEL_PW);
    // still diagnosable
    expect(err.config.method).toBe('get');
    expect(err.response.status).toBe(401);
  });
});

describe('installConsoleRedaction', () => {
  it('covers an existing call site without that call site being edited', () => {
    const captured: string[] = [];
    const fake = {
      log: (...a: unknown[]) => captured.push(a.map(String).join(' ')),
      info: (...a: unknown[]) => captured.push(a.map(String).join(' ')),
      warn: (...a: unknown[]) => captured.push(a.map(String).join(' ')),
      error: (...a: unknown[]) => captured.push(a.map((x) => inspect(x, { depth: 6 })).join(' ')),
      debug: (...a: unknown[]) => captured.push(a.map(String).join(' ')),
    } as unknown as Console;

    installConsoleRedaction(fake);

    const err: any = new Error('boom');
    err.config = { headers: { Authorization: `Bearer ${SENTINEL_BEARER}` } };
    fake.error('[provider-connections] DELETE failed (rolled back):', err);

    const text = captured.join('\n');
    expect(text).not.toContain(SENTINEL_BEARER);
    expect(text).toContain('DELETE failed');
  });

  it('is idempotent, so a double install cannot double-wrap', () => {
    const calls: number[] = [];
    const fake = { log: () => calls.push(1), info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Console;
    installConsoleRedaction(fake);
    installConsoleRedaction(fake);
    fake.log('x');
    expect(calls).toHaveLength(1);
  });
});

describe('redactArgs', () => {
  it('leaves an ordinary log line completely alone', () => {
    const args = ['[startup] Database migrations complete', { count: 3, service: 'api' }];
    expect(redactArgs(args)).toEqual(args);
  });
});
