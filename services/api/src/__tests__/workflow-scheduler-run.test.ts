// MODULE SCOPE, not global — see scripts/check-test-module-scope.js. Without
// this, `mockQuery` and `WORKFLOW` below are global and collide with the
// identically-named declarations in workflow-scheduler-error-recording-guard
// .test.ts, which is what turned `main` red with TS2451. Load bearing.
export {}

/**
 * The scheduled-run path, called by a test for the first time.
 *
 * THE DEFECT. `workflow-scheduler.ts` inserted into
 * `chat_messages (thread_id, sender_id, sender_type, …)`. The columns are
 * `author_id` / `author_type`, so a scheduled run failed on that statement
 * every time. It is the TWIN of `routes/workflows.ts:309` and `:568`, which
 * were fixed in #292/#301 — and missed here, which is the drift this repository
 * keeps meeting.
 *
 * ARMED, NOT LIVE, and the distinction decides the priority. Production has
 * **0 workflows, 0 enabled, 0 runs** (`Verified 2026-08-04`), so nothing has
 * ever reached line 153. Unlike #286's endpoints — which no code path calls at
 * all — this one is armed by DATA: it fires the first time anyone enables a
 * schedule. So the honest framing is "it would fail the first time the feature
 * is used", not "it is failing now".
 *
 * WHY IT SURVIVED is the same reason as #286: nothing called it. This file is
 * the missing call. What it CANNOT prove is that the SQL is valid — the pool is
 * mocked here, exactly as it was in the 97 files that missed #286. That proof
 * is `check_sql_identifiers.sh`, which now walks all of `src` instead of
 * `src/routes` and would have caught this.
 */
const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery, connect: async () => ({ query: mockQuery, release: () => {} }) }),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: mockQuery }),
}));
jest.mock('../services/chat-dispatch', () => ({ dispatchToAgents: jest.fn() }));

const WORKFLOW = {
  id: 'wf-1', name: 'Nightly', prompt: 'do the thing',
  agent_id: 'uuid-1', agent_slug: 'scout', agent_status: 'running',
  created_by: 'owner-1', allowed_models: ['gpt-4o-mini'],
};

function sqlFor(pattern: RegExp) {
  return mockQuery.mock.calls.map((c) => String(c[0])).filter((s) => pattern.test(s));
}

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [{ id: 'row-1' }] });
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  process.env.CHAT_CALLBACK_TOKEN = 'cb';
});

afterEach(() => {
  delete process.env.DATABASE_URL;
  jest.resetModules();
});

describe('a scheduled workflow run', () => {
  it('POSITIVE CONTROL: posts its prompt using the columns chat_messages has', async () => {
    const { executeWorkflow } = await import('../services/workflow-scheduler');
    await executeWorkflow({ query: mockQuery }, WORKFLOW);

    const inserts = sqlFor(/INSERT INTO chat_messages/);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatch(/author_id, author_type/);
    expect(inserts[0]).not.toMatch(/sender_id|sender_type/);
  });

  it('records the run rather than failing silently', async () => {
    const { executeWorkflow } = await import('../services/workflow-scheduler');
    await executeWorkflow({ query: mockQuery }, WORKFLOW);

    expect(sqlFor(/INSERT INTO workflow_runs/)).toHaveLength(1);
  });

  it('TWIN: an agent that is not running is skipped before anything is written', async () => {
    // The guard above the insert. Worth pinning while this path is finally
    // reachable by a test at all.
    const { executeWorkflow } = await import('../services/workflow-scheduler');
    await executeWorkflow({ query: mockQuery }, { ...WORKFLOW, agent_status: 'stopped' });

    expect(sqlFor(/INSERT INTO chat_messages/)).toHaveLength(0);
  });
});
