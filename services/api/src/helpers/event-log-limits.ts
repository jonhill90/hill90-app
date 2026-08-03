/**
 * The bounds for reading an agent's event log, in ONE place.
 *
 * Three routes read `/var/log/agentbox/events.jsonl` with a caller-supplied
 * `?tail=`: /agents/:id/events, /agents/:id/events/export and
 * /chat/threads/:id/events. Every time this bound has lived as a literal in one
 * of them, the others have drifted:
 *
 *   app#141 — the export endpoint clamped to 5000; the agents events endpoint
 *             did not, and had a floor with no ceiling.
 *   this    — both agents endpoints were clamped and byte-capped; the chat
 *             endpoint was neither, and reads once PER AGENT in the thread.
 *
 * So it is a shared constant rather than a number typed in three files.
 */

/** The most log lines any one caller may ask for, per agent. */
export const MAX_EVENT_TAIL = 5000;
