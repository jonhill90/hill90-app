/**
 * The bounded SSE backfill for a chat thread (#203).
 *
 * With no `Last-Event-ID` the stream's cursor is 0, so `seq > 0` matched every
 * message ever sent in the thread. Every poll after the first is bounded by
 * arrival rate, so the ceiling belongs on the backfill specifically.
 *
 * Extracted from the route so the two properties that matter can be asserted
 * directly rather than by scraping the router's source: WHICH END is replayed,
 * and where the total comes from.
 */

/** How many messages an SSE connect or reconnect replays. */
export const SSE_BACKFILL_LIMIT = 500;

/**
 * The newest `$3` messages above the cursor, re-ascended before emission.
 *
 * The inner `ORDER BY seq DESC` is the whole point. A plain
 * `ORDER BY seq ASC LIMIT n` would replay the OLDEST n, so a reader opening or
 * reconnecting to a long thread would be shown the start of the conversation
 * instead of what just arrived — incomplete in a list is merely incomplete;
 * in a chat it is unusable.
 *
 * The outer `ORDER BY seq ASC` keeps the wire order exactly what every client
 * already receives.
 */
export const BACKFILL_TAIL_SQL = `SELECT * FROM (
         SELECT id, seq, author_id, author_type, role, content, status,
                reply_to, target_agents,
                chain_id, chain_hop, triggered_by,
                model, input_tokens, output_tokens, duration_ms,
                error_message, created_at
         FROM chat_messages
         WHERE thread_id = $1 AND seq > $2
         ORDER BY seq DESC
         LIMIT $3
       ) t ORDER BY seq ASC`;

/** Steady-state poll: everything above the cursor, bounded by arrival rate. */
export const POLL_SQL = `SELECT id, seq, author_id, author_type, role, content, status,
              reply_to, target_agents,
              chain_id, chain_hop, triggered_by,
              model, input_tokens, output_tokens, duration_ms,
              error_message, created_at
       FROM chat_messages
       WHERE thread_id = $1 AND seq > $2
       ORDER BY seq ASC`;

/** COUNT over the same thread as the page. Never `rows.length`. */
export const THREAD_MESSAGE_COUNT_SQL =
  `SELECT COUNT(*) AS total FROM chat_messages WHERE thread_id = $1`;

export interface BackfillNotice {
  sent: number;
  total: number;
  oldest_seq_sent: number | null;
  has_older: boolean;
}

/**
 * The frame that makes the truncation visible.
 *
 * `total` MUST come from `THREAD_MESSAGE_COUNT_SQL`, not from the replayed
 * rows: a total derived from the page agrees with itself and reports a
 * truncated thread as whole (#180).
 */
export function backfillNotice(
  sentRows: Array<{ seq: number }>,
  total: number,
): BackfillNotice {
  return {
    sent: sentRows.length,
    total,
    oldest_seq_sent: sentRows.length > 0 ? sentRows[0].seq : null,
    has_older: total > sentRows.length,
  };
}

/**
 * Serialise the notice as an SSE frame.
 *
 * A new event TYPE is the safe channel on this protocol. `EventSource`
 * dispatches only to listeners that were registered, and the current client
 * registers `message` and `heartbeat` only — so an un-updated UI ignores this
 * frame entirely and behaves exactly as it does today. Same rule as the header
 * on `/entries` and the new body key on the thread GET: add the truth through
 * a channel an un-updated consumer already tolerates.
 */
export function backfillFrame(notice: BackfillNotice): string {
  return `event: backfill\ndata: ${JSON.stringify(notice)}\n\n`;
}
