/**
 * Uptime corrected from Docker's own container timestamps where Docker can
 * still answer, instead of always guessing NOW() (#285, following #213).
 *
 * THE DECISION, stated before any code was written:
 *
 * `agent_sessions` already models one CONTAINER's full lifetime under this
 * codebase, not a looser "agent lifetime" spanning restarts — there is no
 * `/restart` route and no `container.restart()` call anywhere in this service
 * (`grep -rn "\.restart(" services/api/src` returns nothing). Every start
 * creates a brand-new container (`createAndStartContainer`) and every stop
 * removes it (`stopAndRemoveContainer`). So a session row and a container's
 * existence already correspond 1:1 in the normal case, and using Docker's own
 * `FinishedAt` to correct a GUESSED close is filling in a number the two
 * already agree should exist — not redefining what uptime means.
 *
 * THE WRINKLE THAT NARROWS THE SCOPE: the container is created with
 * `RestartPolicy: { Name: 'unless-stopped' }` (docker.ts:137). A single
 * container can crash and be restarted by the DAEMON, invisibly to this
 * service, without a new `agent_sessions` row. That makes `State.StartedAt`
 * an UNSAFE substitute for `started_at` — it moves on every internal
 * restart, and correcting `started_at` from it would make a crash-looping
 * agent's reported uptime SHRINK below the session the user actually asked
 * for. So this stays scoped to the STOP side only: `State.FinishedAt`, read
 * at the moment the reconciler observes a container present but not running,
 * is the exact instant that specific run ended, and only the reconciler's
 * session CLOSE is corrected by it. `started_at` is untouched — this file
 * does not test it because nothing about it changed.
 *
 * WHAT STILL CANNOT BE KNOWN: once a container is fully removed (`docker
 * rm`, `stopAndRemoveContainer`, disk pressure, a human), Docker has no
 * history left to query — and Docker's own zero-value sentinel for "never
 * finished" (`0001-01-01T00:00:00Z`) collapses with "gone" from this API's
 * point of view. Both cases keep today's NOW()-and-estimated close,
 * unchanged. The TWIN tests below exist so this stays true: new code sitting
 * next to the old path must not make it start looking exact by accident.
 *
 * NO BACKFILL. Sessions already closed with an estimate stay estimated
 * forever — by the time this ships, the container that could have answered
 * is in almost every case long gone, and asking Docker for a timestamp of a
 * container that may since have been reused would be inventing a number, not
 * recovering one. That is a stated scope boundary, not a silent recompute:
 * no migration or backfill script touches an existing `agent_sessions` row.
 */
const mockContainerInspect = jest.fn();
jest.mock('dockerode', () =>
  jest.fn().mockImplementation(() => ({
    getContainer: () => ({ inspect: mockContainerInspect }),
  })),
);

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery, connect: async () => ({ query: mockQuery, release: () => {} }) }),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({ query: mockQuery }),
}));
jest.mock('../services/notifications', () => ({ notify: jest.fn() }));

import { runReconcilePass } from '../services/agent-reconciler';
import { resetStatusVerification } from '../services/agent-status-verification';

const sessionWrites = () =>
  mockQuery.mock.calls.filter((c) => /UPDATE agent_sessions/i.test(String(c[0])));

/** The agents-table UPDATE the reconciler's demote/promote patch issued. */
const agentsPatchUpdate = () =>
  mockQuery.mock.calls.find((c) => /^UPDATE agents SET/i.test(String(c[0])) && /status = \$1/.test(String(c[0])));

function agentRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'uuid-1', agent_id: 'test-agent', status: 'running',
    container_id: 'c1', container_state: 'running',
    created_by: 'admin-user', model_router_exp: null,
    ...over,
  };
}

beforeEach(() => {
  mockQuery.mockReset();
  mockContainerInspect.mockReset();
  resetStatusVerification();
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
});

afterEach(() => {
  delete process.env.DATABASE_URL;
});

describe('the reconciler closes a demoted session with an exact time when Docker still has one', () => {
  it('POSITIVE CONTROL: a container still present in an exited state supplies the real FinishedAt', async () => {
    // container_state: 'exited', not the fixture default 'running' — app#534
    // made a first sighting of "exited" record-only rather than an immediate
    // demotion (unless-stopped gets one pass to revive it), so this row
    // represents the SECOND pass, the one where a demotion — and the
    // FinishedAt this test is actually about — happens at all.
    mockQuery.mockResolvedValueOnce({ rows: [agentRow({ container_state: 'exited' })] });
    mockContainerInspect.mockResolvedValue({
      Id: 'c1',
      State: { Status: 'exited', FinishedAt: '2026-08-01T03:04:05.000Z' },
      Config: { Labels: { 'managed-by': 'hill90-api' } },
    });
    mockQuery.mockResolvedValue({ rows: [] });

    await runReconcilePass();

    // The exact timestamp Docker reported is carried onto the agents row...
    const patch = agentsPatchUpdate();
    expect(patch).toBeDefined();
    expect(String(patch![0])).toMatch(/container_finished_at/);
    const patchParams = patch![1] as unknown[];
    const stamped = patchParams.find((p) => p instanceof Date) as Date | undefined;
    expect(stamped?.toISOString()).toBe('2026-08-01T03:04:05.000Z');

    // ...and the sweep that closes the session reads it instead of guessing.
    const closes = sessionWrites();
    expect(closes).toHaveLength(1);
    expect(String(closes[0][0])).toMatch(/container_finished_at/);
    expect(String(closes[0][0])).not.toMatch(/stopped_at_estimated = TRUE/);
  });

  it('treats Docker\'s zero-value FinishedAt as unavailable, not as a real timestamp', async () => {
    // Docker reports "0001-01-01T00:00:00Z" for a container that never
    // finished (still running, or created but never started). A reconciler
    // this trusting would stamp every open agent's eventual close a few
    // thousand years in the past the moment it ever WAS demoted for any
    // other transient reason.
    // Same app#534 reasoning as the POSITIVE CONTROL above: container_state
    // starts 'exited' so this pass is the confirmed one, where a demotion —
    // and the zero-value handling this test exists to check — actually
    // happens. On a first-sighting fixture this assertion would still pass,
    // but vacuously: a record-only write never carries containerFinishedAt
    // at all, matching "no Date" regardless of what FinishedAt said.
    mockQuery.mockResolvedValueOnce({ rows: [agentRow({ container_state: 'exited' })] });
    mockContainerInspect.mockResolvedValue({
      Id: 'c1',
      State: { Status: 'exited', FinishedAt: '0001-01-01T00:00:00Z' },
      Config: { Labels: { 'managed-by': 'hill90-api' } },
    });
    mockQuery.mockResolvedValue({ rows: [] });

    await runReconcilePass();

    const patch = agentsPatchUpdate();
    expect(patch).toBeDefined();
    // agentsPatchUpdate()'s SQL-shape finder matches a record-only write too
    // (it also sets `status = $1`, just to the unchanged value) — the actual
    // status VALUE is what proves this was a real demotion and not that.
    expect((patch![1] as unknown[])[0]).toBe('stopped');
    const patchParams = (patch?.[1] as unknown[]) || [];
    expect(patchParams.some((p) => p instanceof Date)).toBe(false);

    const closes = sessionWrites();
    expect(String(closes[0][0])).toMatch(/stopped_at_estimated/);
  });

  it('TWIN: a container that has genuinely vanished still gets an estimated close', async () => {
    // Must behave exactly as before this change — Docker has nothing to
    // offer once the container object itself is gone. If this test ever
    // starts asserting an exact time, the code has stopped telling the
    // difference between "gone" and "present but stopped".
    mockQuery.mockResolvedValueOnce({ rows: [agentRow({ agent_id: 'ghost' })] });
    const gone: any = new Error('no such container');
    gone.statusCode = 404;
    mockContainerInspect.mockRejectedValue(gone);
    mockQuery.mockResolvedValue({ rows: [] });

    await runReconcilePass();

    const patch = agentsPatchUpdate();
    const patchParams = (patch?.[1] as unknown[]) || [];
    expect(patchParams.some((p) => p instanceof Date)).toBe(false);

    const closes = sessionWrites();
    expect(closes).toHaveLength(1);
    expect(String(closes[0][0])).toMatch(/stopped_at_estimated/);
  });

  it('a promotion clears any container_finished_at left by a PRIOR session, so the next close cannot inherit it', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [agentRow({ status: 'stopped', container_id: null, container_state: 'exited' })],
    });
    mockContainerInspect.mockResolvedValue({
      Id: 'c2', State: { Status: 'running' }, Config: { Labels: { 'managed-by': 'hill90-api' } },
    });
    mockQuery.mockResolvedValue({ rows: [] });

    await runReconcilePass();

    const patch = agentsPatchUpdate();
    expect(patch).toBeDefined();
    expect(String(patch![0])).toMatch(/container_finished_at/);
    const patchParams = patch![1] as unknown[];
    expect(patchParams).toContain(null);
  });
});

// POST /agents/:id/start clearing container_finished_at is covered in
// routes-agents.test.ts, alongside its "starts agent for admin" sibling —
// that file already carries the correct whole-module mock of
// '../services/docker' for the /start route. jest.mock() is hoisted to the
// top of a FILE, not a describe() block, so a second, differently-shaped
// mock of the same module cannot coexist here with the reconciler tests
// above, which need the REAL docker.ts running against a mocked `dockerode`.
