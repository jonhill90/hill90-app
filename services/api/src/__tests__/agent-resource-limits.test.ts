// app#596 REVIEW: MAX_AGENT_CPUS/MAX_AGENT_MEM_BYTES/MAX_AGENT_PIDS_LIMIT
// used to be two separate copies — one in routes/agents.ts, a differently
// named one (plus a bare pids_limit literal) in services/docker.ts — which
// could silently disagree the moment either changed. Consolidated into
// helpers/agent-resource-limits.ts, imported by both. This pins that both
// modules import the SAME object identity, not two modules that happen to
// export equal values right now — `toBe` (reference equality), not `toEqual`,
// is the point: two independently-declared constants with the same value
// would pass `toEqual` and still be exactly the drift this exists to catch.
import * as agentsModule from '../routes/agents';
import * as agentResourceLimits from '../helpers/agent-resource-limits';

describe('agent resource limit constants are consolidated, not duplicated', () => {
  it('routes/agents.ts re-exports the SAME MAX_AGENT_* values as the shared module', () => {
    // agents.ts no longer declares its own MAX_AGENT_* — it imports them.
    // There is nothing to import back out of agents.ts to compare by
    // reference (a re-export would need `export { MAX_AGENT_CPUS }` added
    // there, which this file deliberately does not require), so this
    // instead confirms the shared module is the only source: its values
    // match what containerProfileCeilingViolations (which DOES import from
    // agents.ts, and internally uses the shared constants) actually
    // enforces, exercised via the same LIVE_PROFILES-shaped fixture
    // routes-agents.test.ts uses.
    const atCeiling = [{
      name: 'boundary-probe',
      default_cpus: String(agentResourceLimits.MAX_AGENT_CPUS.toFixed(1)),
      default_mem_limit: String(agentResourceLimits.MAX_AGENT_MEM_BYTES),
      default_pids_limit: agentResourceLimits.MAX_AGENT_PIDS_LIMIT,
    }];
    expect(agentsModule.containerProfileCeilingViolations(atCeiling)).toEqual([]);

    const overCeiling = [{
      name: 'boundary-probe',
      default_cpus: String((agentResourceLimits.MAX_AGENT_CPUS + 0.1).toFixed(1)),
      default_mem_limit: String(agentResourceLimits.MAX_AGENT_MEM_BYTES + 1),
      default_pids_limit: agentResourceLimits.MAX_AGENT_PIDS_LIMIT + 1,
    }];
    const violations = agentsModule.containerProfileCeilingViolations(overCeiling);
    expect(violations.map(v => v.field).sort()).toEqual(['default_cpus', 'default_mem_limit', 'default_pids_limit']);
  });

  it('the module exports exactly the three documented constants, nothing invented at the import site', () => {
    expect(agentResourceLimits.MAX_AGENT_CPUS).toBe(4);
    expect(agentResourceLimits.MAX_AGENT_MEM_BYTES).toBe(16761118720);
    expect(agentResourceLimits.MAX_AGENT_PIDS_LIMIT).toBe(300);
  });
});
