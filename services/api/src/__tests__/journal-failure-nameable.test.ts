/**
 * A journal that is permanently broken must not look like one having a bad day (#292).
 *
 * THE DEFECT, and what is NOT wrong with it. The chat callback appends a
 * journal entry inside a `catch` that logs and continues. **That catch is
 * correct** — journalling must not fail a chat reply — so it stays. What was
 * wrong is that it made a permanent failure and a transient one identical: one
 * line per occurrence, no count, no owner told. The feature had in fact never
 * worked (its lookup compared uuid to varchar and Postgres refused it), and the
 * catch is why that survived for months.
 *
 * AND A SECOND SHAPE THAT WAS NOT EVEN LOGGED. `appendJournal` RESOLVES with
 * `{status}` on an upstream 503 or 500, so a non-2xx went into a promise nobody
 * inspected. The likelier failure was the invisible one.
 *
 * WHY REPETITION IS THE DISTINCTION. Nothing else separates the two: a single
 * failure is weather, the same failure on consecutive attempts is a broken
 * feature. So the count and the reason go in the log line, and the owner is
 * told once when it crosses into persistent — through the channel that already
 * carries #253 and #255, rather than a second mechanism next to them.
 *
 * WHAT THIS DOES NOT PROVE: that anyone reads the notification. The ceiling is
 * "the owner is told once per outage", stated in the module and in the PR.
 */
import {
  recordJournalFailure,
  recordJournalSuccess,
  resetJournalGaps,
  journalStreak,
  PERSISTENT_AFTER,
} from '../services/journal-gaps';

const mockNotify = jest.fn();
jest.mock('../services/notifications', () => ({ notify: (...a: unknown[]) => mockNotify(...a) }));

let warn: jest.SpyInstance;
let info: jest.SpyInstance;

beforeEach(() => {
  resetJournalGaps();
  mockNotify.mockReset();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  info = jest.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  info.mockRestore();
});

const lines = () => warn.mock.calls.map((c) => String(c[0]));

describe('transient and permanent stop looking the same', () => {
  it('TWIN: a single failure is logged and nobody is woken', async () => {
    // One blip must not notify, or the signal is noise by the second week.
    recordJournalFailure('scout', 'owner-1', 'ECONNRESET');

    expect(journalStreak('scout')).toBe(1);
    expect(lines()[0]).toMatch(/1st/);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL: a persistent failure tells the owner, once', async () => {
    for (let i = 0; i < PERSISTENT_AFTER; i++) {
      recordJournalFailure('scout', 'owner-1', 'HTTP 503');
    }

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const [userId, message, type, meta] = mockNotify.mock.calls[0];
    expect(userId).toBe('owner-1');
    expect(message).toContain('scout');
    expect(message).toContain('memory');           // says what it costs, not just that it failed
    expect(message).toContain('HTTP 503');         // and why
    expect(type).toBe('agent_error');
    expect(meta).toMatchObject({ consecutive_failures: PERSISTENT_AFTER });
  });

  it('and does not tell them again while it stays broken', async () => {
    // A notification per failed message would be the noise that gets muted.
    for (let i = 0; i < PERSISTENT_AFTER + 5; i++) {
      recordJournalFailure('scout', 'owner-1', 'HTTP 503');
    }

    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(journalStreak('scout')).toBe(PERSISTENT_AFTER + 5);
  });

  it('the log line carries the count, so the two are distinguishable without the notification', async () => {
    recordJournalFailure('scout', 'owner-1', 'HTTP 503');
    recordJournalFailure('scout', 'owner-1', 'HTTP 503');

    expect(lines()[0]).toMatch(/1st/);
    expect(lines()[1]).toMatch(/2th consecutive|2nd consecutive|2th|2nd/);
    expect(lines()[1]).toContain('HTTP 503');
  });

  it('a success clears the streak and says so', async () => {
    recordJournalFailure('scout', 'owner-1', 'HTTP 503');
    recordJournalSuccess('scout');

    expect(journalStreak('scout')).toBe(0);
    expect(info.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/recovered/);
  });

  it('after a recovery, a new outage can notify again', async () => {
    for (let i = 0; i < PERSISTENT_AFTER; i++) recordJournalFailure('scout', 'owner-1', 'HTTP 503');
    expect(mockNotify).toHaveBeenCalledTimes(1);

    recordJournalSuccess('scout');
    mockNotify.mockReset();
    for (let i = 0; i < PERSISTENT_AFTER; i++) recordJournalFailure('scout', 'owner-1', 'HTTP 503');

    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('streaks are per agent — one broken agent does not mask another', async () => {
    for (let i = 0; i < PERSISTENT_AFTER; i++) recordJournalFailure('scout', 'owner-1', 'HTTP 503');
    recordJournalFailure('archivist', 'owner-2', 'ECONNRESET');

    expect(journalStreak('scout')).toBe(PERSISTENT_AFTER);
    expect(journalStreak('archivist')).toBe(1);
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('an agent with no owner is still counted and logged', async () => {
    // The notification has nobody to reach; the log line must not disappear too.
    for (let i = 0; i < PERSISTENT_AFTER; i++) recordJournalFailure('orphan', null, 'HTTP 500');

    expect(journalStreak('orphan')).toBe(PERSISTENT_AFTER);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(lines().length).toBe(PERSISTENT_AFTER);
  });
});
