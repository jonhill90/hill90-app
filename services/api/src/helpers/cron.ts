import { CronExpressionParser } from 'cron-parser';

/**
 * The single cron-string validity check for every endpoint that accepts
 * one. Backed by the same library (and default options) workflow-scheduler.ts
 * uses to actually compute next-run times, so "accepted at write time" can
 * never drift from "parses at run time" into a strict/loose mismatch again —
 * routes/workflows.ts and routes/agents.ts each had their own hand-rolled
 * check before this (a field-count check with no range validation, and a
 * regex permitting out-of-range values like `60` in the minute field),
 * neither of which agreed with what cron-parser itself accepts (app#487).
 *
 * app#580: that claim had one gap of its own. `CronExpressionParser.parse('')`
 * does NOT throw — cron-parser fills unspecified fields with their default
 * (every-minute) range, so an empty string parsed as a genuine, if
 * degenerate, "every minute" schedule and this function returned `true` for
 * it. `computeNextRun` below treats a falsy `cronExpr` as "no schedule" and
 * returns `null` WITHOUT ever calling the parser — so an empty string was
 * simultaneously "valid" here and "no schedule, skip silently" there: the
 * exact strict/loose mismatch this function's own header says it prevents.
 * Rejecting falsy input explicitly closes it at the source, rather than
 * requiring every call site to special-case it — an empty string is never a
 * meaningful cron for anything that actually wants a schedule; a caller
 * that means "no schedule" (a webhook-triggered workflow) already expresses
 * that as `null`/omitted, not `''`, and never reaches this function with it
 * (see routes/workflows.ts's POST /, which requires schedule_cron truthy
 * before this is ever called).
 */
export function isValidCronExpression(expr: string): boolean {
  if (!expr) return false;
  try {
    CronExpressionParser.parse(expr);
    return true;
  } catch {
    return false;
  }
}

/**
 * The single next-run-time computation for every write path that sets
 * next_run_at. Moved here from workflow-scheduler.ts (app#488) so
 * routes/workflows.ts's create path can compute the same value the
 * scheduler would — previously only the scheduler could ever populate
 * next_run_at, via a one-time sweep at process boot, which left every
 * workflow created after boot stuck at next_run_at = NULL until a restart.
 *
 * Throws on an unparseable cron; callers that already validated with
 * isValidCronExpression (same underlying parse) should not see it throw in
 * practice, but callers reached without that check first (i.e.
 * workflow-scheduler.ts's own callers, reading a cron already stored in the
 * database) still need to handle it. `cronExpr` falsy (a webhook-triggered
 * workflow, which stores no schedule_cron by design) is not an error and
 * returns null without throwing.
 */
export function computeNextRun(cronExpr: string | null): Date | null {
  if (!cronExpr) return null;
  const interval = CronExpressionParser.parse(cronExpr);
  return interval.next().toDate();
}
