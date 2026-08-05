/**
 * helpers/cron.ts's isValidCronExpression is the single validity check now
 * shared by routes/workflows.ts and routes/agents.ts's schedule route
 * (app#487) — before this, each had its own hand-rolled check that
 * disagreed both with each other and with cron-parser, the library the
 * scheduler actually parses with at run time.
 */
import { isValidCronExpression } from '../helpers/cron';

describe('isValidCronExpression', () => {
  it('POSITIVE CONTROL: a normal 5-field cron is valid', () => {
    expect(isValidCronExpression('0 9 * * *')).toBe(true);
  });

  it('accepts a 6-field (with-seconds) cron — routes/workflows.ts already allowed this, ' +
     'routes/agents.ts previously did not; unifying widens agents.ts rather than narrowing workflows.ts', () => {
    expect(isValidCronExpression('0 */5 * * * *')).toBe(true);
  });

  it('THE DEFECT THIS CLOSES: rejects a cron with the right field count but out-of-range values', () => {
    // Passed both prior hand-rolled checks — field-count (workflows.ts) and
    // a regex permitting any digit sequence (agents.ts) — but is not a real
    // cron expression by cron-parser's own rules.
    expect(isValidCronExpression('99 99 99 99 99')).toBe(false);
    expect(isValidCronExpression('60 * * * *')).toBe(false); // minute field: max is 59
  });

  it('rejects a string with too many fields', () => {
    // cron-parser pads a SHORT field list with implicit leading wildcards
    // (verified directly: '* * *' parses successfully) — that leniency is
    // the library's own behavior, not something this wrapper adds or could
    // narrow without diverging from what the scheduler itself accepts. Too
    // many fields is unambiguously rejected either way.
    expect(isValidCronExpression('* * * * * * *')).toBe(false);
  });

  it('rejects a non-cron string', () => {
    expect(isValidCronExpression('not a cron')).toBe(false);
  });
});
