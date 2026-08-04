/**
 * The two ends of the process's life, where a rejection has nowhere to go.
 *
 * Node 20 exits the process on an unhandled rejection, and this service registers
 * no handler of its own — so a promise that rejects with nobody listening kills the
 * API. `boot/async-errors.ts` closes that hole for Express handlers. It cannot close
 * it for the entrypoint, because startup and shutdown are not requests: nothing is
 * above them to catch anything.
 *
 * Found by the #133 sweep, 2026-08-04. Both sites were reachable and neither was
 * covered by `@typescript-eslint/no-floating-promises` alone — `start()` was, the
 * signal handlers were not, since a promise handed to `process.on` is a
 * `no-misused-promises` finding.
 */

/** Exit hook, injected so the tests can induce a real rejection and observe it. */
export type Exit = (code: number) => void;

const defaultExit: Exit = (code) => process.exit(code);

/**
 * Log first, exit on the NEXT turn.
 *
 * `console.error(...); process.exit(code)` loses the message when stderr is a pipe,
 * because a piped write is asynchronous and `process.exit` does not wait for it. In a
 * container stderr IS a pipe, so the naive form would have produced exactly the thing
 * this module exists to prevent: a process that dies without saying why. Caught by
 * boot-fatal.test.ts, which reads a real child process's stderr and found it empty.
 *
 * One `setImmediate` is enough: the write is queued by then, and nothing else is
 * scheduled that could take another action before the exit.
 */
function exitAfterFlush(exit: Exit, code: number): void {
  setImmediate(() => exit(code));
}

/**
 * Attach the only rejection handler `start()` can have.
 *
 * `start()` was called bare: `start();`. Its `await runReconcilePass()` sits outside
 * any try DELIBERATELY — a try/catch that logged and carried on was removed so the
 * API cannot serve unverified agent state as fact (#238) — so a failed pass is meant
 * to stop the process. It did, by unhandled rejection: an `UnhandledPromiseRejection`
 * stack, no message of ours, and no control of the exit code.
 *
 * This changes nothing about WHETHER it dies. It changes the death from an accident
 * into a statement: the cause is logged under a `[startup]` prefix and the code is 1.
 */
export function dieOnStartupFailure(started: Promise<unknown>, exit: Exit = defaultExit): void {
  started.catch((err) => {
    console.error('[startup] fatal: the service could not start:', err);
    exitAfterFlush(exit, 1);
  });
}

/**
 * Run the shutdown close step so it cannot reject.
 *
 * `shutdown` was `async () => { …; await closePool(); process.exit(0); }` and was
 * handed to `process.on('SIGTERM')`, which ignores the promise it returns. A
 * `closePool()` rejection therefore became an unhandled rejection that killed the
 * process BEFORE its own `process.exit(0)` — so a clean, requested stop reported
 * itself as a crash, and the pool error was never printed.
 *
 * Exit code 0 is kept on the failure path on purpose: the operator asked the process
 * to stop and it stopped. A pool that would not close is worth a log, not a lie about
 * why the container went away.
 */
export async function shutdownSafely(close: () => Promise<unknown>, exit: Exit = defaultExit): Promise<void> {
  try {
    await close();
  } catch (err) {
    console.error('[shutdown] closing the pool failed; exiting anyway:', err);
  }
  exitAfterFlush(exit, 0);
}

/**
 * A BACKSTOP, and it is worth being blunt about what that word means here.
 *
 * This converts a silent process death into a logged one. **It changes nothing about
 * correctness.** The rejection is still unhandled, the work still did not happen, and
 * the process still exits — the only difference is that the log now says which
 * promise it was instead of leaving an operator with a container that vanished.
 *
 * It is NOT a reason to leave a rejection unhandled anywhere, and it must never be
 * cited as one. It exists because the #133 sweep left three sites classified as
 * unreachable by READING rather than by exercise (chat.ts:1427, chat.ts:1713,
 * terminal-proxy.ts:341), and a reasoned "cannot happen" deserves a log for the day
 * it happens anyway.
 *
 * The explicit `exit(1)` preserves Node 20's default: registering a listener would
 * otherwise SUPPRESS the exit, which would turn this backstop into a behaviour change
 * — a process left running in an unknown state after a rejection nobody handled.
 */
export function installUnhandledRejectionBackstop(exit: Exit = defaultExit): void {
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] unhandled promise rejection — exiting (this is a backstop, not a fix):', reason);
    exitAfterFlush(exit, 1);
  });
}
