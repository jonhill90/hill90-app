/**
 * workflow-scheduler.ts's own failure handler — code that only runs once a
 * scheduled workflow dispatch has already failed.
 *
 * THE DEFECT. executeWorkflow's `catch (err) { ... await pool.query(UPDATE
 * workflow_runs SET status = 'error' ...) }` was unguarded. That write only
 * runs because dispatch already failed — plausibly from the same class of
 * DB blip it's about to retry against. If it raised, the new exception
 * propagated OUT of executeWorkflow entirely, skipping the
 * `UPDATE workflows SET last_run_at = NOW(), next_run_at = ...` statement
 * that comes after the try/catch. That statement is what stops the workflow
 * from being "due" again — skipping it means the SAME workflow re-fires on
 * the very next 60s tick, re-running from the top: a new workflow_runs row,
 * a new chat_threads row, new chat_participants, a new chat_messages
 * insert, and a fresh dispatchChatWork call — none of it idempotent. A
 * single unrelated DB blip during error-recording could turn one failed
 * scheduled run into an unbounded loop of duplicate side effects.
 *
 * WHAT THIS TEST PROVES. That a failure while recording a failed run does
 * not prevent next_run_at from advancing. It does not prove the SQL is
 * valid against a real schema — the pool is mocked here, matching the
 * existing sibling file's own stated discipline.
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

const WORKFLOW = {
  id: 'wf-1', name: 'Nightly', schedule_cron: '0 0 * * *',
  prompt: 'do the thing', agent_id: 'uuid-1', agent_slug: 'scout',
  agent_status: 'running', created_by: 'owner-1', allowed_models: ['gpt-4o-mini'],
};

function sqlFor(pattern: RegExp) {
  return mockQuery.mock.calls.map((c) => String(c[0])).filter((s) => pattern.test(s));
}

beforeEach(() => {
  mockQuery.mockReset();
  mockDispatchChatWork.mockReset();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  jest.resetModules();
});

describe('executeWorkflow error-recording write', () => {
  it('a failure recording the error does not prevent next_run_at from advancing', async () => {
    mockDispatchChatWork.mockRejectedValue(new Error('agent unreachable'));

    mockQuery.mockImplementation(async (sql: string) => {
      if (/UPDATE workflow_runs SET status = 'error'/.test(sql)) {
        throw new Error('pool exhausted during error recording');
      }
      return { rows: [{ id: 'row-1' }] };
    });

    const { executeWorkflow } = await import('../services/workflow-scheduler');

    // THE ASSERTION THAT MATTERS: must not throw, even though the
    // error-recording write inside the catch block failed.
    await expect(executeWorkflow({ query: mockQuery }, WORKFLOW)).resolves.not.toThrow();

    // And next_run_at must still have been advanced — the whole point of
    // the guard. Without it, the workflow stays "due" and re-fires (with
    // fresh, non-idempotent side effects) on the very next tick.
    expect(sqlFor(/UPDATE workflows SET last_run_at = NOW\(\), next_run_at/)).toHaveLength(1);
  });

  it('TWIN: when the error-recording write succeeds, next_run_at still advances as before', async () => {
    mockDispatchChatWork.mockRejectedValue(new Error('agent unreachable'));
    mockQuery.mockResolvedValue({ rows: [{ id: 'row-1' }] });

    const { executeWorkflow } = await import('../services/workflow-scheduler');
    await executeWorkflow({ query: mockQuery }, WORKFLOW);

    expect(sqlFor(/UPDATE workflow_runs SET status = 'error'/)).toHaveLength(1);
    expect(sqlFor(/UPDATE workflows SET last_run_at = NOW\(\), next_run_at/)).toHaveLength(1);
  });
});
