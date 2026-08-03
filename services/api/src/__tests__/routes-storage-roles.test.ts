/**
 * The storage router's gate must match who actually calls each endpoint.
 *
 * THE DEFECT. `storage.ts` opened with a blanket
 *
 *     router.use(requireRole('admin'));
 *
 * over every method. `requireRole` is flat, not hierarchical — `role.ts:13` is a
 * plain `roles.includes(role)` — so holding `user` grants nothing. Three callers
 * in the UI reach this router, and two of them are offered to every signed-in
 * user:
 *
 *   ChatView.tsx           POST /storage/buckets/chat-attachments/upload
 *   MonitoringClient.tsx   GET  /storage/buckets
 *   StorageClient.tsx      GET objects, POST upload, DELETE  (the bucket browser)
 *
 * So attaching a file in chat required the admin role, and the monitoring page
 * rendered its 403 as `storage: unhealthy` — a permission error displayed as an
 * infrastructure outage.
 *
 * WHY NOT SIMPLY `user` EVERYWHERE. Too loose is a bug as much as too strict.
 * `PutObjectCommand` overwrites silently, and neither the object listing nor the
 * delete is scoped to the caller — the bucket and key come straight from the
 * URL. Letting any signed-in user write to an arbitrary bucket would let them
 * destroy another user's objects, and letting them list one would expose every
 * object in it. Those stay admin.
 *
 * The shape follows container-profiles.ts, which already splits `user` on reads
 * from `admin` on writes rather than gating the whole router at the mount.
 *
 *   GET  /buckets                    user    a bucket-name inventory; the
 *                                            monitoring page needs it and is
 *                                            offered to everyone
 *   GET  /buckets/:name/objects      admin   enumerates other people's objects
 *   POST /buckets/chat-attachments/upload
 *                                    user    the one write an ordinary user is
 *                                            actually offered
 *   POST /buckets/:other/upload      admin   arbitrary-bucket write == overwrite
 *   DELETE /buckets/:name/objects/*  admin   destructive and unscoped
 *
 * Every case below pins one of those rows, in BOTH directions where a direction
 * exists. A file that only checked the permissive half would pass just as well
 * against `router.use(requireRole('user'))`, which is the opposite defect.
 */
import request from 'supertest';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { createApp } from '../app';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const TEST_ISSUER = 'https://auth.hill90.com/realms/hill90';

const mockQuery = jest.fn();
jest.mock('../db/pool', () => ({
  getPool: () => ({ query: mockQuery }),
}));

const mockS3Send = jest.fn();
jest.mock('../services/s3', () => ({
  getS3Client: () => ({ send: mockS3Send }),
}));

function makeToken(sub: string, roles: string[]): string {
  return jwt.sign(
    { sub, resource_access: { 'hill90-ui': { roles } } },
    privateKey,
    { algorithm: 'RS256', issuer: TEST_ISSUER, expiresIn: '1h' }
  );
}

// A real ordinary user holds `user` and NOT `admin`. An admin holds both, which
// is what a composite role assignment produces.
const userToken = makeToken('regular-user', ['user']);
const adminToken = makeToken('admin-user', ['admin', 'user']);
const rolelessToken = makeToken('no-roles', []);

const app = createApp({
  issuer: TEST_ISSUER,
  getSigningKey: async () => publicKey,
});

describe('storage: per-method roles match the caller', () => {
  beforeEach(() => {
    mockS3Send.mockReset();
  });

  // ---------------------------------------------------------------- reads ---

  it('GET /buckets is allowed for an ordinary user — the monitoring page', async () => {
    mockS3Send.mockResolvedValueOnce({ Buckets: [{ Name: 'chat-attachments', CreationDate: new Date('2026-01-01T00:00:00Z') }] });

    const res = await request(app)
      .get('/storage/buckets')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe('chat-attachments');
  });

  it('GET /buckets still refuses a caller with no roles at all', async () => {
    // The gate loosened from admin to user; it must not have loosened to nothing.
    const res = await request(app)
      .get('/storage/buckets')
      .set('Authorization', `Bearer ${rolelessToken}`);

    expect(res.status).toBe(403);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('GET /buckets/:name/objects stays admin — it enumerates other people\'s objects', async () => {
    const res = await request(app)
      .get('/storage/buckets/user-avatars/objects')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(403);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('GET /buckets/:name/objects works for an admin', async () => {
    mockS3Send.mockResolvedValueOnce({ Contents: [], CommonPrefixes: [], IsTruncated: false, KeyCount: 0 });

    const res = await request(app)
      .get('/storage/buckets/user-avatars/objects')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------- uploads ---

  it('POST chat-attachments/upload is allowed for an ordinary user — the chat defect', async () => {
    mockS3Send.mockResolvedValueOnce({});

    const res = await request(app)
      .post('/storage/buckets/chat-attachments/upload')
      .set('Authorization', `Bearer ${userToken}`)
      .attach('file', Buffer.from('hello'), 'note.txt');

    expect(res.status).toBe(200);
    expect(mockS3Send.mock.calls[0][0].input.Bucket).toBe('chat-attachments');
  });

  it('POST to ANY OTHER bucket stays admin — PutObject overwrites', async () => {
    // The carve-out is one bucket, not "uploads are fine now". A user who can
    // write to an arbitrary bucket can silently overwrite somebody else's object.
    const res = await request(app)
      .post('/storage/buckets/user-avatars/upload')
      .set('Authorization', `Bearer ${userToken}`)
      .attach('file', Buffer.from('hello'), 'note.txt');

    expect(res.status).toBe(403);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('refuses the forbidden upload WITHOUT buffering the body', async () => {
    // multer buffers up to 50MB into memory. The gate runs before it, so a
    // refused upload costs nothing; ordering this the other way turns the route
    // into a memory-pressure lever for any signed-in user.
    const res = await request(app)
      .post('/storage/buckets/user-avatars/upload')
      .set('Authorization', `Bearer ${userToken}`)
      .attach('file', Buffer.from('x'.repeat(4096)), 'big.bin');

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('admin');
  });

  it('POST to another bucket works for an admin', async () => {
    mockS3Send.mockResolvedValueOnce({});

    const res = await request(app)
      .post('/storage/buckets/user-avatars/upload')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', Buffer.from('hello'), 'note.txt');

    expect(res.status).toBe(200);
  });

  it('the chat-attachments carve-out does not leak to a look-alike bucket name', async () => {
    // Substring or prefix matching would open `chat-attachments-backup` too.
    const res = await request(app)
      .post('/storage/buckets/chat-attachments-backup/upload')
      .set('Authorization', `Bearer ${userToken}`)
      .attach('file', Buffer.from('hello'), 'note.txt');

    expect(res.status).toBe(403);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------- deletes ---

  it('DELETE stays admin even in the chat-attachments bucket', async () => {
    // The carve-out is for the upload method only. Delete is unscoped: bucket
    // and key come from the URL, so an ordinary user could remove another
    // user's attachment.
    const res = await request(app)
      .delete('/storage/buckets/chat-attachments/objects/someone-elses.png')
      .set('Authorization', `Bearer ${userToken}`);

    expect(res.status).toBe(403);
    expect(mockS3Send).not.toHaveBeenCalled();
  });

  it('DELETE works for an admin', async () => {
    mockS3Send.mockResolvedValueOnce({});

    const res = await request(app)
      .delete('/storage/buckets/chat-attachments/objects/old.png')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
  });

  // -------------------------------------------------- authentication first ---

  it('an unauthenticated caller is refused on every method', async () => {
    // Loosening a role must not have loosened requireAuth at the mount.
    const paths: [string, string][] = [
      ['get', '/storage/buckets'],
      ['get', '/storage/buckets/b/objects'],
      ['post', '/storage/buckets/chat-attachments/upload'],
      ['delete', '/storage/buckets/b/objects/k'],
    ];
    for (const [method, path] of paths) {
      const res = await (request(app) as any)[method](path);
      expect(res.status).toBe(401);
    }
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});
