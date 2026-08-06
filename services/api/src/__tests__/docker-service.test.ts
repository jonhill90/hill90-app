// Module scope, not global script scope: without a top-level import or export,
// TypeScript shares one scope across such files and identically named top-level
// consts collide with TS2451. That fired for real between two of these files.
export {};
describe('Docker service module', () => {
  it('exports all expected functions', () => {
    const dockerModule = require('../services/docker');
    expect(dockerModule.createAndStartContainer).toBeDefined();
    expect(dockerModule.stopAndRemoveContainer).toBeDefined();
    expect(dockerModule.inspectContainer).toBeDefined();
    expect(dockerModule.getContainerLogs).toBeDefined();
    expect(dockerModule.removeAgentVolumes).toBeDefined();
    expect(dockerModule.reconcileAgentStatuses).toBeDefined();
    expect(dockerModule.execInContainer).toBeDefined();
    expect(dockerModule.execInContainerWithExit).toBeDefined();
    expect(dockerModule.execWithStdin).toBeDefined();
  });
});

describe('CreateAgentContainerOpts interface', () => {
  // DS-1: image param accepted by interface
  it('accepts optional image parameter in opts type', () => {
    // TypeScript compilation verifies the interface accepts `image`.
    // This test validates the type is importable and structurally correct.
    const opts: import('../services/docker').CreateAgentContainerOpts = {
      agentId: 'test',
      hostConfigPath: '/data',
      cpus: '1.0',
      memLimit: '1g',
      pidsLimit: 200,
      image: 'custom:v1',
    };
    expect(opts.image).toBe('custom:v1');
  });

  // DS-2: image param is optional (undefined falls back to default)
  it('image param is optional (undefined by default)', () => {
    const opts: import('../services/docker').CreateAgentContainerOpts = {
      agentId: 'test',
      hostConfigPath: '/data',
      cpus: '1.0',
      memLimit: '1g',
      pidsLimit: 200,
    };
    expect(opts.image).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// T5/T6: createAndStartContainer applies profile metadata
// ---------------------------------------------------------------------------

describe('createAndStartContainer metadata application', () => {
  const mockStart = jest.fn().mockResolvedValue(undefined);
  const mockInspect = jest.fn().mockResolvedValue({ Id: 'container-id-abc' });
  const mockCreateContainer = jest.fn().mockResolvedValue({ start: mockStart, inspect: mockInspect });
  const mockGetContainer = jest.fn().mockImplementation(() => {
    const err: any = new Error('not found');
    err.statusCode = 404;
    throw err;
  });

  beforeEach(() => {
    jest.resetModules();
    mockCreateContainer.mockClear();
    mockStart.mockClear();
    mockInspect.mockClear();
    process.env.AGENTBOX_CONFIG_HOST_PATH = '/opt/hill90/agentbox-configs';

    jest.doMock('dockerode', () => {
      return jest.fn().mockImplementation(() => ({
        createContainer: mockCreateContainer,
        getContainer: mockGetContainer,
      }));
    });
  });

  afterEach(() => {
    delete process.env.AGENTBOX_CONFIG_HOST_PATH;
    jest.restoreAllMocks();
  });

  // T5: extra_env from metadata is appended to container Env
  it('T5: applies extra_env from metadata to container Env array', async () => {
    const { createAndStartContainer } = require('../services/docker');

    await createAndStartContainer({
      agentId: 'test-agent',
      hostConfigPath: '/opt/hill90/agentbox-configs',
      cpus: '2.0',
      memLimit: '2g',
      pidsLimit: 300,
      env: ['WORK_TOKEN=abc'],
      metadata: {
        extra_env: ['PLAYWRIGHT_BROWSERS_PATH=/data/browsers', 'CUSTOM_VAR=hello'],
      },
    });

    expect(mockCreateContainer).toHaveBeenCalledTimes(1);
    const createOpts = mockCreateContainer.mock.calls[0][0];

    // Verify extra_env entries are in the Env array
    expect(createOpts.Env).toContain('PLAYWRIGHT_BROWSERS_PATH=/data/browsers');
    expect(createOpts.Env).toContain('CUSTOM_VAR=hello');
    // Standard env should also be present
    expect(createOpts.Env).toContain('AGENT_ID=test-agent');
    expect(createOpts.Env).toContain('WORK_TOKEN=abc');
  });

  // T6: shm_size from metadata is set on HostConfig.ShmSize
  it('T6: applies shm_size from metadata to HostConfig.ShmSize', async () => {
    const { createAndStartContainer } = require('../services/docker');

    await createAndStartContainer({
      agentId: 'test-agent',
      hostConfigPath: '/opt/hill90/agentbox-configs',
      cpus: '2.0',
      memLimit: '2g',
      pidsLimit: 300,
      metadata: {
        shm_size: '256m',
      },
    });

    expect(mockCreateContainer).toHaveBeenCalledTimes(1);
    const createOpts = mockCreateContainer.mock.calls[0][0];

    // ShmSize should be 256 * 1024 * 1024 = 268435456 bytes
    expect(createOpts.HostConfig.ShmSize).toBe(256 * 1024 * 1024);
  });

  // T5b: no metadata means no extra env or shm
  it('no metadata produces no ShmSize and standard Env only', async () => {
    const { createAndStartContainer } = require('../services/docker');

    await createAndStartContainer({
      agentId: 'test-agent',
      hostConfigPath: '/opt/hill90/agentbox-configs',
      cpus: '1.0',
      memLimit: '1g',
      pidsLimit: 200,
    });

    expect(mockCreateContainer).toHaveBeenCalledTimes(1);
    const createOpts = mockCreateContainer.mock.calls[0][0];

    expect(createOpts.HostConfig.ShmSize).toBeUndefined();
    expect(createOpts.Env).not.toContain('PLAYWRIGHT_BROWSERS_PATH=/data/browsers');
  });
});

// ---------------------------------------------------------------------------
// Wrong-record sweep, services/helpers tier: a failed edge-network attach
// was caught, logged, and swallowed — createAndStartContainer returned a
// bare container ID either way, so the caller (routes/agents.ts's
// POST /:id/start) marked the agent 'running' with no signal that a
// host_docker/vps_system-scope agent is missing the network it needs
// outbound internet access through. Unlike this file's own AKM/model-router
// token failures (routes/agents.ts's `startWarnings`), nothing observed or
// surfaced this one — and no reconciliation pass re-checks edge-network
// membership either (agent-status-verification.ts's "unknown" tri-state
// covers only whether a container's running/stopped status was verified).
//
// WHAT THIS TEST PROVES. That createAndStartContainer's return value lets
// the caller tell "edge network attached" from "it didn't, silently" — not
// that the caller (routes/agents.ts) surfaces it as a warning; that's a
// separate route-level test.
describe('createAndStartContainer edge-network attach failure is signalled, not swallowed', () => {
  const mockStart = jest.fn().mockResolvedValue(undefined);
  const mockInspect = jest.fn().mockResolvedValue({ Id: 'container-id-abc' });
  const mockCreateContainer = jest.fn().mockResolvedValue({ start: mockStart, inspect: mockInspect });
  const mockGetContainer = jest.fn().mockImplementation(() => {
    const err: any = new Error('not found');
    err.statusCode = 404;
    throw err;
  });
  const mockConnect = jest.fn();
  const mockGetNetwork = jest.fn().mockReturnValue({ connect: mockConnect });

  beforeEach(() => {
    jest.resetModules();
    mockCreateContainer.mockClear();
    mockStart.mockClear();
    mockInspect.mockClear();
    mockConnect.mockReset();
    mockGetNetwork.mockClear();
    process.env.AGENTBOX_CONFIG_HOST_PATH = '/opt/hill90/agentbox-configs';

    jest.doMock('dockerode', () => {
      return jest.fn().mockImplementation(() => ({
        createContainer: mockCreateContainer,
        getContainer: mockGetContainer,
        getNetwork: mockGetNetwork,
      }));
    });
  });

  afterEach(() => {
    delete process.env.AGENTBOX_CONFIG_HOST_PATH;
    jest.restoreAllMocks();
  });

  it('THE ASSERTION THAT MATTERS: a rejected edge-network connect is visible in the return value', async () => {
    const { createAndStartContainer, AGENT_NETWORK } = require('../services/docker');
    mockConnect.mockRejectedValueOnce(new Error('docker daemon hiccup'));

    const result = await createAndStartContainer({
      agentId: 'test-agent',
      hostConfigPath: '/opt/hill90/agentbox-configs',
      cpus: '1.0',
      memLimit: '1g',
      pidsLimit: 200,
      network: AGENT_NETWORK,
    });

    // The container still started — this fix does not undo that, same
    // reasoning as every other degraded-but-started path in this codebase.
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(result.containerId).toBe('container-id-abc');
    // THE ASSERTION THAT MATTERS: the caller can tell.
    expect(result.edgeNetworkAttachFailed).toBe(true);
  });

  it('TWIN: a successful edge-network connect reports no failure', async () => {
    const { createAndStartContainer, AGENT_NETWORK } = require('../services/docker');
    mockConnect.mockResolvedValueOnce(undefined);

    const result = await createAndStartContainer({
      agentId: 'test-agent',
      hostConfigPath: '/opt/hill90/agentbox-configs',
      cpus: '1.0',
      memLimit: '1g',
      pidsLimit: 200,
      network: AGENT_NETWORK,
    });

    expect(result.containerId).toBe('container-id-abc');
    expect(result.edgeNetworkAttachFailed).toBe(false);
  });

  it('a sandbox-scope agent (no edge network needed) never calls getNetwork at all', async () => {
    const { createAndStartContainer, AGENT_SANDBOX_NETWORK } = require('../services/docker');

    const result = await createAndStartContainer({
      agentId: 'test-agent',
      hostConfigPath: '/opt/hill90/agentbox-configs',
      cpus: '1.0',
      memLimit: '1g',
      pidsLimit: 200,
      network: AGENT_SANDBOX_NETWORK,
    });

    expect(mockGetNetwork).not.toHaveBeenCalled();
    expect(result.edgeNetworkAttachFailed).toBe(false);
  });
});

describe('isContainerRunning (app#508)', () => {
  const mockInspect = jest.fn();
  const mockGetContainer = jest.fn().mockReturnValue({ inspect: mockInspect });

  beforeEach(() => {
    jest.resetModules();
    mockInspect.mockReset();
    mockGetContainer.mockClear();

    jest.doMock('dockerode', () => {
      return jest.fn().mockImplementation(() => ({
        getContainer: mockGetContainer,
      }));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('POSITIVE CONTROL: a container in State.Status "running" resolves true', async () => {
    const { isContainerRunning } = require('../services/docker');
    mockInspect.mockResolvedValueOnce({ State: { Status: 'running' } });

    await expect(isContainerRunning('app-discord-bot')).resolves.toBe(true);
    expect(mockGetContainer).toHaveBeenCalledWith('app-discord-bot');
  });

  it('a container that exists but is stopped resolves false, not true', async () => {
    const { isContainerRunning } = require('../services/docker');
    mockInspect.mockResolvedValueOnce({ State: { Status: 'exited' } });

    await expect(isContainerRunning('app-discord-bot')).resolves.toBe(false);
  });

  it('THE ASSERTION THAT MATTERS: a container that does not exist at all (404) resolves false, not throw', async () => {
    const { isContainerRunning } = require('../services/docker');
    const err: any = new Error('no such container');
    err.statusCode = 404;
    mockInspect.mockRejectedValueOnce(err);

    await expect(isContainerRunning('app-discord-bot')).resolves.toBe(false);
  });

  it('an unrelated daemon/proxy error is NOT collapsed into false — it propagates, so the caller can tell "absent" from "could not check"', async () => {
    const { isContainerRunning } = require('../services/docker');
    mockInspect.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(isContainerRunning('app-discord-bot')).rejects.toThrow('ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// parseCpus: a malformed cpus value must fail closed, not silently produce
// an unlimited container.
//
// THE BUG THIS REPLACES: `Math.round(parseFloat(opts.cpus) * 1e9)` turns any
// unparseable string into NaN; `JSON.stringify({NanoCpus: NaN})` turns NaN
// into `null` on the wire; `NanoCpus: null` means "no limit" to the Docker
// Engine API. So a malformed cpus value did not fail — it silently started
// the container with unlimited CPU, and `createContainer` still returned
// success. The assertion that matters is never "did creation succeed" —
// that passes against both the fixed and the broken code — it's what
// reaches (or, on the malformed path, does NOT reach) the constructed
// Docker config.
// ---------------------------------------------------------------------------
describe('parseCpus (unit)', () => {
  const { parseCpus } = require('../services/docker');

  it('parses a plain integer', () => {
    expect(parseCpus('2')).toBe(2);
  });

  it('parses a decimal', () => {
    expect(parseCpus('1.5')).toBe(1.5);
  });

  it.each(['garbage', '', 'NaN', 'unlimited', '1.0.0', '1,0', ' 1.0', '1.0 ', '1e9'])(
    'rejects %j rather than returning NaN',
    (bad) => {
      expect(() => parseCpus(bad)).toThrow(/Invalid cpus/);
    }
  );

  it('rejects zero — a zero CPU limit is not a meaningful request', () => {
    expect(() => parseCpus('0')).toThrow(/Invalid cpus/);
  });

  it('rejects a negative value', () => {
    expect(() => parseCpus('-1')).toThrow(/Invalid cpus/);
  });
});

describe('createAndStartContainer: malformed cpus fails closed', () => {
  const mockStart = jest.fn().mockResolvedValue(undefined);
  const mockInspect = jest.fn().mockResolvedValue({ Id: 'container-id-abc' });
  const mockCreateContainer = jest.fn().mockResolvedValue({ start: mockStart, inspect: mockInspect });
  const mockGetContainer = jest.fn().mockImplementation(() => {
    const err: any = new Error('not found');
    err.statusCode = 404;
    throw err;
  });

  beforeEach(() => {
    jest.resetModules();
    mockCreateContainer.mockClear();
    mockStart.mockClear();
    mockInspect.mockClear();
    process.env.AGENTBOX_CONFIG_HOST_PATH = '/opt/hill90/agentbox-configs';

    jest.doMock('dockerode', () => {
      return jest.fn().mockImplementation(() => ({
        createContainer: mockCreateContainer,
        getContainer: mockGetContainer,
      }));
    });
  });

  afterEach(() => {
    delete process.env.AGENTBOX_CONFIG_HOST_PATH;
    jest.restoreAllMocks();
  });

  it('THE ASSERTION THAT MATTERS: a malformed cpus value never reaches the Docker API at all — refused, not created with an unlimited CPU', async () => {
    const { createAndStartContainer } = require('../services/docker');

    await expect(createAndStartContainer({
      agentId: 'test-agent',
      hostConfigPath: '/opt/hill90/agentbox-configs',
      cpus: 'garbage',
      memLimit: '1g',
      pidsLimit: 200,
    })).rejects.toThrow(/Invalid cpus/);

    // Not "creation failed somehow" — specifically that createContainer was
    // never called, so there is no HostConfig for NanoCpus to be silently
    // null inside. A test asserting only the rejection above would pass
    // even if this fix regressed to logging-and-continuing; this is the
    // line that would catch that.
    expect(mockCreateContainer).not.toHaveBeenCalled();
    expect(mockStart).not.toHaveBeenCalled();
  });

  it('TWIN: a valid cpus value produces a real, non-null NanoCpus and the container starts', async () => {
    const { createAndStartContainer } = require('../services/docker');

    await createAndStartContainer({
      agentId: 'test-agent',
      hostConfigPath: '/opt/hill90/agentbox-configs',
      cpus: '2.0',
      memLimit: '1g',
      pidsLimit: 200,
    });

    expect(mockCreateContainer).toHaveBeenCalledTimes(1);
    const createOpts = mockCreateContainer.mock.calls[0][0];
    // Round-tripped through JSON, the same boundary the real bug crossed —
    // NaN silently becomes null there; a real number does not.
    const wireHostConfig = JSON.parse(JSON.stringify(createOpts.HostConfig));
    expect(wireHostConfig.NanoCpus).toBe(2_000_000_000);
    expect(wireHostConfig.NanoCpus).not.toBeNull();
    expect(mockStart).toHaveBeenCalledTimes(1);
  });
});

describe('resolveAgentNetwork', () => {
  const { resolveAgentNetwork, AGENT_NETWORK, AGENT_SANDBOX_NETWORK } = require('../services/docker');

  // T5
  it('AGENT_SANDBOX_NETWORK constant is hill90_agent_sandbox', () => {
    expect(AGENT_SANDBOX_NETWORK).toBe('hill90_agent_sandbox');
  });

  // T6
  it('AGENT_NETWORK constant is hill90_agent_internal', () => {
    expect(AGENT_NETWORK).toBe('hill90_agent_internal');
  });

  // T1
  it('returns sandbox for null scope', () => {
    expect(resolveAgentNetwork(null)).toBe('hill90_agent_sandbox');
  });

  // T2
  it('returns sandbox for container_local', () => {
    expect(resolveAgentNetwork('container_local')).toBe('hill90_agent_sandbox');
  });

  // T3
  it('returns agent_internal for host_docker', () => {
    expect(resolveAgentNetwork('host_docker')).toBe('hill90_agent_internal');
  });

  // T4
  it('returns agent_internal for vps_system', () => {
    expect(resolveAgentNetwork('vps_system')).toBe('hill90_agent_internal');
  });
});
