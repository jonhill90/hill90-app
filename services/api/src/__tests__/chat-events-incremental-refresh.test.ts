import { Pool } from 'pg';

/**
 * The thread-event correlation filter refreshes INCREMENTALLY (#216).
 *
 * It used to re-read every message id in the thread every five seconds, per
 * connected client, for the life of the connection — a repeated scan whose
 * cost grew with the thread while the interval stayed fixed.
 *
 * This is a different family from the truncation work: nothing was truncated
 * and no answer was wrong, so there is no "showing N of M" to add. The defect
 * was cost. These tests therefore assert on the SHAPE of the query and on the
 * exactness of the membership set, not on any reported number.
 */
export {};

const SRC = require('fs').readFileSync(
  require('path').join(__dirname, '../routes/chat.ts'), 'utf8',
);

// The events handler, isolated so assertions cannot accidentally match the
// message stream's own queries earlier in the file.
const EVENTS = SRC.slice(SRC.indexOf("router.get('/threads/:id/events'"));

describe('the periodic refresh is bounded by new work, not thread length', () => {
  it('queries only messages above the watermark', () => {
    expect(EVENTS).toContain('AND seq > $2');
    expect(EVENTS).toContain('lastSeenSeq');
  });

  it('no longer re-reads the whole thread on the interval', () => {
    // The unbounded form, inside the interval, is what this fixes.
    const interval = EVENTS.slice(EVENTS.indexOf('messageRefreshInterval = setInterval'));
    const body = interval.slice(0, interval.indexOf('}, 5000);'));
    expect(body).not.toMatch(/SELECT id FROM chat_messages\s+WHERE thread_id = \$1`/);
    expect(body).toContain('seq > $2');
  });

  it('never clears the set', () => {
    // clear() before a query that then fails would drop ids the correlation
    // filter still needs, turning a cost problem into a correctness one —
    // events silently missing, which is the family this repo has spent the day
    // removing.
    expect(EVENTS).not.toContain('threadMessageIds.clear()');
  });

  it('keeps the initial load complete', () => {
    // Bounding THIS would silently drop events correlated to older messages.
    // The membership test has to be exact; only the refresh was wasteful.
    const load = EVENTS.slice(0, EVENTS.indexOf('const threadMessageIds'));
    expect(load).toContain('SELECT id, seq FROM chat_messages WHERE thread_id = $1');
    expect(load).not.toContain('LIMIT');
  });
});

describe('the watermark arithmetic', () => {
  // The logic, extracted and exercised directly rather than asserted about.
  function refresh(seen: Set<string>, watermark: number, rows: Array<{ id: string; seq: number }>) {
    for (const r of rows) {
      seen.add(r.id);
      if (Number(r.seq) > watermark) watermark = Number(r.seq);
    }
    return watermark;
  }

  it('advances past the highest seq it saw', () => {
    const seen = new Set<string>(['a']);
    const wm = refresh(seen, 1, [{ id: 'b', seq: 2 }, { id: 'c', seq: 5 }]);
    expect(wm).toBe(5);
    expect([...seen].sort()).toEqual(['a', 'b', 'c']);
  });

  it('is idempotent when a reconciled message reappears above the mark', () => {
    // The stale reconcile reassigns seq via nextval, so an existing message
    // can surface again with a higher seq. Re-adding it must be a no-op.
    const seen = new Set<string>(['a']);
    const wm = refresh(seen, 1, [{ id: 'a', seq: 9 }]);
    expect(wm).toBe(9);
    expect(seen.size).toBe(1);
  });

  it('does not move backwards on an empty result', () => {
    expect(refresh(new Set(), 7, [])).toBe(7);
  });
});
