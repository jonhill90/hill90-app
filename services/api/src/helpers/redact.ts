/**
 * Credential redaction for anything on its way to a log line.
 *
 * WHY A MECHANISM AND NOT A LIST OF CALL SITES
 *
 * The terminal WebSocket was writing its auth token into a log line on every
 * upgrade, and that was found by accident while fixing something adjacent. The
 * api has ~180 `console.error('...', err)` call sites; auditing each one is a
 * job that has to be redone after every PR, and the one that gets forgotten is
 * the one that leaks. So this redacts centrally and is installed once.
 *
 * The indirect paths matter more than the obvious ones. An axios error carries
 * `config.headers` — including `Authorization` — and `config.url`, which may
 * carry a token in the query string. Node's `util.inspect` prints an Error's own
 * enumerable properties after the stack, so `console.error('[svc] failed:', err)`
 * on an axios error writes the bearer token and the URL verbatim. Verified with
 * a reproduction before this file was written.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not scrub arbitrary prose for anything token-shaped. Redacting the
 * *values of known-sensitive keys*, credentials embedded in URLs, and the one
 * unambiguous literal shape (a JWT) keeps log lines useful. A redactor that
 * eats ordinary words trains people to turn it off.
 *
 * TWO LIMITS MEASURED ON 2026-07-31, RECORDED SO NOBODY ASSUMES WIDER COVERAGE
 *
 * 1. SENSITIVE_KEY is anchored `^(...)$`, so it matches a key that IS one of the
 *    listed names and never one that merely contains it. Checked against this
 *    app's own credential variables: ALL FOURTEEN fail to match —
 *    ANTHROPIC_API_KEY, OPENAI_API_KEY, LITELLM_MASTER_KEY, AUTH_SECRET,
 *    AUTH_KEYCLOAK_SECRET, PLATFORM_DB_PASSWORD, CHAT_CALLBACK_TOKEN,
 *    MINIO_TENANT_ACCESS_KEY, MINIO_TENANT_SECRET_KEY,
 *    AKM_INTERNAL_SERVICE_TOKEN, AKM_SIGNING_PRIVATE_KEY,
 *    MODEL_ROUTER_INTERNAL_SERVICE_TOKEN, MODEL_ROUTER_SIGNING_PRIVATE_KEY,
 *    PROVIDER_KEY_ENCRYPTION_KEY. Logging an object keyed by those names — a
 *    config dump, `process.env` — would print the values.
 *
 * 2. It redacts key/value pairs, not `NAME=value` STRINGS. The agent container
 *    env in routes/agents.ts is an array of exactly that shape, carrying
 *    ANTHROPIC_API_KEY, CHAT_CALLBACK_TOKEN, TAVILY_API_KEY and WORK_TOKEN.
 *
 * NEITHER IS KNOWN TO LEAK TODAY, and that was checked rather than assumed: no
 * code path logs `process.env` or a config object, and the container create in
 * services/docker.ts goes through dockerode, whose errors do not carry the
 * request body — unlike the axios path this module was built for. So these are
 * LIMITS OF SCOPE, not an open leak. Widening the key match is deliberately NOT
 * done here: `^(...)$` is what keeps ordinary words safe, and a redactor that
 * eats them gets turned off. If a config dump or an env array ever does reach a
 * log, redact at that call site, or add the specific names above.
 */

/** Keys whose VALUE is a credential, matched case-insensitively on the whole key. */
const SENSITIVE_KEY = new RegExp(
  '^(' +
    [
      'authorization',
      'proxy-authorization',
      'cookie',
      'set-cookie',
      'password',
      'passwd',
      'pass',
      'secret',
      'client_secret',
      'clientsecret',
      'token',
      'access_token',
      'refresh_token',
      'id_token',
      'session_token',
      'api_key',
      'apikey',
      'x-api-key',
      'anthropic-api-key',
      'private_key',
      'privatekey',
      'signing_key',
      'encryption_key',
      'connection_string',
      'database_url',
      'dsn',
    ].join('|') +
    ')$',
  'i'
);

/** Query parameters that carry a credential in a URL. */
const SENSITIVE_PARAM = /^(access_token|token|id_token|refresh_token|api_key|apikey|key|password|secret|code|client_secret)$/i;

export const REDACTED = '<redacted>';

/** A JWT is unambiguous enough to scrub from free text. Three base64url segments. */
const JWT_RE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g;

/**
 * Strip credentials from a URL: userinfo (postgres://user:pw@host) and any
 * credential-bearing query parameter. Returns the input unchanged if it does not
 * parse as a URL, after still removing userinfo textually — a malformed DSN in
 * an error message is exactly the case that must not leak.
 */
export function redactUrl(input: string): string {
  let out = input;

  // scheme://user:password@  ->  scheme://user:<redacted>@
  out = out.replace(
    /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^:/?#@\s]+):([^@/?#\s]+)@/g,
    (_m, scheme, user) => `${scheme}${user}:${REDACTED}@`
  );

  // credential-bearing query parameters
  out = out.replace(
    /([?&])([A-Za-z0-9_.-]+)=([^&\s"']*)/g,
    (match, sep, key) => (SENSITIVE_PARAM.test(key) ? `${sep}${key}=${REDACTED}` : match)
  );

  return out;
}

/** Scrub a free-text string: URLs inside it, and any bare JWT. */
export function redactString(s: string): string {
  return redactUrl(s).replace(JWT_RE, REDACTED);
}

function isPlainish(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null || Array.isArray(v);
}

/**
 * Deep-redact a value for logging.
 *
 * Errors are handled explicitly: an Error's `message` and `stack` are strings
 * (scrubbed), and its OWN enumerable properties — where axios hangs `config` and
 * `response` — are redacted recursively. That own-property set is precisely what
 * `util.inspect` prints and what leaked.
 */
export function redactDeep(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 8) return '<max-depth>';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;

  if (seen.has(value as object)) return '<circular>';
  seen.add(value as object);

  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: redactString(value.message),
    };
    if (value.stack) out.stack = redactString(value.stack);
    for (const key of Object.keys(value)) {
      if (key === 'name' || key === 'message' || key === 'stack') continue;
      out[key] = SENSITIVE_KEY.test(key)
        ? REDACTED
        : redactDeep((value as unknown as Record<string, unknown>)[key], depth + 1, seen);
    }
    return out;
  }

  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v, depth + 1, seen));
  }

  if (!isPlainish(value)) {
    // Class instances (Buffer, streams, pools). Do not walk them; they are not
    // where credentials hide and walking them is how a logger becomes a hazard.
    return value;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactDeep(v, depth + 1, seen);
  }
  return out;
}

/** Redact every argument of a log call. */
export function redactArgs(args: unknown[]): unknown[] {
  return args.map((a) => redactDeep(a));
}

/**
 * Sanitise an axios-shaped error IN PLACE at the source.
 *
 * This is the belt to the console braces: it protects paths that never reach
 * console at all — an error serialised into a response body, forwarded to
 * OpenTelemetry, or re-thrown into a framework handler.
 */
export function sanitizeAxiosError(err: any): any {
  if (!err || typeof err !== 'object') return err;
  const cfg = err.config;
  if (cfg && typeof cfg === 'object') {
    if (cfg.headers && typeof cfg.headers === 'object') {
      for (const k of Object.keys(cfg.headers)) {
        if (SENSITIVE_KEY.test(k)) cfg.headers[k] = REDACTED;
      }
    }
    if (typeof cfg.url === 'string') cfg.url = redactUrl(cfg.url);
    if (typeof cfg.baseURL === 'string') cfg.baseURL = redactUrl(cfg.baseURL);
    // Request bodies routinely carry the credential being exchanged.
    if (cfg.data !== undefined) cfg.data = REDACTED;
  }
  if (err.request && typeof err.request === 'object') {
    if (typeof err.request.path === 'string') err.request.path = redactUrl(err.request.path);
  }
  if (err.response && typeof err.response === 'object') {
    const h = err.response.headers;
    if (h && typeof h === 'object') {
      for (const k of Object.keys(h)) {
        if (SENSITIVE_KEY.test(k)) h[k] = REDACTED;
      }
    }
  }
  return err;
}

/** Register the axios interceptor. Idempotent. */
let axiosInstalled = false;
export function installAxiosRedaction(axiosInstance: any): void {
  if (axiosInstalled || !axiosInstance?.interceptors?.response) return;
  axiosInstalled = true;
  axiosInstance.interceptors.response.use(
    (r: unknown) => r,
    (err: unknown) => Promise.reject(sanitizeAxiosError(err))
  );
}

/**
 * Wrap console so every existing call site is covered without being edited.
 *
 * This is the point of the whole file: the 181st call site is written by someone
 * who has not read this comment.
 */
let consoleInstalled = false;
export function installConsoleRedaction(target: Console = console): void {
  if (consoleInstalled) return;
  consoleInstalled = true;
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = target[level].bind(target);
    target[level] = ((...args: unknown[]) => original(...redactArgs(args))) as typeof target.log;
  }
}

/** Test seam. */
export function __resetRedactionInstallState(): void {
  axiosInstalled = false;
  consoleInstalled = false;
}
