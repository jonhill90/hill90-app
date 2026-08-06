import Docker from 'dockerode';
import { Readable, Transform } from 'stream';

function createDockerClient(): Docker {
  const dockerHost = process.env.DOCKER_HOST;
  if (!dockerHost) {
    return new Docker({ socketPath: '/var/run/docker.sock' });
  }
  try {
    const url = new URL(dockerHost);
    return new Docker({ host: url.hostname, port: Number(url.port) });
  } catch {
    throw new Error(`Invalid DOCKER_HOST: "${dockerHost}" — expected format: tcp://host:port`);
  }
}

const docker = createDockerClient();

const CONTAINER_PREFIX = 'agentbox-';
const MANAGED_LABEL = 'managed-by';
const MANAGED_VALUE = 'hill90-api';
// Agent container networks.
//
// The names carry a prefix that has to match whatever created the networks. In
// production and in the standalone local stack that is `hill90`; when the app
// is layered onto a local Hill90 infra stack the prefix comes from that repo's
// NETWORK_PREFIX (`hill90local`), so these have to follow. Unset, they resolve
// exactly as before.
const NETWORK_PREFIX = process.env.AGENT_NETWORK_PREFIX || 'hill90';
export const AGENT_NETWORK = `${NETWORK_PREFIX}_agent_internal`;
export const AGENT_SANDBOX_NETWORK = `${NETWORK_PREFIX}_agent_sandbox`;
const VOLUME_SUFFIXES = ['workspace', 'logs', 'data'];

/**
 * Map an agent's effective scope to its Docker network.
 * Deny-by-default: unknown or null scopes get the sandbox network.
 * If new scopes are added to VALID_SCOPES without updating this function,
 * they will default to sandbox (safe).
 */
export function resolveAgentNetwork(scope: string | null): string {
  if (scope === 'host_docker' || scope === 'vps_system') {
    return AGENT_NETWORK;
  }
  return AGENT_SANDBOX_NETWORK;
}

function assertAgentboxName(name: string): void {
  if (!name.startsWith(CONTAINER_PREFIX)) {
    throw new Error(`Refused: container name "${name}" does not start with "${CONTAINER_PREFIX}"`);
  }
}

function assertManagedLabel(labels: Record<string, string> | undefined): void {
  if (!labels || labels[MANAGED_LABEL] !== MANAGED_VALUE) {
    throw new Error(`Refused: container missing label ${MANAGED_LABEL}=${MANAGED_VALUE}`);
  }
}

function assertAgentboxVolume(volumeName: string, agentId: string): void {
  const allowedPattern = `${CONTAINER_PREFIX}${agentId}-`;
  if (!volumeName.startsWith(allowedPattern)) {
    throw new Error(`Refused: volume "${volumeName}" does not match pattern ${allowedPattern}*`);
  }
  const suffix = volumeName.slice(allowedPattern.length);
  if (!VOLUME_SUFFIXES.includes(suffix)) {
    throw new Error(`Refused: volume suffix "${suffix}" not in allowed list [${VOLUME_SUFFIXES.join(', ')}]`);
  }
}

export interface ProfileMetadata {
  extra_env?: string[];
  shm_size?: string;
}

export interface CreateAgentContainerOpts {
  agentId: string;
  hostConfigPath: string;
  cpus: string;
  memLimit: string;
  pidsLimit: number;
  env?: string[];
  network?: string;
  image?: string;
  metadata?: ProfileMetadata;
}

export interface CreateAndStartContainerResult {
  containerId: string;
  /**
   * True when a host_docker/vps_system-scope agent's edge-network attach
   * failed. The container still started — this does not undo that, same
   * as this codebase's other degraded-but-started paths (AKM/model-router
   * token failures, surfaced via routes/agents.ts's `startWarnings`) — but
   * unlike those, nothing previously distinguished "attached" from "didn't,
   * silently caught and logged." Always false for a sandbox-scope agent,
   * which never attempts the attach at all.
   */
  edgeNetworkAttachFailed: boolean;
}

export async function createAndStartContainer(opts: CreateAgentContainerOpts): Promise<CreateAndStartContainerResult> {
  const containerName = `${CONTAINER_PREFIX}${opts.agentId}`;
  assertAgentboxName(containerName);

  // Environment guard
  const hostPath = process.env.AGENTBOX_CONFIG_HOST_PATH;
  if (!hostPath) {
    throw new Error('AGENTBOX_CONFIG_HOST_PATH not set — refusing to create agent container');
  }

  // Collision check: remove existing container with same name
  try {
    const existing = docker.getContainer(containerName);
    const info = await existing.inspect();
    console.log(`[docker] Collision: container ${containerName} already exists (status: ${info.State.Status}), removing`);
    try { await existing.stop(); } catch { /* may already be stopped */ }
    await existing.remove({ force: true });
  } catch (err: any) {
    if (err.statusCode !== 404) throw err;
  }

  const configMount = `${hostPath}/${opts.agentId}`;
  const nanoCpus = Math.round(parseCpus(opts.cpus) * 1e9);
  const memoryBytes = parseMemLimit(opts.memLimit);

  // Build env array with optional profile extra_env
  const envVars = [
    `AGENT_ID=${opts.agentId}`,
    `AGENT_CONFIG=/etc/agentbox/agent.yml`,
    'PATH=/home/agentuser/.local/bin:/data/tools/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ...(opts.env || []),
    ...(opts.metadata?.extra_env || []),
  ];

  // Build HostConfig with optional profile metadata
  const hostConfig: Record<string, any> = {
    Binds: [
      `${configMount}:/etc/agentbox:ro`,
    ],
    Mounts: VOLUME_SUFFIXES.map(suffix => ({
      Type: 'volume' as const,
      Source: `${CONTAINER_PREFIX}${opts.agentId}-${suffix}`,
      Target: suffix === 'workspace' ? '/workspace'
        : suffix === 'logs' ? '/var/log/agentbox'
        : '/data',
      ReadOnly: false,
    })),
    NanoCpus: nanoCpus,
    Memory: memoryBytes,
    PidsLimit: opts.pidsLimit,
    RestartPolicy: { Name: 'unless-stopped' },
    NetworkMode: opts.network || AGENT_SANDBOX_NETWORK,
  };

  if (opts.metadata?.shm_size) {
    hostConfig.ShmSize = parseMemLimit(opts.metadata.shm_size);
  }

  // #228: carry the image's revision onto the CONTAINER.
  //
  // The images have been stamped since #228's first half, and deploy-drift
  // compares them against origin/main four-hourly. An agent started from image
  // X keeps running X after the image is rebuilt to Y — so the alarm finds Y,
  // reports agreement, and is GREEN about code it cannot see. That is worse
  // than silence, and this is the fact it was missing.
  //
  // Absent rather than guessed: an image with no stamp (a hand-built one)
  // leaves the label off, because `check_deploy_drift.sh` already has an
  // honest state for a container that cannot say what it runs — exit 3,
  // RUNNING CODE UNKNOWN — and a made-up value would turn that into a false
  // comparison. A failure to read it never blocks the start: launching an
  // agent is the user's action, the stamp is bookkeeping.
  const imageRef = opts.image || 'hill90/agentbox:latest';
  let imageRevision: string | undefined;
  try {
    const imageInfo: any = await docker.getImage(imageRef).inspect();
    const stamp = imageInfo?.Config?.Labels?.['com.hill90.revision'];
    if (typeof stamp === 'string' && stamp.trim() !== '') imageRevision = stamp.trim();
  } catch (err) {
    console.warn(`[docker] Could not read ${imageRef}'s revision label; the agent container will carry none:`, err);
  }

  const container = await docker.createContainer({
    Image: imageRef,
    name: containerName,
    Env: envVars,
    Labels: {
      [MANAGED_LABEL]: MANAGED_VALUE,
      'traefik.enable': 'false',
      ...(imageRevision ? { 'com.hill90.revision': imageRevision } : {}),
    },
    HostConfig: hostConfig,
  });

  await container.start();

  // Agents with host_docker or vps_system scope need external internet access.
  // The primary network (agent_internal) is internal-only, so we attach the
  // edge network as a secondary to provide DNS + outbound HTTP.
  let edgeNetworkAttachFailed = false;
  if (opts.network === AGENT_NETWORK) {
    try {
      const edgeNetwork = docker.getNetwork('hill90_edge');
      await edgeNetwork.connect({ Container: containerName });
    } catch (err) {
      console.error(`[docker] Failed to attach edge network to ${containerName}:`, err);
      edgeNetworkAttachFailed = true;
    }
  }

  const info = await container.inspect();
  return { containerId: info.Id, edgeNetworkAttachFailed };
}

export async function stopAndRemoveContainer(agentId: string): Promise<void> {
  const containerName = `${CONTAINER_PREFIX}${agentId}`;
  assertAgentboxName(containerName);

  const container = docker.getContainer(containerName);
  const info = await container.inspect();
  assertManagedLabel(info.Config.Labels);

  try { await container.stop(); } catch { /* may already be stopped */ }
  await container.remove({ force: true });
}

/**
 * Docker's own sentinel for "this has never finished" — not epoch zero, a
 * literal zero-value `time.Time`. Reported for a container that is currently
 * running, or was created but never started. Treated as "unknown", not as a
 * real (and wildly wrong) instant in the year 1 (#285).
 */
const DOCKER_ZERO_TIME = '0001-01-01T00:00:00Z';

function parseDockerTimestamp(raw: string | undefined): Date | null {
  if (!raw || raw === DOCKER_ZERO_TIME) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function inspectContainer(agentId: string): Promise<{
  status: string;
  containerId: string;
  health?: string;
  /**
   * The instant Docker recorded this container's most recent run ending —
   * exact, when Docker can still answer (#285). Only meaningful once the
   * container has stopped; a running container's `FinishedAt` is the zero
   * sentinel and comes back `null` here, same as one that never started.
   */
  finishedAt: Date | null;
  /**
   * The instant Docker recorded this container's CURRENT run starting
   * (#285's second half). SAFE TO TRUST ONLY IMMEDIATELY AFTER
   * `createAndStartContainer` RETURNS, in the same request that created the
   * container — see the call site in routes/agents.ts, which explains why.
   * Containers here run `RestartPolicy: unless-stopped` (#285's first half,
   * #326), so the daemon can restart one invisibly to this service at any
   * later point; read this during ongoing reconciliation, or any time after
   * the moment of creation, and it describes the LATEST restart, not the
   * session this row is trying to record. That is exactly the hazard that
   * scoped #326 down to the stop side only, and it applies here just as much
   * — this field does not remove the hazard, it is only safe at one specific
   * moment where the hazard cannot yet exist.
   */
  startedAt: Date | null;
} | null> {
  const containerName = `${CONTAINER_PREFIX}${agentId}`;
  assertAgentboxName(containerName);

  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();
    assertManagedLabel(info.Config.Labels);

    return {
      status: info.State.Status,
      containerId: info.Id,
      health: info.State.Health?.Status,
      finishedAt: parseDockerTimestamp(info.State.FinishedAt),
      startedAt: parseDockerTimestamp(info.State.StartedAt),
    };
  } catch (err: any) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

export async function getContainerStats(agentId: string): Promise<{
  cpu_percent: number;
  memory_usage_mb: number;
  memory_limit_mb: number;
  memory_percent: number;
  pids: number;
  net_rx_mb: number;
  net_tx_mb: number;
} | null> {
  const containerName = `${CONTAINER_PREFIX}${agentId}`;
  assertAgentboxName(containerName);

  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();
    assertManagedLabel(info.Config.Labels);
    if (info.State.Status !== 'running') return null;

    const stats: any = await container.stats({ stream: false });

    // CPU percentage: delta usage / delta system * num CPUs * 100
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats.cpu_usage?.total_usage || 0);
    const systemDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats.system_cpu_usage || 0);
    const numCpus = stats.cpu_stats.online_cpus || stats.cpu_stats.cpu_usage.percpu_usage?.length || 1;
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * numCpus * 100 : 0;

    // Memory
    const memUsage = stats.memory_stats.usage - (stats.memory_stats.stats?.cache || 0);
    const memLimit = stats.memory_stats.limit;

    // Network (sum all interfaces)
    let netRx = 0;
    let netTx = 0;
    if (stats.networks) {
      for (const iface of Object.values(stats.networks) as any[]) {
        netRx += iface.rx_bytes || 0;
        netTx += iface.tx_bytes || 0;
      }
    }

    return {
      cpu_percent: Math.round(cpuPercent * 100) / 100,
      memory_usage_mb: Math.round((memUsage / 1048576) * 100) / 100,
      memory_limit_mb: Math.round((memLimit / 1048576) * 100) / 100,
      memory_percent: memLimit > 0 ? Math.round((memUsage / memLimit) * 10000) / 100 : 0,
      pids: stats.pids_stats?.current || 0,
      net_rx_mb: Math.round((netRx / 1048576) * 100) / 100,
      net_tx_mb: Math.round((netTx / 1048576) * 100) / 100,
    };
  } catch (err: any) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

export async function getContainerLogs(
  agentId: string,
  opts: { tail?: number; follow?: boolean } = {}
): Promise<NodeJS.ReadableStream> {
  const containerName = `${CONTAINER_PREFIX}${agentId}`;
  assertAgentboxName(containerName);

  const container = docker.getContainer(containerName);
  const info = await container.inspect();
  assertManagedLabel(info.Config.Labels);

  if (opts.follow) {
    return container.logs({
      stdout: true,
      stderr: true,
      tail: opts.tail ?? 200,
      follow: true,
      timestamps: true,
    });
  }

  const buf = await container.logs({
    stdout: true,
    stderr: true,
    tail: opts.tail ?? 200,
    timestamps: true,
  });

  // Buffer case: wrap in a readable stream
  const stream = new Readable();
  stream.push(buf);
  stream.push(null);
  return stream;
}

export async function execInContainer(
  agentId: string,
  cmd: string[],
): Promise<NodeJS.ReadableStream> {
  const containerName = `${CONTAINER_PREFIX}${agentId}`;
  assertAgentboxName(containerName);

  const container = docker.getContainer(containerName);
  const info = await container.inspect();
  assertManagedLabel(info.Config.Labels);

  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: false,
    Tty: false,
  });

  const rawStream = await exec.start({ hijack: true, stdin: false });

  // Docker multiplexed stream: each frame has an 8-byte header.
  // Byte 0: stream type (1=stdout, 2=stderr)
  // Bytes 1-3: padding
  // Bytes 4-7: payload size (big-endian uint32)
  // We strip headers and emit only stdout payload.
  let remainder: Buffer | null = null;
  const demux = new Transform({
    transform(chunk: Buffer, _encoding: string, callback: Function) {
      let buf: Buffer = remainder
        ? Buffer.concat([remainder, chunk])
        : chunk;
      remainder = null;

      let offset = 0;
      while (offset < buf.length) {
        if (offset + 8 > buf.length) {
          remainder = buf.slice(offset);
          break;
        }
        const payloadSize = buf.readUInt32BE(offset + 4);
        const frameEnd = offset + 8 + payloadSize;
        if (frameEnd > buf.length) {
          remainder = buf.slice(offset);
          break;
        }
        const streamType = buf[offset];
        if (streamType === 1) {
          this.push(buf.slice(offset + 8, frameEnd));
        }
        offset = frameEnd;
      }
      callback();
    },
  });
  rawStream.pipe(demux);
  return demux;
}

export async function execInContainerWithExit(
  agentId: string,
  cmd: string[],
  timeoutMs?: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const containerName = `${CONTAINER_PREFIX}${agentId}`;
  assertAgentboxName(containerName);

  const container = docker.getContainer(containerName);
  const info = await container.inspect();
  assertManagedLabel(info.Config.Labels);

  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const rawStream = await exec.start({ hijack: true, stdin: false });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let remainder: Buffer | null = null;

  const streamPromise = new Promise<void>((resolve, reject) => {
    rawStream.on('data', (chunk: Buffer) => {
      let buf: Buffer = remainder ? Buffer.concat([remainder, chunk]) : chunk;
      remainder = null;
      let offset = 0;
      while (offset < buf.length) {
        if (offset + 8 > buf.length) {
          remainder = buf.slice(offset);
          break;
        }
        const payloadSize = buf.readUInt32BE(offset + 4);
        const frameEnd = offset + 8 + payloadSize;
        if (frameEnd > buf.length) {
          remainder = buf.slice(offset);
          break;
        }
        const streamType = buf[offset];
        const payload = buf.slice(offset + 8, frameEnd);
        if (streamType === 1) stdoutChunks.push(payload);
        else if (streamType === 2) stderrChunks.push(payload);
        offset = frameEnd;
      }
    });
    rawStream.on('error', reject);
    rawStream.on('end', () => resolve());
    rawStream.on('close', () => resolve());
  });

  /*
   * THE TIMEOUT MUST BE CANCELLED WHEN THE COMMAND WINS THE RACE.
   *
   * `Promise.race` settles as soon as the command finishes and this function
   * returns — but the timer was left armed for its full window, holding
   * `rawStream` and this closure alive.
   *
   * NOTHING OBSERVED IT, because nothing goes wrong when it finally fires:
   * `rawStream.destroy()` on a finished stream is a no-op, and the late `reject`
   * is HANDLED, because `Promise.race` leaves its handlers attached to every
   * input. That was measured rather than assumed — a settled race whose loser
   * rejects afterwards produces zero `unhandledRejection` events. So this was
   * never the process-death class; it was pure accrual.
   *
   * The window is not small. INSTALL_TIMEOUTS in tool-installer.ts is builtin
   * 30s / apt 120s / binary 300s, and MAX_INSTALL_RETRIES means one install can
   * arm several. Each armed timer also keeps the event loop non-empty, so the
   * process cannot exit while any is pending.
   *
   * THIS BLOCK EXISTS TWICE IN THIS FILE — here and in `execWithStdin` — and the
   * defect was in both copies, byte for byte. See CONTRIBUTING, "Look for the
   * twin before you look for the next defect".
   */
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (timeoutMs && timeoutMs > 0) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          rawStream.destroy();
          reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      });
      await Promise.race([streamPromise, timeoutPromise]);
    } else {
      await streamPromise;
    }
  } finally {
    // `finally`, not after the race: the timeout path throws, and a command that
    // times out must not leave its own timer armed either.
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }

  const inspect = await exec.inspect();
  return {
    exitCode: inspect.ExitCode ?? 1,
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
  };
}

export async function execWithStdin(
  agentId: string,
  cmd: string[],
  stdinData: Buffer,
  timeoutMs?: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const containerName = `${CONTAINER_PREFIX}${agentId}`;
  assertAgentboxName(containerName);

  const container = docker.getContainer(containerName);
  const info = await container.inspect();
  assertManagedLabel(info.Config.Labels);

  const exec = await container.exec({
    Cmd: cmd,
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
  });

  const rawStream = await exec.start({ hijack: true, stdin: true });

  // Write stdin data and close the write side
  rawStream.write(stdinData);
  rawStream.end();

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let remainder: Buffer | null = null;

  const streamPromise = new Promise<void>((resolve, reject) => {
    rawStream.on('data', (chunk: Buffer) => {
      let buf: Buffer = remainder ? Buffer.concat([remainder, chunk]) : chunk;
      remainder = null;
      let offset = 0;
      while (offset < buf.length) {
        if (offset + 8 > buf.length) {
          remainder = buf.slice(offset);
          break;
        }
        const payloadSize = buf.readUInt32BE(offset + 4);
        const frameEnd = offset + 8 + payloadSize;
        if (frameEnd > buf.length) {
          remainder = buf.slice(offset);
          break;
        }
        const streamType = buf[offset];
        const payload = buf.slice(offset + 8, frameEnd);
        if (streamType === 1) stdoutChunks.push(payload);
        else if (streamType === 2) stderrChunks.push(payload);
        offset = frameEnd;
      }
    });
    rawStream.on('error', reject);
    rawStream.on('end', () => resolve());
    rawStream.on('close', () => resolve());
  });

  // The second copy of the block documented in `execInContainerWithExit` above.
  // It had the same defect, because it is the same code.
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (timeoutMs && timeoutMs > 0) {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          rawStream.destroy();
          reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
      });
      await Promise.race([streamPromise, timeoutPromise]);
    } else {
      await streamPromise;
    }
  } finally {
    // `finally`, not after the race: the timeout path throws, and a command that
    // times out must not leave its own timer armed either.
    if (timeoutTimer) clearTimeout(timeoutTimer);
  }

  const inspect = await exec.inspect();
  return {
    exitCode: inspect.ExitCode ?? 1,
    stdout: Buffer.concat(stdoutChunks).toString('utf8'),
    stderr: Buffer.concat(stderrChunks).toString('utf8'),
  };
}

export async function removeAgentVolumes(agentId: string): Promise<void> {
  for (const suffix of VOLUME_SUFFIXES) {
    const volumeName = `${CONTAINER_PREFIX}${agentId}-${suffix}`;
    assertAgentboxVolume(volumeName, agentId);
    try {
      const volume = docker.getVolume(volumeName);
      await volume.remove();
      console.log(`[docker] Removed volume ${volumeName}`);
    } catch (err: any) {
      if (err.statusCode !== 404) throw err;
    }
  }
}

/** The container did not exist — a 404, which is an ANSWER, not a failure. */
export const CONTAINER_ABSENT = 'absent';

export interface ReconcileResult {
  /** Agents whose recorded status was examined. */
  checked: number;
  /** Rows corrected in either direction. */
  reconciled: number;
  /** `stopped`/`error` rows whose container was actually running. */
  promoted: number;
  /** `running` rows whose container was not. */
  demoted: number;
  /**
   * `agent_id`s whose container could not be inspected at all. Their recorded
   * status was left untouched, so it is now unverified — see
   * `agent-status-verification.ts`. Absence is NOT in here: `inspectContainer`
   * returns `null` for a 404, which is an answer, and only rethrows for a fault.
   */
  unverified: string[];
}

/** A row as reconciliation needs to see it. */
export interface ReconcilableAgent {
  id: string;
  agent_id: string;
  status: string;
  container_id: string | null;
  container_state: string | null;
  /** Carried so a demotion can be escalated to the agent's owner. */
  created_by: string;
}

/**
 * A change reconciliation wants written. `containerId` and `errorMessage` are
 * omitted when this pass has no opinion on them, so a row is never blanked by a
 * write that was only about something else.
 */
export interface AgentStatusPatch {
  id: string;
  agentId: string;
  createdBy: string;
  previousStatus: string;
  status: string;
  /** What the daemon said: a docker status, `absent`, or null for "cannot tell". */
  containerState: string | null;
  containerId?: string | null;
  errorMessage?: string | null;
  /**
   * The exact instant Docker reported the container's most recent run
   * ending — a `Date` when it is knowable, `null` when it is not (the
   * container is absent, or reported the zero sentinel), `undefined` for "no
   * opinion" (a steady-state observation that did not touch this). Written
   * on both directions of a transition so a promotion clears what a prior
   * demotion left behind (#285).
   */
  containerFinishedAt?: Date | null;
}

/**
 * Reconcile recorded agent status against the containers that actually exist.
 *
 * BOTH DIRECTIONS, which it did not used to do (#239). It selected rows already
 * marked `running` and the only write it could make was to `stopped`, so an
 * agent recorded `stopped` whose container was running was invisible to it by
 * construction — no code path would ever look at that row. A start that created
 * the container and died before its status update landed there permanently.
 *
 * ABSENCE IS KEPT, not flattened. `inspectContainer` separates a 404 from a
 * fault correctly; this used to preserve that for exactly one expression
 * (`state ? ... : 'Container not found'`) and then collapse both into
 * `stopped`, leaving the difference in prose nothing queries. `containerState`
 * carries it out in a queryable form instead.
 */
export async function reconcileAgentStatuses(
  getAgents: () => Promise<ReconcilableAgent[]>,
  applyPatch: (patch: AgentStatusPatch) => Promise<void>
): Promise<ReconcileResult> {
  const agents = await getAgents();
  const result: ReconcileResult = {
    checked: agents.length, reconciled: 0, promoted: 0, demoted: 0, unverified: [],
  };

  for (const agent of agents) {
    // Per-agent, so one unreachable container does not abandon the rest of the
    // pass and leave them silently unchecked.
    let state: Awaited<ReturnType<typeof inspectContainer>>;
    try {
      state = await inspectContainer(agent.agent_id);
    } catch (err) {
      console.error(`[reconcile] Agent ${agent.agent_id} could not be inspected; status left UNVERIFIED:`, err);
      result.unverified.push(agent.agent_id);
      // Do not leave a stale observation standing as though it were current.
      // NULL means "could not tell", which is not the same as `absent`.
      if (agent.container_state !== null) {
        await applyPatch({
          id: agent.id, agentId: agent.agent_id, createdBy: agent.created_by,
          previousStatus: agent.status, status: agent.status,
          containerState: null,
        });
      }
      continue;
    }

    const containerState = state ? state.status : CONTAINER_ABSENT;
    const containerIsRunning = state?.status === 'running';

    if (containerIsRunning && agent.status !== 'running') {
      // The direction that did not exist. Nothing else in the codebase looks
      // for this row, so if this pass does not correct it, nothing will.
      console.log(`[reconcile] Agent ${agent.agent_id} recorded ${agent.status} but its container IS running — promoting`);
      await applyPatch({
        id: agent.id, agentId: agent.agent_id, createdBy: agent.created_by,
        previousStatus: agent.status, status: 'running',
        containerState, containerId: state!.containerId, errorMessage: null,
        // Running again: whatever the container's own last run finished at
        // is no longer this run's business, and it must not persist into the
        // new session's eventual close (#285).
        containerFinishedAt: null,
      });
      result.promoted++;
      result.reconciled++;
    } else if (!containerIsRunning && agent.status === 'running') {
      console.log(`[reconcile] Agent ${agent.agent_id} marked running but container is ${containerState}`);
      await applyPatch({
        id: agent.id, agentId: agent.agent_id, createdBy: agent.created_by,
        previousStatus: agent.status, status: 'stopped',
        containerState, containerId: null,
        errorMessage: state ? `Container ${state.status}` : 'Container not found',
        // Exact when the container is still present to ask (`state` is
        // non-null and its FinishedAt was real); null when it has vanished
        // or Docker reported the zero sentinel — either way, the session
        // sweep below falls back to its existing NOW()-and-estimated close.
        containerFinishedAt: state ? state.finishedAt : null,
      });
      result.demoted++;
      result.reconciled++;
    } else if (agent.container_state !== containerState) {
      // Status already agrees; record WHAT WAS SEEN so that `stopped` because
      // the container exited stays distinguishable from `stopped` because it is
      // gone. No status write, so no churn on a steady state.
      await applyPatch({
        id: agent.id, agentId: agent.agent_id, createdBy: agent.created_by,
        previousStatus: agent.status, status: agent.status,
        containerState,
      });
    }
  }

  return result;
}

/**
 * Fail closed on a malformed `cpus` value rather than silently dropping the
 * CPU limit. The bug this replaces: `Math.round(parseFloat(opts.cpus) * 1e9)`
 * turns any unparseable string into `NaN`, `JSON.stringify` turns `NaN` into
 * `null`, and `NanoCpus: null` means "no limit" to the Docker Engine API —
 * so a malformed value did not fail, it silently started the container with
 * unlimited CPU.
 *
 * Deliberately shaped to match `parseMemLimit` below: validate with a regex
 * FIRST and throw on mismatch, so `parseFloat` only ever runs against a
 * string the regex already proved is a bare non-negative decimal — it can't
 * itself produce `NaN` from that. `parseMemLimit` already followed this
 * shape; this field just hadn't, until now.
 */
export function parseCpus(cpus: string): number {
  const match = typeof cpus === 'string' ? cpus.match(/^(\d+(?:\.\d+)?)$/) : null;
  if (!match) throw new Error(`Invalid cpus: ${cpus}`);
  const value = parseFloat(match[1]);
  if (value <= 0) throw new Error(`Invalid cpus: ${cpus}`);
  return value;
}

function parseMemLimit(limit: string): number {
  const match = limit.match(/^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i);
  if (!match) throw new Error(`Invalid mem_limit: ${limit}`);
  const value = parseFloat(match[1]);
  const unit = (match[2] || '').toLowerCase();
  switch (unit) {
    case 'k': return value * 1024;
    case 'm': return value * 1024 * 1024;
    case 'g': return value * 1024 * 1024 * 1024;
    default: return value;
  }
}

/**
 * Whether a container is present AND running, checked live against the
 * Docker daemon — not a config flag, not an env var (app#508: a
 * DISCORD_BOT_SERVICE_TOKEN could be configured in vault with no bot
 * container ever having existed, which would have made a token-presence
 * check alone actively misleading).
 *
 * Deliberately NOT `assertAgentboxName`-gated like the agent-management
 * functions above: this is read-only (a plain inspect, nothing created,
 * started, stopped or labeled), and `containerName` here is never
 * caller-supplied — every call site passes a hardcoded constant — so the
 * injection concern that guard exists for does not apply.
 *
 * Three-outcome, not two: a container that plainly doesn't exist resolves
 * `false`; anything else that goes wrong talking to the daemon (proxy
 * unreachable, unexpected error shape) is NOT collapsed into the same
 * `false` — the docker-socket-proxy being briefly unreachable is not the
 * same fact as "this service was never deployed," and the caller needs to
 * tell "verified absent" from "could not check" apart, the same
 * distinction agent-status-verification.ts already draws for agent
 * containers.
 */
export async function isContainerRunning(containerName: string): Promise<boolean> {
  try {
    const info = await docker.getContainer(containerName).inspect();
    return info.State.Status === 'running';
  } catch (err: any) {
    if (err.statusCode === 404) return false;
    throw err;
  }
}
