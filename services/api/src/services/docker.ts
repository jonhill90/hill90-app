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

export async function createAndStartContainer(opts: CreateAgentContainerOpts): Promise<string> {
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
  const nanoCpus = Math.round(parseFloat(opts.cpus) * 1e9);
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

  const container = await docker.createContainer({
    Image: opts.image || 'hill90/agentbox:latest',
    name: containerName,
    Env: envVars,
    Labels: {
      [MANAGED_LABEL]: MANAGED_VALUE,
      'traefik.enable': 'false',
    },
    HostConfig: hostConfig,
  });

  await container.start();

  // Agents with host_docker or vps_system scope need external internet access.
  // The primary network (agent_internal) is internal-only, so we attach the
  // edge network as a secondary to provide DNS + outbound HTTP.
  if (opts.network === AGENT_NETWORK) {
    try {
      const edgeNetwork = docker.getNetwork('hill90_edge');
      await edgeNetwork.connect({ Container: containerName });
    } catch (err) {
      console.error(`[docker] Failed to attach edge network to ${containerName}:`, err);
    }
  }

  const info = await container.inspect();
  return info.Id;
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

export async function inspectContainer(agentId: string): Promise<{
  status: string;
  containerId: string;
  health?: string;
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

export interface ReconcileResult {
  /** Agents whose recorded status was examined. */
  checked: number;
  /** Agents demoted to `stopped` because their container was not running. */
  reconciled: number;
  /**
   * `agent_id`s whose container could not be inspected at all. Their recorded
   * status was left untouched, so it is now unverified — see
   * `agent-status-verification.ts`. Absence is NOT in here: `inspectContainer`
   * returns `null` for a 404, which is an answer, and only rethrows for a fault.
   */
  unverified: string[];
}

export async function reconcileAgentStatuses(
  getRunningAgents: () => Promise<Array<{ id: string; agent_id: string }>>,
  updateStatus: (id: string, status: string, containerId: string | null, error: string | null) => Promise<void>
): Promise<ReconcileResult> {
  const agents = await getRunningAgents();
  const result: ReconcileResult = { checked: agents.length, reconciled: 0, unverified: [] };

  for (const agent of agents) {
    // Per-agent, so one unreachable container does not abandon the rest of the
    // pass and leave them silently unchecked.
    let state: Awaited<ReturnType<typeof inspectContainer>>;
    try {
      state = await inspectContainer(agent.agent_id);
    } catch (err) {
      console.error(`[reconcile] Agent ${agent.agent_id} could not be inspected; status left UNVERIFIED:`, err);
      result.unverified.push(agent.agent_id);
      continue;
    }

    if (!state || state.status !== 'running') {
      console.log(`[reconcile] Agent ${agent.agent_id} marked running but container is ${state?.status || 'missing'}`);
      await updateStatus(agent.id, 'stopped', null, state ? `Container ${state.status}` : 'Container not found');
      result.reconciled++;
    }
  }

  return result;
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
