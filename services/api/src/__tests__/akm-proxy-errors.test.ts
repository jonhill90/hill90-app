/**
 * An AKM failure must surface the AKM's fault, not a JSON parser's opinion of it.
 *
 * akm-proxy called `await resp.json()` unconditionally. When the knowledge service
 * returns a non-JSON error body — FastAPI's default 500 is the plain text
 * "Internal Server Error" — that throws, and the throw propagates out past the real
 * cause. What reached the log was:
 *
 *   [knowledge] Create entry error: SyntaxError: Unexpected token 'I',
 *     "Internal S"... is not valid JSON
 *
 * The AKM's actual error — a frontmatter validation failure, in the case that found
 * this — was nowhere. Same family as everything else removed today: a failure that
 * replaces the real cause with a plausible-looking wrong one. Whoever debugs it next
 * loses an hour to a JSON parser.
 */
// Module scope, not global script scope: without a top-level import or export,
// TypeScript shares one scope across such files and identically named top-level
// consts collide with TS2451. That fired for real between two of these files.
export {};
const OLD_ENV = { ...process.env };

function stubFetch(status: number, body: string, contentType = 'text/plain') {
  const f = jest.fn().mockResolvedValue({
    status,
    ok: status < 400,
    text: async () => body,
    json: async () => JSON.parse(body), // throws exactly as the real Response does
    headers: { get: () => contentType },
  });
  (global as any).fetch = f;
  return f;
}

describe('akm-proxy error propagation', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV, AKM_INTERNAL_SERVICE_TOKEN: 't', AKM_SERVICE_URL: 'http://akm:8002' };
  });
  afterAll(() => { process.env = { ...OLD_ENV }; });

  it('does not throw when the AKM returns a plain-text 500', async () => {
    stubFetch(500, 'Internal Server Error');
    const { createEntry } = await import('../services/akm-proxy');
    await expect(createEntry('a1', 'p.md', 'c')).resolves.toBeDefined();
  });

  it('preserves the upstream status rather than collapsing it', async () => {
    stubFetch(500, 'Internal Server Error');
    const { createEntry } = await import('../services/akm-proxy');
    const r = await createEntry('a1', 'p.md', 'c');
    expect(r.status).toBe(500);
  });

  it('surfaces the upstream body, so the real cause is visible', async () => {
    stubFetch(422, 'required frontmatter field missing: type');
    const { createEntry } = await import('../services/akm-proxy');
    const r = await createEntry('a1', 'p.md', 'c');
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.data)).toMatch(/frontmatter field missing/);
  });

  it('says the response was not JSON, so the shape of the problem is named', async () => {
    stubFetch(500, 'Internal Server Error');
    const { createEntry } = await import('../services/akm-proxy');
    const r = await createEntry('a1', 'p.md', 'c');
    expect(JSON.stringify(r.data)).toMatch(/non-JSON/i);
  });

  it('still parses a JSON error body normally', async () => {
    stubFetch(404, '{"detail":"entry not found"}', 'application/json');
    const { createEntry } = await import('../services/akm-proxy');
    const r = await createEntry('a1', 'p.md', 'c');
    expect(r.status).toBe(404);
    expect((r.data as any).detail).toBe('entry not found');
  });

  it('still parses a JSON success body normally', async () => {
    stubFetch(201, '{"id":"abc","path":"p.md"}', 'application/json');
    const { createEntry } = await import('../services/akm-proxy');
    const r = await createEntry('a1', 'p.md', 'c');
    expect(r.status).toBe(201);
    expect((r.data as any).id).toBe('abc');
  });

  it('tolerates an empty body without throwing', async () => {
    stubFetch(204, '');
    const { createEntry } = await import('../services/akm-proxy');
    const r = await createEntry('a1', 'p.md', 'c');
    expect(r.status).toBe(204);
  });

  it('truncates a huge upstream body rather than logging a page of HTML', async () => {
    stubFetch(502, '<html>' + 'x'.repeat(5000) + '</html>');
    const { createEntry } = await import('../services/akm-proxy');
    const r = await createEntry('a1', 'p.md', 'c');
    expect(JSON.stringify(r.data).length).toBeLessThan(1200);
  });

  it('applies to every AKM call, not just createEntry', async () => {
    // The same unconditional resp.json() existed at three sites.
    //
    // getEntriesGraph excluded from this generic probe (app#501): every
    // OTHER exported function tolerates being called with three positional
    // strings — extra/mistyped args are silently ignored or optional-
    // chained away, so the probe still reaches the real fetch/readBody path
    // this test exists to exercise. getEntriesGraph's first param is
    // genuinely `string[] | null`, not a string, and calls `.join(',')` on
    // it — `'a1'.join` throws before ever reaching readBody, which would
    // make this loop assert something about a TypeError, not about error
    // propagation. Given its own dedicated case directly below instead,
    // called the way its real (and only) caller — routes/knowledge.ts —
    // actually calls it.
    const mod = await import('../services/akm-proxy');
    const fns = Object.keys(mod)
      .filter((k) => typeof (mod as any)[k] === 'function')
      .filter((k) => k !== 'getEntriesGraph');
    for (const name of fns) {
      stubFetch(500, 'Internal Server Error');
      await expect((mod as any)[name]('a1', 'p.md', 'c')).resolves.toBeDefined();
    }
  });

  it('applies to getEntriesGraph too (app#501), called with its real signature', async () => {
    stubFetch(500, 'Internal Server Error');
    const { getEntriesGraph } = await import('../services/akm-proxy');
    const r = await getEntriesGraph(['a1'], 100);
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.data)).toMatch(/non-JSON/i);
  });
});
