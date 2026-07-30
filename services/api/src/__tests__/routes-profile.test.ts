import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { createApp } from '../app';
import { Readable } from 'stream';

// Generate a throwaway RSA keypair for test signing
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';

// Mock pg pool
const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery }),
}));

// Mock docker service (needed by agents router)
jest.mock('../services/docker', () => ({
  createAndStartContainer: jest.fn(),
  stopAndRemoveContainer: jest.fn(),
  inspectContainer: jest.fn(),
  getContainerLogs: jest.fn(),
  removeAgentVolumes: jest.fn(),
  reconcileAgentStatuses: jest.fn(),
}));

// Mock agent-files service
jest.mock('../services/agent-files', () => ({
  writeAgentFiles: jest.fn(),
  removeAgentFiles: jest.fn(),
}));

// Mock S3 client
jest.mock('../services/s3', () => ({
  getS3Client: jest.fn().mockReturnValue({}),
  AVATAR_BUCKET: 'user-avatars',
  ensureBucket: jest.fn(),
}));

// Mock avatar service
const mockProcessAvatar = jest.fn();
const mockAvatarKey = jest.fn();
const mockUploadAvatar = jest.fn();
const mockDeleteAvatar = jest.fn();
const mockGetAvatarStream = jest.fn();
jest.mock('../services/avatar', () => ({
  processAvatar: (...args: any[]) => mockProcessAvatar(...args),
  avatarKey: (...args: any[]) => mockAvatarKey(...args),
  uploadAvatar: (...args: any[]) => mockUploadAvatar(...args),
  deleteAvatar: (...args: any[]) => mockDeleteAvatar(...args),
  getAvatarStream: (...args: any[]) => mockGetAvatarStream(...args),
}));

// Mock keycloak-account service
const mockGetKeycloakProfile = jest.fn();
const mockUpdateKeycloakProfile = jest.fn();
jest.mock('../services/keycloak-account', () => ({
  getKeycloakProfile: (...args: any[]) => mockGetKeycloakProfile(...args),
  updateKeycloakProfile: (...args: any[]) => mockUpdateKeycloakProfile(...args),
}));

const app = createApp({
  issuer: TEST_ISSUER,
  getSigningKey: async () => publicKey,
});

function makeToken(sub: string, roles: string[]) {
  return jwt.sign(
    { sub, resource_access: { 'hill90-ui': { roles } } },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '5m' }
  );
}

const userToken = makeToken('test-user', ['user']);
const noRoleToken = makeToken('no-role-user', []);

beforeEach(() => {
  mockQuery.mockReset();
  mockProcessAvatar.mockReset();
  mockAvatarKey.mockReset();
  mockUploadAvatar.mockReset();
  mockDeleteAvatar.mockReset();
  mockGetAvatarStream.mockReset();
  mockGetKeycloakProfile.mockReset();
  mockUpdateKeycloakProfile.mockReset();
});

// ---------------------------------------------------------------------------
// Auth / RBAC
// ---------------------------------------------------------------------------

describe('Profile routes auth', () => {
  it('GET /profile returns 401 without auth', async () => {
    const res = await request(app).get('/profile');
    expect(res.status).toBe(401);
  });

  it('GET /profile returns 403 without user role', async () => {
    const res = await request(app)
      .get('/profile')
      .set('Authorization', `Bearer ${noRoleToken}`);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// GET /profile
// ---------------------------------------------------------------------------

describe('GET /profile', () => {
  it('returns merged Keycloak + DB profile', async () => {
    mockGetKeycloakProfile.mockResolvedValueOnce({
      username: 'jon',
      firstName: 'Jon',
      lastName: 'Hill',
      email: 'jon@hill90.com',
      emailVerified: true,
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ avatar_key: 'avatars/test-user/abc.webp' }] });

    const res = await request(app)
      .get('/profile')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.username).toBe('jon');
    expect(res.body.hasAvatar).toBe(true);
  });

  it('returns hasAvatar false when no profile row', async () => {
    mockGetKeycloakProfile.mockResolvedValueOnce({ username: 'jon' });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/profile')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body.hasAvatar).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PATCH /profile
// ---------------------------------------------------------------------------

describe('PATCH /profile', () => {
  it('updates firstName via Keycloak Account API', async () => {
    mockUpdateKeycloakProfile.mockResolvedValueOnce({ firstName: 'Jonathan', lastName: 'Hill' });

    const res = await request(app)
      .patch('/profile')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ firstName: 'Jonathan' });

    expect(res.status).toBe(200);
    expect(res.body.firstName).toBe('Jonathan');
  });

  it('rejects when no firstName or lastName provided', async () => {
    const res = await request(app)
      .patch('/profile')
      .set('Authorization', `Bearer ${userToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects firstName over 100 chars', async () => {
    const res = await request(app)
      .patch('/profile')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ firstName: 'x'.repeat(101) });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// POST /profile/avatar
// ---------------------------------------------------------------------------

describe('POST /profile/avatar', () => {
  it('uploads avatar successfully', async () => {
    mockProcessAvatar.mockResolvedValueOnce(Buffer.from('webp-data'));
    mockAvatarKey.mockReturnValueOnce('avatars/test-user/uuid.webp');
    mockUploadAvatar.mockResolvedValueOnce(undefined);
    mockQuery
      .mockResolvedValueOnce({ rows: [] })  // no existing avatar
      .mockResolvedValueOnce({ rows: [] }); // upsert

    const res = await request(app)
      .post('/profile/avatar')
      .set('Authorization', `Bearer ${userToken}`)
      .attach('avatar', Buffer.from('fake-image'), { filename: 'avatar.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Avatar uploaded');
    expect(mockProcessAvatar).toHaveBeenCalled();
    expect(mockUploadAvatar).toHaveBeenCalled();
  });

  it('deletes old avatar when replacing', async () => {
    mockProcessAvatar.mockResolvedValueOnce(Buffer.from('webp-data'));
    mockAvatarKey.mockReturnValueOnce('avatars/test-user/new.webp');
    mockUploadAvatar.mockResolvedValueOnce(undefined);
    mockDeleteAvatar.mockResolvedValueOnce(undefined);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ avatar_key: 'avatars/test-user/old.webp' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/profile/avatar')
      .set('Authorization', `Bearer ${userToken}`)
      .attach('avatar', Buffer.from('fake-image'), { filename: 'avatar.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(mockDeleteAvatar).toHaveBeenCalledWith(expect.anything(), 'avatars/test-user/old.webp');
  });

  it('rejects invalid MIME type', async () => {
    const res = await request(app)
      .post('/profile/avatar')
      .set('Authorization', `Bearer ${userToken}`)
      .attach('avatar', Buffer.from('fake-data'), { filename: 'file.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid file type/);
  });
});

// ---------------------------------------------------------------------------
// DELETE /profile/avatar
// ---------------------------------------------------------------------------

describe('DELETE /profile/avatar', () => {
  it('deletes existing avatar', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ avatar_key: 'avatars/test-user/abc.webp' }] })
      .mockResolvedValueOnce({ rows: [] });
    mockDeleteAvatar.mockResolvedValueOnce(undefined);

    const res = await request(app)
      .delete('/profile/avatar')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(mockDeleteAvatar).toHaveBeenCalledWith(expect.anything(), 'avatars/test-user/abc.webp');
  });

  // DELETE keeps its 404, and this test exists to hold that line. DELETE and GET
  // have byte-identical "no avatar" guard blocks, so a search-and-replace that
  // relaxes GET's status will silently relax this one too. Deleting something
  // that is not there is a client error; asking for it is not.
  it('returns 404 when no avatar exists — deliberately NOT 204', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .delete('/profile/avatar')
      .set('Authorization', `Bearer ${userToken}`);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /profile/avatar
// ---------------------------------------------------------------------------

describe('GET /profile/avatar', () => {
  it('streams avatar from S3', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ avatar_key: 'avatars/test-user/abc.webp' }] });
    const readable = new Readable();
    readable.push(Buffer.from('webp-image-data'));
    readable.push(null);
    mockGetAvatarStream.mockResolvedValueOnce({ stream: readable, etag: '"abc123"' });

    const res = await request(app)
      .get('/profile/avatar')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/webp/);
    expect(res.headers['etag']).toBe('"abc123"');
  });

  it('returns 304 on matching ETag', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ avatar_key: 'avatars/test-user/abc.webp' }] });
    const readable = new Readable();
    readable.push(null);
    mockGetAvatarStream.mockResolvedValueOnce({ stream: readable, etag: '"abc123"' });

    const res = await request(app)
      .get('/profile/avatar')
      .set('Authorization', `Bearer ${userToken}`)
      .set('If-None-Match', '"abc123"');

    expect(res.status).toBe(304);
  });

  // TopBar asks for this on every authenticated page load, so the response for a
  // user who has never uploaded an avatar is the single most-requested response
  // in the app. It must not be an error.
  it('returns 204, not 404, when the user has no avatar', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/profile/avatar')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(204);
    expect(res.body).toEqual({});
  });

  it('returns 204 when the row exists but avatar_key is null', async () => {
    // Production shape: a user_profiles row created by a preferences write, with
    // no avatar ever uploaded.
    mockQuery.mockResolvedValueOnce({ rows: [{ avatar_key: null }] });

    const res = await request(app)
      .get('/profile/avatar')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(204);
  });

  // The other direction: the database claims an avatar exists and object storage
  // disagrees. That is a dangling avatar_key, a genuine inconsistency, and it
  // stays a 404 on purpose so it does not hide inside the empty-state response.
  it('still returns 404 when avatar_key is set but the object is missing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ avatar_key: 'avatars/test-user/gone.webp' }] });
    const err: any = new Error('NoSuchKey');
    err.name = 'NoSuchKey';
    mockGetAvatarStream.mockRejectedValueOnce(err);

    const res = await request(app)
      .get('/profile/avatar')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'No avatar found' });
  });
});

// ---------------------------------------------------------------------------
// POST /profile/password
// ---------------------------------------------------------------------------

describe('POST /profile/password', () => {
  it('returns structured 501 (Keycloak removed password REST endpoint)', async () => {
    const res = await request(app)
      .post('/profile/password')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ currentPassword: 'oldpass123', newPassword: 'newpass123' });

    expect(res.status).toBe(501);
    expect(res.body.error).toBe('Password change not yet available');
    expect(res.body.code).toBe('NOT_IMPLEMENTED');
  });
});
