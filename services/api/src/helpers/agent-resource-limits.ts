// Container resource ceilings for agent create/import/update AND for the
// point these values actually reach Docker (createAndStartContainer).
//
// app#596 REVIEW: this used to be two separate copies — MAX_AGENT_CPUS/
// MAX_AGENT_MEM_BYTES/MAX_AGENT_PIDS_LIMIT here in routes/agents.ts, and a
// second, differently-named MAX_CPUS/MAX_MEM_BYTES (plus a bare, uncommented
// `300` literal for pids) in services/docker.ts. That is exactly the
// two-files-apart drift this fix's own containerProfileCeilingViolations()
// invariant exists to catch elsewhere — reading agents.ts's constants only,
// it would have passed green while docker.ts silently enforced a different
// number. A module with no behavior and no dependencies is what makes this
// importable from BOTH call sites without recreating the mocking hazard
// (see the comment on each validator below) — nothing mocks a constants
// module, since there is nothing on it to mock.
//
// TWO DIFFERENT DERIVATIONS, STATED EXPLICITLY so neither reads as
// coincidental or as the other one's reasoning:
//
//   MAX_AGENT_CPUS and MAX_AGENT_MEM_BYTES are HOST CAPACITY. `nproc` /
//   `docker info --format '{{.NCPU}}'` / `'{{.MemTotal}}'` on the VPS,
//   Verified 2026-08-06: 4 CPUs, 16761118720 bytes RAM (used as the literal
//   byte ceiling, not rounded up — rounding up would license a value the
//   host cannot actually back). This is a hard physical bound: nothing can
//   ever legitimately need more than the entire machine, and for cpus
//   specifically Docker already enforces it structurally. It is NOT derived
//   from container_profiles — the `browser` profile's own default_cpus/
//   default_mem_limit (2.0 / 2g) are HALF this ceiling, and that is
//   incidental, not the reason for the number. If the VPS is ever resized,
//   THESE TWO need a deliberate update to match the new hardware.
//
//   MAX_AGENT_PIDS_LIMIT is PROFILE-DERIVED, not host-derived, because
//   there is no host-capacity number that plays the same role: the kernel's
//   own ceiling (`/proc/sys/kernel/pid_max`, 4194304 on this host) is a
//   system-wide figure four orders of magnitude too loose to serve as a
//   per-container fork-bomb bound — capping at it would accept anything a
//   real attack would use. 300 is the largest `default_pids_limit` among
//   the live `container_profiles` rows (`browser` — Playwright/Chromium,
//   the heaviest process footprint any current platform-defined use case
//   needs), Verified 2026-08-06 against production Postgres. If a profile
//   needing more than 300 processes is added, THIS ONE needs a deliberate
//   update.
//
// INVARIANT THIS SERVICE ENFORCES, not just states: every MAX_AGENT_* must
// stay >= the corresponding default_* across every container_profiles row,
// always — see containerProfileCeilingViolations in routes/agents.ts and
// its startup wiring in index.ts.
export const MAX_AGENT_CPUS = 4;
export const MAX_AGENT_MEM_BYTES = 16761118720;
export const MAX_AGENT_PIDS_LIMIT = 300;
