import { Router, Request, Response } from 'express';
import multer from 'multer';
import { requireRole } from '../middleware/role';
import { getPool } from '../db/pool';
import { getS3Client } from '../services/s3';
import {
  processAvatar,
  avatarKey,
  uploadAvatar,
  deleteAvatar,
  getAvatarStream,
} from '../services/avatar';
import {
  getKeycloakProfile,
  updateKeycloakProfile,
} from '../services/keycloak-account';
import { getIssuer } from '../middleware/keycloak-config';
import { auditLog } from '../helpers/audit';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function getBearerToken(req: Request): string {
  return req.headers.authorization!.slice(7);
}

// GET /profile — fetch Keycloak profile + DB avatar key
router.get('/', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const token = getBearerToken(req);

    const [kcProfile, dbResult] = await Promise.all([
      getKeycloakProfile(getIssuer(), token),
      getPool().query(
        'SELECT avatar_key FROM user_profiles WHERE keycloak_id = $1',
        [user.sub]
      ),
    ]);

    res.json({
      username: kcProfile.username,
      firstName: kcProfile.firstName,
      lastName: kcProfile.lastName,
      email: kcProfile.email,
      emailVerified: kcProfile.emailVerified,
      hasAvatar: !!(dbResult.rows[0]?.avatar_key),
    });
  } catch (err) {
    console.error('[profile] GET error:', err);
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

// PATCH /profile — update display name via Keycloak Account API
router.patch('/', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const { firstName, lastName } = req.body;

    if (firstName !== undefined && (typeof firstName !== 'string' || firstName.length > 100)) {
      res.status(400).json({ error: 'firstName must be a string of max 100 characters' });
      return;
    }
    if (lastName !== undefined && (typeof lastName !== 'string' || lastName.length > 100)) {
      res.status(400).json({ error: 'lastName must be a string of max 100 characters' });
      return;
    }
    if (firstName === undefined && lastName === undefined) {
      res.status(400).json({ error: 'At least one of firstName or lastName is required' });
      return;
    }

    const token = getBearerToken(req);
    const updates: { firstName?: string; lastName?: string } = {};
    if (firstName !== undefined) updates.firstName = firstName;
    if (lastName !== undefined) updates.lastName = lastName;

    const updated = await updateKeycloakProfile(getIssuer(), token, updates);
    res.json({
      firstName: updated.firstName,
      lastName: updated.lastName,
    });
  } catch (err) {
    console.error('[profile] PATCH error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// POST /profile/avatar — upload avatar
router.post('/avatar', requireRole('user'), upload.single('avatar'), async (req: Request, res: Response) => {
  // avatarKey() mints a fresh random-UUID key every call — a retry after
  // failure never reclaims or overwrites a previous attempt's key, it only
  // creates another one. So once uploadAvatar() below succeeds, that S3
  // object exists whether or not anything after it does; this is hoisted
  // so both catches can name it if it ends up orphaned (#424).
  let uploadedKey: string | null = null;
  try {
    const user = (req as any).user;
    const file = req.file;

    if (!file) {
      res.status(400).json({ error: 'No file uploaded' });
      return;
    }
    if (!ALLOWED_MIMES.includes(file.mimetype)) {
      res.status(400).json({ error: 'Invalid file type. Allowed: JPEG, PNG, GIF, WebP' });
      return;
    }

    const processed = await processAvatar(file.buffer);
    const key = avatarKey(user.sub);
    const s3 = getS3Client();

    // Check for existing avatar to delete old S3 object
    const { rows } = await getPool().query(
      'SELECT avatar_key FROM user_profiles WHERE keycloak_id = $1',
      [user.sub]
    );
    const oldKey = rows[0]?.avatar_key;

    await uploadAvatar(s3, key, processed);
    uploadedKey = key;

    // Upsert profile row
    await getPool().query(
      `INSERT INTO user_profiles (keycloak_id, avatar_key)
       VALUES ($1, $2)
       ON CONFLICT (keycloak_id) DO UPDATE SET avatar_key = $2, updated_at = NOW()`,
      [user.sub, key]
    );

    // Delete old S3 object after successful upsert
    if (oldKey) {
      try {
        await deleteAvatar(s3, oldKey);
      } catch (err) {
        console.error('[profile] Failed to delete old avatar:', err);
        auditLog('avatar_old_key_cleanup_failed', user.sub, user.sub, 'human', {
          stale_key: oldKey, error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    res.json({ message: 'Avatar uploaded' });
  } catch (err) {
    console.error('[profile] POST avatar error:', err);
    // uploadedKey set means the S3 object was created but something after
    // it failed (the DB upsert) — that object now exists with nothing in
    // the database referencing it. Audited rather than left as a
    // console.error nobody reads, same "the audit stream doesn't depend
    // on the row surviving" reasoning already applied elsewhere in this
    // sweep (#424).
    if (uploadedKey) {
      const user = (req as any).user;
      auditLog('avatar_upload_orphaned_object', user?.sub || 'unknown', user?.sub || 'unknown', 'human', {
        orphaned_key: uploadedKey, error: err instanceof Error ? err.message : String(err),
      });
    }
    res.status(500).json({ error: 'Failed to upload avatar' });
  }
});

// DELETE /profile/avatar — delete avatar
router.delete('/avatar', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { rows } = await getPool().query(
      'SELECT avatar_key FROM user_profiles WHERE keycloak_id = $1',
      [user.sub]
    );

    if (!rows[0]?.avatar_key) {
      res.status(404).json({ error: 'No avatar found' });
      return;
    }

    const s3 = getS3Client();
    const deletedKey = rows[0].avatar_key;
    await deleteAvatar(s3, deletedKey);

    try {
      await getPool().query(
        'UPDATE user_profiles SET avatar_key = NULL, updated_at = NOW() WHERE keycloak_id = $1',
        [user.sub]
      );
    } catch (err) {
      // The S3 object is genuinely gone by this point — a retry of this
      // same route is safe (S3 DELETE is idempotent on an already-missing
      // key) and will repeat this UPDATE until it lands. What this must
      // not do is vanish into the generic catch below unaudited: the
      // resulting dangling avatar_key is already surfaced honestly on the
      // next GET /avatar (see that route's own comment), but that only
      // shows THAT it went stale, not WHY (#424).
      console.error('[profile] Avatar deleted from S3 but DB update failed:', err);
      auditLog('avatar_delete_db_update_failed', user.sub, user.sub, 'human', {
        deleted_key: deletedKey, error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    res.json({ message: 'Avatar deleted' });
  } catch (err) {
    console.error('[profile] DELETE avatar error:', err);
    res.status(500).json({ error: 'Failed to delete avatar' });
  }
});

// GET /profile/avatar — stream avatar from S3
router.get('/avatar', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { rows } = await getPool().query(
      'SELECT avatar_key FROM user_profiles WHERE keycloak_id = $1',
      [user.sub]
    );

    if (!rows[0]?.avatar_key) {
      // 204, not 404. "This user has not set an avatar" is the normal state for
      // every account that has never uploaded one, and TopBar asks on every
      // authenticated page load, so a 404 here meant a permanent error in the
      // console and the access log of a working system.
      //
      // Callers must treat 204 as "no avatar": it is a 2xx, so `res.ok` is true
      // and a naive reader would build an object URL from an empty body.
      res.status(204).end();
      return;
    }

    const s3 = getS3Client();
    const { stream, etag } = await getAvatarStream(s3, rows[0].avatar_key);

    // Support conditional requests
    if (etag && req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, no-cache');
    if (etag) res.setHeader('ETag', etag);

    (stream as any).pipe(res);
  } catch (err: any) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      // Deliberately still 404, and deliberately different from the branch above.
      // Here the database says this user HAS an avatar and object storage
      // disagrees — a dangling avatar_key, a real inconsistency worth staying
      // visible. It cannot fire on the page-load path, which has no row at all.
      res.status(404).json({ error: 'No avatar found' });
      return;
    }
    console.error('[profile] GET avatar error:', err);
    res.status(500).json({ error: 'Failed to fetch avatar' });
  }
});

// ── Preferences ──────────────────────────────────────────────────

const DEFAULT_PREFERENCES = {
  theme: 'dark',
  notifications_enabled: true,
  sidebar_collapsed: false,
};

// GET /profile/preferences — fetch user preferences
router.get('/preferences', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { rows } = await getPool().query(
      'SELECT preferences FROM user_preferences WHERE keycloak_id = $1',
      [user.sub]
    );

    res.json(rows[0]?.preferences ?? DEFAULT_PREFERENCES);
  } catch (err) {
    console.error('[profile] GET preferences error:', err);
    res.status(500).json({ error: 'Failed to fetch preferences' });
  }
});

// PUT /profile/preferences — upsert user preferences (shallow merge)
router.put('/preferences', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const incoming = req.body;

    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      res.status(400).json({ error: 'Request body must be a JSON object' });
      return;
    }

    // Shallow merge: incoming keys overwrite, unspecified keys kept from DB/default
    const { rows: existing } = await getPool().query(
      'SELECT preferences FROM user_preferences WHERE keycloak_id = $1',
      [user.sub]
    );
    const current = existing[0]?.preferences ?? DEFAULT_PREFERENCES;
    const merged = { ...current, ...incoming };

    const { rows } = await getPool().query(
      `INSERT INTO user_preferences (keycloak_id, preferences)
       VALUES ($1, $2)
       ON CONFLICT (keycloak_id) DO UPDATE SET preferences = $2, updated_at = NOW()
       RETURNING preferences`,
      [user.sub, JSON.stringify(merged)]
    );

    res.json(rows[0].preferences);
  } catch (err) {
    console.error('[profile] PUT preferences error:', err);
    res.status(500).json({ error: 'Failed to save preferences' });
  }
});

// POST /profile/password — change password
// NOTE: Keycloak 12+ removed the /account/credentials/password REST endpoint.
// Password changes now require a browser redirect via kc_action=UPDATE_PASSWORD.
// This endpoint returns a structured 501 until a browser-based flow is implemented in the UI.
router.post('/password', requireRole('user'), (_req: Request, res: Response) => {
  res.status(501).json({
    error: 'Password change not yet available',
    code: 'NOT_IMPLEMENTED',
  });
});

export default router;
