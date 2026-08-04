/**
 * An agent container must be able to say which code it is running (#228).
 *
 * WHAT #228 STILL IS, after the parts that shipped. The build exists (#230,
 * on the VPS, knowledge first) and drift is signalled four-hourly against the
 * images' `com.hill90.revision` (#236 → #242). I rewrote the issue this morning
 * to say so, and nothing has landed against `docker.ts` or `deploy-drift.yml`
 * since. What remains is the layer below: `createAndStartContainer` labelled a
 * container with `managed-by` and `traefik.enable` and nothing else, so
 * `docker inspect hill90/agentbox` could answer "which commit is this image
 * from" while `docker ps` over the running agents answered nothing.
 *
 * WHY THAT MAKES THE SIGNAL UNTRUSTWORTHY RATHER THAN INCOMPLETE. An agent
 * started from image X keeps running X after the image is rebuilt to Y. The
 * alarm compares the IMAGE to `origin/main`, finds Y, and reports agreement —
 * while agents run X. It is not silent about a thing it cannot see; it is
 * green about a thing it cannot see, which is the difference between a gap and
 * a wrong answer.
 *
 * ABSENT IS NOT WRONG. If the image carries no stamp — a hand-built one — the
 * label is omitted rather than guessed. The drift check already has a state for
 * a container with no usable stamp (exit 3, RUNNING CODE UNKNOWN) and inventing
 * a value here would turn that into a false comparison.
 */
const mockCreate = jest.fn();
const mockStart = jest.fn();
const mockContainerInspect = jest.fn();
const mockImageInspect = jest.fn();

jest.mock('dockerode', () =>
  jest.fn().mockImplementation(() => ({
    createContainer: (...a: unknown[]) => mockCreate(...a),
    getContainer: () => ({
      inspect: mockContainerInspect,
      start: mockStart,
      stop: jest.fn(),
      remove: jest.fn(),
    }),
    getImage: () => ({ inspect: mockImageInspect }),
    getNetwork: () => ({ connect: jest.fn() }),
  })),
);

import { createAndStartContainer } from '../services/docker';

const OPTS = {
  agentId: 'scout',
  hostConfigPath: '/data/agentbox',
  cpus: '1.0',
  memLimit: '1g',
  pidsLimit: 200,
};

function labelsPassedToCreate(): Record<string, string> {
  return mockCreate.mock.calls[0][0].Labels;
}

beforeEach(() => {
  mockCreate.mockReset().mockResolvedValue({
    start: mockStart,
    inspect: async () => ({ Id: 'container-abc' }),
  });
  mockStart.mockReset();
  mockContainerInspect.mockReset().mockRejectedValue(Object.assign(new Error('no such container'), { statusCode: 404 }));
  mockImageInspect.mockReset().mockResolvedValue({ Config: { Labels: { 'com.hill90.revision': 'abc1234' } } });
  process.env.AGENTBOX_CONFIG_HOST_PATH = '/data/agentbox';
});

afterEach(() => { delete process.env.AGENTBOX_CONFIG_HOST_PATH });

describe('the container carries the revision of the image it came from', () => {
  it('POSITIVE CONTROL: the image stamp is copied onto the container', async () => {
    await createAndStartContainer(OPTS);

    expect(labelsPassedToCreate()['com.hill90.revision']).toBe('abc1234');
    // The existing labels are untouched — this adds, it does not replace.
    expect(labelsPassedToCreate()['managed-by']).toBe('hill90-api');
  });

  it('TWIN: an image with no stamp leaves the label off rather than guessing', async () => {
    // A hand-built image. `check_deploy_drift.sh` already treats a container
    // with no usable stamp as RUNNING CODE UNKNOWN (exit 3); inventing a value
    // here would turn that honest state into a false comparison.
    mockImageInspect.mockResolvedValue({ Config: { Labels: {} } });

    await createAndStartContainer(OPTS);

    expect(labelsPassedToCreate()['com.hill90.revision']).toBeUndefined();
    expect(labelsPassedToCreate()['managed-by']).toBe('hill90-api');
  });

  it('an image that cannot be inspected does not fail the start', async () => {
    // Starting an agent is the user's action; a missing stamp is bookkeeping.
    // The agent still starts, and the label is simply absent.
    mockImageInspect.mockRejectedValue(new Error('image inspect failed'));

    const id = await createAndStartContainer(OPTS);

    expect(id).toBe('container-abc');
    expect(labelsPassedToCreate()['com.hill90.revision']).toBeUndefined();
  });
});
