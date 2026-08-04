import {
  SSE_BACKFILL_LIMIT,
  BACKFILL_TAIL_SQL,
  POLL_SQL,
  THREAD_MESSAGE_COUNT_SQL,
  backfillNotice,
  backfillFrame,
} from '../helpers/chat-backfill';

/**
 * The SSE backfill is bounded, and it says so (#203).
 *
 * With no Last-Event-ID the cursor is 0, so `seq > 0` matched every message
 * ever sent — and this is the path the UI actually uses, so it is where a
 * human sees the result. Two properties had to hold together:
 *
 *   * the replay is the NEWEST tail. A plain `ORDER BY seq ASC LIMIT n` is the
 *     obvious bound and it is WRONG here: it replays the oldest n, showing a
 *     reader the start of a conversation instead of what just arrived.
 *   * the truncation is announced, because a chat that quietly drops its
 *     oldest messages looks like history that never happened.
 */

describe('the backfill replays the newest tail, not the oldest', () => {
  it('orders DESC to select, then re-ascends to emit', () => {
    // Both, in that order. Only the inner DESC picks the right end; only the
    // outer ASC keeps the wire order every existing client already expects.
    const innerDesc = BACKFILL_TAIL_SQL.indexOf('ORDER BY seq DESC');
    const outerAsc = BACKFILL_TAIL_SQL.lastIndexOf('ORDER BY seq ASC');
    expect(innerDesc).toBeGreaterThan(-1);
    expect(outerAsc).toBeGreaterThan(innerDesc);
  });

  it('carries a LIMIT, which the steady-state poll deliberately does not', () => {
    expect(BACKFILL_TAIL_SQL).toContain('LIMIT $3');
    // The poll is bounded by arrival rate — it only ever returns what appeared
    // since the last cursor. Adding a LIMIT there would silently drop live
    // messages, which is a worse defect than the one being fixed.
    expect(POLL_SQL).not.toContain('LIMIT');
  });

  it('keeps the cursor predicate, so a reconnect does not replay everything', () => {
    expect(BACKFILL_TAIL_SQL).toContain('seq > $2');
  });

  it('has a ceiling in the hundreds, not the millions', () => {
    expect(SSE_BACKFILL_LIMIT).toBeGreaterThan(0);
    expect(SSE_BACKFILL_LIMIT).toBeLessThanOrEqual(2000);
  });
});

describe('the notice makes the truncation visible', () => {
  const rows = [{ seq: 8 }, { seq: 9 }];

  it('reports a total that DISAGREES with what it replayed', () => {
    // 2 sent, 3 in the thread. If a fixture made these equal, an
    // implementation returning rows.length would pass it — and that
    // implementation is the defect, because a total taken from the page
    // always agrees with the page.
    const n = backfillNotice(rows, 3);
    expect(n.sent).toBe(2);
    expect(n.total).toBe(3);
    expect(n.total).not.toBe(n.sent);
    expect(n.has_older).toBe(true);
  });

  it('reports the oldest seq it sent, so a client can ask for what precedes it', () => {
    expect(backfillNotice(rows, 3).oldest_seq_sent).toBe(8);
  });

  it('says has_older is false when the replay IS the whole thread', () => {
    const n = backfillNotice(rows, 2);
    expect(n.has_older).toBe(false);
  });

  it('handles an empty thread without claiming a cursor it does not have', () => {
    const n = backfillNotice([], 0);
    expect(n.oldest_seq_sent).toBeNull();
    expect(n.has_older).toBe(false);
  });

  it('counts with SQL over the same thread, never over the replayed rows', () => {
    expect(THREAD_MESSAGE_COUNT_SQL).toContain('COUNT(*)');
    expect(THREAD_MESSAGE_COUNT_SQL).toContain('thread_id = $1');
    // No cursor predicate: the total is the whole thread, which is what
    // "showing the last N of M" means.
    expect(THREAD_MESSAGE_COUNT_SQL).not.toContain('seq >');
  });
});

describe('the frame is inert for clients that do not know about it', () => {
  it('uses a distinct event type, which EventSource will not deliver to message listeners', () => {
    const frame = backfillFrame(backfillNotice([{ seq: 1 }], 5));
    expect(frame.startsWith('event: backfill\n')).toBe(true);
    expect(frame.endsWith('\n\n')).toBe(true);
  });

  it('is not an id: frame, so it cannot move the reconnect cursor', () => {
    // An `id:` line sets Last-Event-ID. If this frame carried one, a reconnect
    // would resume from the notice rather than from the last real message.
    expect(backfillFrame(backfillNotice([{ seq: 1 }], 5))).not.toContain('id:');
  });

  it('carries parseable JSON', () => {
    const frame = backfillFrame(backfillNotice([{ seq: 4 }], 9));
    const data = JSON.parse(frame.split('data: ')[1].trim());
    expect(data).toEqual({ sent: 1, total: 9, oldest_seq_sent: 4, has_older: true });
  });
});
