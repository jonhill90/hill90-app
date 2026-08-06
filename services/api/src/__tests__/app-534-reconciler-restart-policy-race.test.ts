/**
 * app#534: a single "not running" sighting is not durable truth for a
 * container running `RestartPolicy: unless-stopped` — Docker's OWN restart
 * policy can revive it between this pass's inspect and its UPDATE landing,
 * or at any point before the next scheduled pass, and nothing re-checked.
 *
 * THE ACTUAL RACE, established by reading rather than assumed. Every agent
 * container is created with `RestartPolicy: unless-stopped` (docker.ts:150).
 * `reconcileAgentStatuses`'s demotion branch used to write `status='stopped'`
 * off a single `inspectContainer()` sighting of anything but `running`. If
 * that sighting landed during the window between the container exiting and
 * Docker's own restart policy bringing it back — which for `unless-stopped`
 * can be as little as its ~100ms initial backoff — the row said `stopped`
 * while the container was, or was about to be, running again. Nothing
 * corrects this until the NEXT scheduled pass, up to
 * AGENT_RECONCILE_INTERVAL_MS (default 60s) later — bounded, per the issue's
 * own framing, but not free: `closeSessionsForStoppedAgents`
 * (agent-reconciler.ts) closes any session on `status <> 'running'` on THAT
 * SAME pass, and a session close is not undone by the next pass's promotion.
 * A container that blipped and came straight back left a PERMANENTLY wrong
 * `agent_sessions.stopped_at` behind — worse than the issue's own framing of
 * "the DB says stopped for up to 60s", which undersold the actual cost.
 *
 * WHY THIS IS DETERMINISTIC, NOT A STRESS LOOP. The race is expressed here as
 * "which call number returns which value" — fully controlled by this file,
 * not by wall-clock scheduling against a real daemon. That is strictly
 * better evidence than a probabilistic repro: a stress loop that never
 * reproduces the bug pre-fix proves nothing about whether the fix works,
 * and one that reproduces it 1-in-1000 times still leaves open whether a
 * green run means "fixed" or "got lucky". Every test below instead forces
 * the exact interleaving by feeding the mocked Docker client and the mocked
 * DB row across TWO SEPARATE, explicit `runReconcilePass()` calls, and
 * asserts the actual row state after each — not a probability.
 *
 * THE FIX CHOSEN, AND WHY NOT THE OTHER OPTION. A compare-and-set on the
 * UPDATE (`WHERE status = $previouslyReadStatus`) was considered and
 * rejected: nothing else writes `agents.status` for this row between this
 * pass's own SELECT and UPDATE in the scenario the issue describes — the
 * race is against DOCKER's state, which a CAS against a POSTGRES column
 * cannot observe. It would only guard against an unrelated race (a
 * concurrent human-triggered status write), which is not what #534 reports.
 * Chosen instead: a single momentary "not running" sighting is no longer
 * trusted as authoritative on its own. It is recorded (so the observation
 * is not lost) but not ACTED ON until the row's own container_state — set by
 * the PREVIOUS pass — already agrees, i.e. the sighting has survived one
 * full reconcile interval. `unless-stopped`'s restart backoff is measured in
 * milliseconds to a few seconds in the normal case this issue is about; a
 * whole 60s interval is comfortably past that. CONTAINER_ABSENT (a 404) is
 * exempt and still demotes on first sighting — there is no restart policy to
 * race against a container that no longer exists.
 *
 * WHAT THIS DOES NOT CLAIM. The race is narrowed, not eliminated: a
 * container unlucky enough to be caught still-down on TWO consecutive passes
 * 60s apart — genuinely still cycling, not yet stable either way — still
 * demotes. That is a much smaller, much rarer window than "any single blip",
 * and is stated here rather than left implicit.
 */
const mockContainerInspect = jest.fn();
jest.mock('dockerode', () =>
  jest.fn().mockImplementation(() => ({
    getContainer: () => ({ inspect: mockContainerInspect }),
  })),
);

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery }),
}));

import { runReconcilePass } from '../services/agent-reconciler';
import { resetStatusVerification } from '../services/agent-status-verification';

function agentRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'uuid-1',
    agent_id: 'test-agent',
    status: 'running',
    container_id: 'container-id-123',
    container_state: 'running',
    created_by: 'owner-sub',
    ...over,
  };
}

function selectAgents(rows: Array<ReturnType<typeof agentRow>>) {
  mockQuery.mockResolvedValueOnce({ rows });
}

function container(status: string) {
  return {
    Id: 'container-id-123',
    State: { Status: status },
    Config: { Labels: { 'managed-by': 'hill90-api' } },
  };
}

function vanished() {
  const err: any = new Error('no such container');
  err.statusCode = 404;
  return err;
}

/** The UPDATE the reconciler issued this pass, if it issued one. */
function statusUpdate() {
  return mockQuery.mock.calls.find((c) => String(c[0]).startsWith('UPDATE agents'));
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

describe('app#534 — a momentary exit does not demote on its own', () => {
  it('DETERMINISTIC RACE, arm 1: Docker revives the container before the SECOND pass — never demoted, self-heals', async () => {
    // Pass 1: the container just exited. Docker's own unless-stopped policy
    // has not (yet) restarted it — this is the exact sighting #534 says used
    // to demote immediately.
    selectAgents([agentRow({ status: 'running', container_state: 'running' })]);
    mockContainerInspect.mockResolvedValueOnce(container('exited'));
    const pass1 = await runReconcilePass();

    expect(pass1!.demoted).toBe(0);              // NOT demoted on the first sighting
    expect(statusUpdate()![1][0]).toBe('running'); // status column: unchanged
    expect(statusUpdate()![1][1]).toBe('exited');  // container_state: recorded anyway

    // Pass 2, over the row AS PASS 1 LEFT IT (status still 'running',
    // container_state 'exited') — and by now Docker's restart policy has
    // brought the container back. This is the interleaving #534 names:
    // the container was never durably down, just briefly.
    mockQuery.mockReset();
    selectAgents([agentRow({ status: 'running', container_state: 'exited' })]);
    mockContainerInspect.mockReset();
    mockContainerInspect.mockResolvedValueOnce(container('running'));
    const pass2 = await runReconcilePass();

    expect(pass2!.demoted).toBe(0);
    expect(pass2!.promoted).toBe(0); // nothing to promote — status was never wrongly flipped
    expect(statusUpdate()![1][0]).toBe('running');  // status column: still unchanged, still correct
    expect(statusUpdate()![1][1]).toBe('running');  // container_state: corrected back

    // The row's status column never left 'running' across either pass — the
    // precondition that keeps closeSessionsForStoppedAgents' own
    // `WHERE a.status <> 'running'` from ever matching this row. Before this
    // fix, pass 1 alone would have written 'stopped' and that sweep runs
    // unconditionally every pass, closing the session on data a moment
    // later would have been proven wrong — an artifact the next pass's
    // promotion does not undo.
  });

  it('DETERMINISTIC RACE, arm 2: the container is STILL down on the second pass — demoted, correctly, once confirmed', async () => {
    selectAgents([agentRow({ status: 'running', container_state: 'running' })]);
    mockContainerInspect.mockResolvedValueOnce(container('exited'));
    const pass1 = await runReconcilePass();
    expect(pass1!.demoted).toBe(0);

    mockQuery.mockReset();
    selectAgents([agentRow({ status: 'running', container_state: 'exited' })]);
    mockContainerInspect.mockReset();
    mockContainerInspect.mockResolvedValueOnce(container('exited'));
    const pass2 = await runReconcilePass();

    expect(pass2!.demoted).toBe(1);
    expect(statusUpdate()![1][0]).toBe('stopped');
  });

  it('TWIN: a container that is genuinely ABSENT still demotes on the first sighting — no restart policy to race', async () => {
    selectAgents([agentRow({ status: 'running', container_state: 'running' })]);
    mockContainerInspect.mockRejectedValueOnce(vanished());

    const result = await runReconcilePass();

    expect(result!.demoted).toBe(1);
    expect(statusUpdate()![1][0]).toBe('stopped');
    expect(statusUpdate()![1][1]).toBe('absent');
  });

  it('a container reported RESTARTING mid-policy is treated the same as any other not-yet-confirmed sighting', async () => {
    // Docker's own transitional state while its restart policy is acting —
    // distinct from 'exited', and just as much "not yet safe to trust" as
    // any other non-running sighting for a container that still exists.
    selectAgents([agentRow({ status: 'running', container_state: 'running' })]);
    mockContainerInspect.mockResolvedValueOnce(container('restarting'));

    const result = await runReconcilePass();

    expect(result!.demoted).toBe(0);
    expect(statusUpdate()![1][0]).toBe('running');
    expect(statusUpdate()![1][1]).toBe('restarting');
  });
});
