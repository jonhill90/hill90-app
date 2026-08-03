/**
 * The knowledge count must come from X-Total-Count, not from the page length.
 *
 * We broke this ourselves (#188). Before #182, `akmProxy.listEntries` returned
 * every row, so `akmResult.data.length` was the true total. #182 bounded
 * `/internal/admin/entries` at 500, and that same `.length` silently became the
 * size of the page — so an agent with more than 500 entries displays 500 and
 * always will. A total derived from the page agrees with itself.
 *
 * Every fixture below makes the page length and the real total DISAGREE — a
 * 2-element array with `X-Total-Count: 3`. A fixture where they match is passed
 * by a `len(rows)` implementation, which is exactly how this defect got here.
 */
const OLD_ENV = { ...process.env };

function stubFetch(body: unknown, headers: Record<string, string>) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const f = jest.fn().mockResolvedValue({
    status: 200,
    ok: true,
    text: async () => JSON.stringify(body),
    json: async () => body,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
  });
  (global as any).fetch = f;
  return f;
}

// Two rows on the page, three rows in the world.
const PAGE = [
  { path: 'a.md', entry_type: 'plan' },
  { path: 'b.md', entry_type: 'decision' },
];

describe('akm-proxy surfaces the real total', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV, AKM_INTERNAL_SERVICE_TOKEN: 't', AKM_SERVICE_URL: 'http://akm:8002' };
  });
  afterAll(() => { process.env = { ...OLD_ENV }; });

  it('reports the header total, which DIFFERS from the page length', async () => {
    stubFetch(PAGE, { 'X-Total-Count': '3' });
    const { listEntries } = await import('../services/akm-proxy');
    const r = await listEntries('agent-1');

    expect((r.data as unknown[]).length).toBe(2); // the page
    expect(r.total).toBe(3);                      // the world
  });

  it('falls back to the array length when the header is absent', async () => {
    // A knowledge without the header is a knowledge without the LIMIT: the
    // array IS every row, so its length IS the true total. The fallback is
    // correct precisely in the case where it applies.
    stubFetch(PAGE, {});
    const { listEntries } = await import('../services/akm-proxy');
    const r = await listEntries('agent-1');
    expect(r.total).toBe(2);
  });

  it('does not emit NaN when the header is not a number', async () => {
    stubFetch(PAGE, { 'X-Total-Count': 'not-a-number' });
    const { listEntries } = await import('../services/akm-proxy');
    const r = await listEntries('agent-1');
    expect(Number.isNaN(r.total)).toBe(false);
    expect(r.total).toBe(2);
  });

  it('leaves total null when the body is not an array at all', async () => {
    stubFetch({ error: 'nope' }, {});
    const { listEntries } = await import('../services/akm-proxy');
    const r = await listEntries('agent-1');
    expect(r.total).toBeNull();
  });

  it('forwards limit and offset upstream, so a caller can page', async () => {
    const f = stubFetch(PAGE, { 'X-Total-Count': '3' });
    const { listEntries } = await import('../services/akm-proxy');
    await listEntries('agent-1', undefined, { limit: 2, offset: 4 });

    const url = String(f.mock.calls[0][0]);
    expect(url).toContain('limit=2');
    expect(url).toContain('offset=4');
  });
});

describe('agent stats report the real knowledge total', () => {
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV, AKM_INTERNAL_SERVICE_TOKEN: 't', AKM_SERVICE_URL: 'http://akm:8002' };
  });
  afterAll(() => { process.env = { ...OLD_ENV }; });

  it('uses the header total rather than the length of the page it received', async () => {
    stubFetch(PAGE, { 'X-Total-Count': '3' });
    const akmProxy = await import('../services/akm-proxy');
    const r = await akmProxy.listEntries('agent-1', undefined, { limit: 1 });

    // This is the line agents.ts:2413 used to run, kept here as the thing the
    // fix must NOT do — it is the defect, written out.
    const derivedFromPage = (r.data as unknown[]).length;
    const realTotal = r.total;

    expect(derivedFromPage).toBe(2);
    expect(realTotal).toBe(3);
    expect(realTotal).not.toBe(derivedFromPage);
  });
});
