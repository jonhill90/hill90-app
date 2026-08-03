import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import {
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getS3Client } from '../services/s3';
import { requireRole } from '../middleware/role';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const router = Router();

/**
 * Per-method roles, following container-profiles.ts, rather than one blanket
 * gate at the mount.
 *
 * This router used to open with `router.use(requireRole('admin'))`. `requireRole`
 * is flat — `role.ts` does a plain `roles.includes(role)` — so `user` granted
 * nothing here, and two of the three UI callers are pages offered to every
 * signed-in user. Attaching a file in chat required the admin role, and the
 * monitoring page rendered its own 403 as `storage: unhealthy`.
 *
 * The other direction is just as wrong. `PutObjectCommand` overwrites silently,
 * and neither the object listing nor the delete is scoped to the caller — bucket
 * and key come straight from the URL. So the reads and writes that cross between
 * users stay admin, and exactly one write is opened up: the chat attachment
 * upload, which is the only one an ordinary user is actually offered.
 */
const CHAT_ATTACHMENTS_BUCKET = 'chat-attachments';

/**
 * Ordinary users may upload to the chat attachment bucket and nowhere else.
 *
 * Exact equality, not a prefix: `chat-attachments-backup` must not inherit the
 * carve-out. This runs BEFORE multer, so a refused upload never buffers its body
 * — multer holds up to 50MB in memory, and gating after it would hand any signed
 * -in user a memory-pressure lever.
 */
function requireUploadRole(req: Request, res: Response, next: NextFunction): void {
  const gate = req.params.name === CHAT_ATTACHMENTS_BUCKET
    ? requireRole('user')
    : requireRole('admin');
  gate(req, res, next);
}

// GET /storage/buckets — list all MinIO buckets
// `user`: a list of bucket names, which the monitoring page needs and every
// signed-in user reaches. Object CONTENTS remain admin, below.
router.get('/buckets', requireRole('user'), async (_req: Request, res: Response) => {
  try {
    const s3 = getS3Client();
    const result = await s3.send(new ListBucketsCommand({}));

    const buckets = (result.Buckets || []).map((b) => ({
      name: b.Name,
      created_at: b.CreationDate?.toISOString() || null,
    }));

    res.json(buckets);
  } catch (err: any) {
    console.error('[storage] Failed to list buckets:', err);
    res.status(502).json({ error: 'Failed to connect to storage service' });
  }
});

// GET /storage/buckets/:name/objects — list objects in a bucket
// admin: enumerates every object in an arbitrary bucket, including other
// users' objects. Nothing here is scoped to the caller.
router.get('/buckets/:name/objects', requireRole('admin'), async (req: Request, res: Response) => {
  const { name } = req.params;
  const prefix = (req.query.prefix as string) || '';
  const maxKeys = Math.min(parseInt(req.query.max_keys as string) || 100, 1000);
  const continuationToken = (req.query.continuation_token as string) || undefined;

  try {
    const s3 = getS3Client();
    const result = await s3.send(new ListObjectsV2Command({
      Bucket: name,
      Prefix: prefix || undefined,
      Delimiter: '/',
      MaxKeys: maxKeys,
      ContinuationToken: continuationToken,
    }));

    const objects = (result.Contents || []).map((obj) => ({
      key: obj.Key,
      size: obj.Size,
      last_modified: obj.LastModified?.toISOString() || null,
      etag: obj.ETag,
    }));

    const prefixes = (result.CommonPrefixes || []).map((p) => p.Prefix);

    res.json({
      objects,
      prefixes,
      is_truncated: result.IsTruncated || false,
      next_continuation_token: result.NextContinuationToken || null,
      key_count: result.KeyCount || 0,
    });
  } catch (err: any) {
    if (err.name === 'NoSuchBucket' || err.$metadata?.httpStatusCode === 404) {
      res.status(404).json({ error: `Bucket '${name}' not found` });
      return;
    }
    console.error(`[storage] Failed to list objects in ${name}:`, err);
    res.status(502).json({ error: 'Failed to list objects from storage service' });
  }
});

// POST /storage/buckets/:name/upload — upload a file
// user for chat-attachments, admin for anything else — see requireUploadRole.
router.post('/buckets/:name/upload', requireUploadRole, upload.single('file'), async (req: Request, res: Response) => {
  const { name } = req.params;
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: 'No file provided' });
    return;
  }

  const key = (req.body.key as string) || file.originalname;

  try {
    const s3 = getS3Client();
    await s3.send(new PutObjectCommand({
      Bucket: name,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    }));

    res.json({ key, size: file.size, content_type: file.mimetype });
  } catch (err: any) {
    if (err.name === 'NoSuchBucket' || err.$metadata?.httpStatusCode === 404) {
      res.status(404).json({ error: `Bucket '${name}' not found` });
      return;
    }
    console.error(`[storage] Failed to upload to ${name}:`, err);
    res.status(502).json({ error: 'Failed to upload to storage service' });
  }
});

// DELETE /storage/buckets/:name/objects/* — delete an object
// admin: destructive and unscoped. Bucket and key come from the URL, so an
// ordinary user could remove somebody else's attachment.
router.delete('/buckets/:name/objects/*', requireRole('admin'), async (req: Request, res: Response) => {
  const { name } = req.params;
  const key = req.params[0];
  if (!key) {
    res.status(400).json({ error: 'No object key provided' });
    return;
  }

  try {
    const s3 = getS3Client();
    await s3.send(new DeleteObjectCommand({
      Bucket: name,
      Key: key,
    }));

    res.json({ deleted: key });
  } catch (err: any) {
    if (err.name === 'NoSuchBucket' || err.$metadata?.httpStatusCode === 404) {
      res.status(404).json({ error: `Bucket '${name}' not found` });
      return;
    }
    console.error(`[storage] Failed to delete from ${name}:`, err);
    res.status(502).json({ error: 'Failed to delete from storage service' });
  }
});

export default router;
