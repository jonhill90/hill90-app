// MODULE SCOPE, not global — see scripts/check-test-module-scope.js and the
// sibling workflow-scheduler-*.test.ts files' own comments on why this is
// load bearing (TS2451 across files that both declare top-level `const`s).
export {}

/**
 * app#485. `computeNextRun` used to catch any parse failure internally and
 * return `null` — indistinguishable from the one LEGITIMATE null case (a
 * webhook-triggered workflow, which stores no schedule_cron by design).
 * Every caller did `if (next) { UPDATE ... }` and otherwise did nothing at
 * all: no log, no error row, no signal of any kind. A workflow whose cron
 * became unparseable (route-side validation closes the main way this
 * happens going forward, but a legacy row or a future stricter cron-parser
 * version could still hit it) silently and permanently stopped running.
 *
 * Two of the three call sites had a second problem: the "agent not
 * running" skip branch only updated next_run_at `if (next)`, so on a cron
 * failure it left next_run_at at its previous (already-past) value — the
 * row stays "due" and re-hits this exact branch every 60s tick forever.
 *
 * THIS TEST PROVES: (1) a cron failure is now recorded as a workflow_runs
 * row with status='error' and a reason, the same way a dispatch failure
 * already is; (2) next_run_at is explicitly cleared (not left stale) so
 * the row stops being "due" on the next tick.
 *
 * WHAT THIS DOES NOT PROVE: that the route-side validation (routes/
 * workflows.ts, routes/agents.ts — see cron-validation.test.ts and
 * agents-schedule-cron-validation.test.ts) actually prevents a bad cron
 * from being written in the first place; this file only covers the
 * scheduler's own defense once such a row exists.
 */
const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery, connect: async () => ({ query: mockQuery, release: () => {} }) }),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: mockQuery }),
}));

const mockDispatchChatWork = jest.fn();
jest.mock('../services/chat-dispatch', () => ({
  dispatchChatWork: (...args: unknown[]) => mockDispatchChatWork(...args),
}));

const BAD_CRON = '99 99 99 99 99'; // right field count, every field out of range

function sqlFor(pattern: RegExp) {
  return mockQuery.mock.calls.filter((c) => pattern.test(String(c[0])));
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [{ id: 'row-1' }] });
  mockDispatchChatWork.mockReset();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  jest.resetModules();
});

describe('a workflow with an unparseable cron', () => {
  it('POSITIVE CONTROL: the agent-not-running skip branch records a failure and clears next_run_at, instead of going silent', async () => {
    const { executeWorkflow } = await import('../services/workflow-scheduler');

    await executeWorkflow({ query: mockQuery }, {
      id: 'wf-1', name: 'Broken Nightly', schedule_cron: BAD_CRON,
      prompt: 'do the thing', agent_id: 'uuid-1', agent_slug: 'scout',
      agent_status: 'stopped', created_by: 'owner-1', allowed_models: ['gpt-4o-mini'],
    });

    // THE ASSERTION THAT MATTERS: a human looking at this workflow's
    // history sees why it stopped, the same shape a dispatch failure uses.
    const failureInserts = sqlFor(/INSERT INTO workflow_runs.*status.*'error'/s);
    expect(failureInserts).toHaveLength(1);
    expect(failureInserts[0][1][1]).toMatch(/cron expression.*is invalid/);

    // next_run_at must be explicitly cleared, not left at its stale
    // (already-past) value — otherwise this row is "due" again next tick.
    const updates = sqlFor(/UPDATE workflows SET next_run_at/);
    expect(updates).toHaveLength(1);
    expect(updates[0][1][0]).toBeNull();
  });

  it('TWIN: the post-execution branch (agent running, dispatch happens) also records the failure and clears next_run_at', async () => {
    mockDispatchChatWork.mockResolvedValue({ accepted: true, work_id: 'work-1' });

    const { executeWorkflow } = await import('../services/workflow-scheduler');

    await executeWorkflow({ query: mockQuery }, {
      id: 'wf-1', name: 'Broken Nightly', schedule_cron: BAD_CRON,
      prompt: 'do the thing', agent_id: 'uuid-1', agent_slug: 'scout',
      agent_status: 'running', created_by: 'owner-1', allowed_models: ['gpt-4o-mini'],
    });

    const failureInserts = sqlFor(/INSERT INTO workflow_runs.*status.*'error'/s);
    expect(failureInserts).toHaveLength(1);
    expect(failureInserts[0][1][1]).toMatch(/cron expression.*is invalid/);

    const updates = sqlFor(/UPDATE workflows SET last_run_at = NOW\(\), next_run_at/);
    expect(updates).toHaveLength(1);
    expect(updates[0][1][0]).toBeNull();
  });

  it('GUARD RAIL: a valid cron on the same skip branch still advances next_run_at normally, with no failure row', async () => {
    const { executeWorkflow } = await import('../services/workflow-scheduler');

    await executeWorkflow({ query: mockQuery }, {
      id: 'wf-1', name: 'Healthy Nightly', schedule_cron: '0 9 * * *',
      prompt: 'do the thing', agent_id: 'uuid-1', agent_slug: 'scout',
      agent_status: 'stopped', created_by: 'owner-1', allowed_models: ['gpt-4o-mini'],
    });

    expect(sqlFor(/INSERT INTO workflow_runs.*status.*'error'/s)).toHaveLength(0);
    const updates = sqlFor(/UPDATE workflows SET next_run_at/);
    expect(updates).toHaveLength(1);
    expect(updates[0][1][0]).toBeInstanceOf(Date);
  });
});
