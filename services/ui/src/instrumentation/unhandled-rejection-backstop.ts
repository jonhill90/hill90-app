/**
 * The server-side half of an asymmetry a #133-style sweep found tonight: services/api
 * installs a process-level `unhandledRejection` backstop (`boot/fatal.ts`), services/ui
 * installs none — confirmed by grep and by checking for a custom server or
 * `instrumentation.ts`, neither of which existed before this file.
 *
 * Nothing currently reachable in the UI leaks a rejection, so this is prophylactic, the
 * same category api's own three call sites were (found by reading, not by exercise).
 * It is worth doing anyway for the same reason api's was: Node 20 crashes a process on
 * an unhandled rejection with NO listener registered — this is already true today, for
 * every request the UI's Next.js server handles, with nobody's log line attached to it.
 * Registering a listener does not change WHETHER a future leak kills the server; it
 * changes the death from an unlabeled stack trace into a statement.
 *
 * WHY THIS IS SAFE TO ADD, not a coverage-shaped no-op. `console.error` from this
 * process reaches Loki today — confirmed live, not assumed: `app-ui`'s stderr is
 * already flowing into Loki under `{container="app-ui"}` (the UI already logs
 * `[admin-health]`-prefixed lines this way). That is the same destination api's own
 * backstop message reaches, and it is a real destination, even though Hill90#845
 * separately and correctly notes that a Loki-reachable log is not the same as an
 * alerted one — "reaches Loki, queryable" is the honest claim being made here, not
 * "someone is paged."
 *
 * Deliberately NOT extended to the browser. See the PR this ships in for why: a
 * `window.addEventListener('unhandledrejection', ...)` that only logs to the devtools
 * console is the exact "reports and is never heard" shape this repo keeps closing, and
 * a real destination for a browser-side rejection (a beacon endpoint, its own abuse and
 * payload-validation surface, and a decision about what a client is allowed to send
 * unauthenticated) is a separate feature decision, not a backstop.
 */

/** Exit hook, injected so tests can induce a real rejection and observe it. */
export type Exit = (code: number) => void;

const defaultExit: Exit = (code) => process.exit(code);

/**
 * Log first, exit on the NEXT turn — same reasoning as api's `boot/fatal.ts`:
 * `process.exit` does not wait for a piped stderr write to flush, and container
 * stderr is a pipe, so the naive `console.error(...); process.exit(1)` can lose the
 * message it exists to print.
 */
function exitAfterFlush(exit: Exit, code: number): void {
  setImmediate(() => exit(code));
}

/**
 * A BACKSTOP, not a fix — converts a silent process death into a logged one.
 *
 * The explicit `exit(1)` preserves Node 20's default: registering a listener would
 * otherwise SUPPRESS the exit, which would turn this backstop into a behaviour
 * change — a server left running in an unknown state after a rejection nobody
 * handled, serving further requests on top of it.
 */
export function installUnhandledRejectionBackstop(exit: Exit = defaultExit): void {
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandled promise rejection — exiting (this is a backstop, not a fix):', reason);
    exitAfterFlush(exit, 1);
  });
}
