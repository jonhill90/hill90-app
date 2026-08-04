/**
 * Whether an agent's auto-journal is failing transiently or permanently (#292).
 *
 * THE DEFECT. The chat callback appends a journal entry through the knowledge
 * service, inside a `catch` that logs and continues. The catch is RIGHT —
 * journalling must not fail a chat reply — but it made a permanent failure
 * indistinguishable from a transient one, and the feature ran for its entire
 * life saying nothing beyond one line per occurrence. It had never worked at
 * all: the lookup query compared uuid to varchar and Postgres refused it, which
 * is how #292 was found, and the catch is why nobody noticed for months.
 *
 * WHAT MAKES THEM DISTINGUISHABLE is the only thing that separates them:
 * repetition. One failure is weather; the same failure on consecutive attempts
 * is a broken feature. So this counts consecutive failures per agent, puts the
 * count and the reason in the log line — "1st" reads differently from "5th
 * consecutive" — and tells the agent's owner ONCE when it crosses into
 * persistent, using the notification channel that already carries #253's
 * deleted container and #255's unrenewed token. A success resets everything.
 *
 * NOT A NEW MECHANISM, deliberately. `usage_write_gaps` (#261) records lost
 * usage rows because a TOTAL had to be qualified at the moment it is read.
 * Nothing reads a journal count, so a gap table here would be a second store
 * for the same idea with no reader — the shape this repository keeps deleting.
 * The reader that does exist is a human, and the channel that reaches them is
 * `notify`.
 *
 * WHAT THIS STILL DOES NOT GIVE YOU, stated because a counter nobody reads is
 * silence with more words: the count is in memory, so a restart forgets it and
 * the next failure reads as the first. Nothing scrapes this service, so there
 * is no metric. If the owner ignores the notification, nothing escalates. The
 * honest ceiling is "the owner is told once per outage", and anything better
 * needs a surface this estate does not have — named in #292.
 */
import { notify } from './notifications';

/** Consecutive failures before the owner is told. One blip is not a fault. */
export const PERSISTENT_AFTER = 3;

interface Streak {
  count: number;
  firstFailedAt: string;
  reason: string;
  notified: boolean;
}

const streaks = new Map<string, Streak>();

/** Test seam only: module state is process-global by design. */
export function resetJournalGaps(): void {
  streaks.clear();
}

export function journalStreak(agentSlug: string): number {
  return streaks.get(agentSlug)?.count ?? 0;
}

/**
 * Record one failed journal append. Never throws: this runs on a path that is
 * already handling a failure, and a reporting fault must not become the thing
 * that fails the chat callback.
 */
export function recordJournalFailure(
  agentSlug: string,
  ownerSub: string | null,
  reason: string,
): void {
  try {
    const now = new Date().toISOString();
    const prev = streaks.get(agentSlug);
    const streak: Streak = prev
      ? { ...prev, count: prev.count + 1, reason }
      : { count: 1, firstFailedAt: now, reason, notified: false };
    streaks.set(agentSlug, streak);

    const ordinal = streak.count === 1 ? '1st' : `${streak.count}th consecutive`;
    console.warn(
      `[chat-callback] Journal append failed for ${agentSlug} (${ordinal} since ${streak.firstFailedAt}): ${reason}`
    );

    if (streak.count >= PERSISTENT_AFTER && !streak.notified && ownerSub) {
      streak.notified = true;
      notify(
        ownerSub,
        `Agent "${agentSlug}" has failed to write its journal ${streak.count} times in a row — its memory of these conversations is missing. Reason: ${reason}`,
        'agent_error',
        { agent_slug: agentSlug, consecutive_failures: streak.count, reason },
      );
    }
  } catch (err) {
    console.error('[chat-callback] Journal failure accounting failed:', err);
  }
}

/**
 * A journal append that worked. Clears the streak, and says so if one was open
 * — a recovery nobody can see is how "it fixed itself" becomes folklore.
 */
export function recordJournalSuccess(agentSlug: string): void {
  const prev = streaks.get(agentSlug);
  if (!prev) return;
  streaks.delete(agentSlug);
  console.info(
    `[chat-callback] Journal append recovered for ${agentSlug} after ${prev.count} consecutive failure(s)`
  );
}
