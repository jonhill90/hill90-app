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
 */
export function isValidCronExpression(expr: string): boolean {
  try {
    CronExpressionParser.parse(expr);
    return true;
  } catch {
    return false;
  }
}
