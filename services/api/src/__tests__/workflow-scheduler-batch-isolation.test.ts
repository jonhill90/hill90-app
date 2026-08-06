// MODULE SCOPE, not global — see scripts/check-test-module-scope.js and the
// identical note in the sibling workflow-scheduler test files.
export {}

/**
 * app#469. tick()'s loop had no try/catch around `await executeWorkflow(pool, wf)`.
 * executeWorkflow itself still has a handful of writes outside its own internal
 * try/catch (the initial workflow_runs insert, the agent-not-running skip's
 * next_run_at update, and the final next_run_at advance) — almost always a DB
 * blip, not a defect in the workflow's own config. Before this fix, any one of
 * those throwing aborted the WHOLE for-loop: with ten due workflows and the
 * third one hitting a blip, the seventh through tenth never ran at all, and
 * nothing distinguished that tick from one where only three were genuinely due.
 *
 * THE ASSERTION THAT MATTERS is not that the first workflow in a batch runs —
 * that proves nothing about abandonment, since the pre-fix loop got that far
 * too. It is that workflows AFTER a throwing one still run in the same tick.
 */
const mockQuery = jest.fn()
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery, connect: async () => ({ query: mockQuery, release: () => {} }) }),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: mockQuery }),
}))

const mockDispatchChatWork = jest.fn()
jest.mock('../services/chat-dispatch', () => ({
  dispatchChatWork: (...args: unknown[]) => mockDispatchChatWork(...args),
}))

function workflow(id: string, name: string) {
  return {
    id, name, schedule_cron: '0 0 * * *', prompt: 'do the thing',
    agent_id: `agent-${id}`, agent_slug: `scout-${id}`, agent_status: 'running',
    created_by: 'owner-1', allowed_models: ['gpt-4o-mini'],
  }
}

const WF1 = workflow('wf-1', 'First')
const WF2 = workflow('wf-2', 'Second — throws')
const WF3 = workflow('wf-3', 'Third')

function sqlFor(pattern: RegExp) {
  return mockQuery.mock.calls.filter((c) => pattern.test(String(c[0])))
}

beforeEach(() => {
  mockQuery.mockReset()
  mockDispatchChatWork.mockReset()
  mockDispatchChatWork.mockResolvedValue({ accepted: true })
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test'
})

afterEach(() => {
  delete process.env.DATABASE_URL
  jest.resetModules()
})

describe("one workflow's failure does not abandon the rest of the tick's batch", () => {
  it('CONTROL, the pre-fix shape: a throw from the middle workflow would have aborted the whole loop — reproduced directly against the old code shape, not asserted from a description', async () => {
    // Same fixtures, same throw — but calling the OLD, unguarded loop body
    // directly (no try/catch around executeWorkflow), so this control can
    // actually fail if the fix's own test below is somehow vacuous.
    mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/INSERT INTO workflow_runs \(workflow_id, status\)/.test(sql) && params?.[0] === 'wf-2') {
        throw new Error('simulated DB blip for wf-2')
      }
      return { rows: [{ id: 'row-1' }] }
    })

    const { executeWorkflow } = await import('../services/workflow-scheduler')

    const oldLoop = async (pool: unknown, due: unknown[]) => {
      for (const wf of due) {
        await executeWorkflow(pool, wf) // no try/catch — the pre-fix shape
      }
    }

    await expect(oldLoop({ query: mockQuery }, [WF1, WF2, WF3])).rejects.toThrow('simulated DB blip for wf-2')

    // wf-1 ran (dispatched); wf-3 never got the chance — this is exactly
    // the abandonment app#469 is about, reproduced directly.
    expect(mockDispatchChatWork).toHaveBeenCalledTimes(1)
    expect(mockDispatchChatWork.mock.calls[0][0].agentId).toBe('scout-wf-1')
  })

  it('THE FIX: tick() contains a throwing workflow to itself — the ones after it still run', async () => {
    mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] }
      if (/pg_advisory_unlock/.test(sql)) return { rows: [] }
      if (/FROM workflows w\s+JOIN agents a/.test(sql)) return { rows: [WF1, WF2, WF3] }
      if (/INSERT INTO workflow_runs \(workflow_id, status\)/.test(sql) && params?.[0] === 'wf-2') {
        throw new Error('simulated DB blip for wf-2')
      }
      return { rows: [{ id: 'row-1' }] }
    })

    const { tick } = await import('../services/workflow-scheduler')
    await expect(tick()).resolves.not.toThrow()

    // THE ASSERTION THAT MATTERS: wf-1 AND wf-3 both dispatched. wf-3 is
    // what a test asserting only "the first one ran" could never prove.
    const dispatchedAgents = mockDispatchChatWork.mock.calls.map((c) => c[0].agentId)
    expect(dispatchedAgents).toContain('scout-wf-1')
    expect(dispatchedAgents).toContain('scout-wf-3')
    expect(dispatchedAgents).not.toContain('scout-wf-2') // it threw before ever reaching dispatch

    // The failure is recorded against wf-2 specifically, not swallowed and
    // not blamed on a neighbour.
    const failureInserts = sqlFor(/INSERT INTO workflow_runs \(workflow_id, status, error/)
    const wf2Failures = failureInserts.filter((c) => c[1]?.[0] === 'wf-2')
    expect(wf2Failures.length).toBeGreaterThan(0)
    expect(String(wf2Failures[0][1][1])).toMatch(/simulated DB blip for wf-2/)
  })

  it('the abandoned-then-recovered workflow is not left worse off than before: next_run_at is untouched, so it retries next tick rather than being silently skipped forever', async () => {
    mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] }
      if (/pg_advisory_unlock/.test(sql)) return { rows: [] }
      if (/FROM workflows w\s+JOIN agents a/.test(sql)) return { rows: [WF1, WF2] }
      if (/INSERT INTO workflow_runs \(workflow_id, status\)/.test(sql) && params?.[0] === 'wf-1') {
        throw new Error('simulated DB blip for wf-1')
      }
      return { rows: [{ id: 'row-1' }] }
    })

    const { tick } = await import('../services/workflow-scheduler')
    await tick()

    // wf-1 threw before ever reaching its own next_run_at advance, so no
    // UPDATE workflows ... WHERE id = 'wf-1' should exist — it stays due.
    const updates = sqlFor(/UPDATE workflows SET last_run_at/)
    const wf1Updates = updates.filter((c) => c[1]?.[1] === 'wf-1' || c[1]?.[2] === 'wf-1')
    expect(wf1Updates).toHaveLength(0)

    // wf-2, unaffected, completed normally and advanced its own next_run_at.
    const dispatchedAgents = mockDispatchChatWork.mock.calls.map((c) => c[0].agentId)
    expect(dispatchedAgents).toContain('scout-wf-2')
  })
})
