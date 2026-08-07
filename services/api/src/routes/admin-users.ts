/**
 * app#500: the read-only slice. Lists every user in the realm alongside their
 * current hill90-ui client roles. No mutation endpoints exist yet — that is
 * deliberate; this slice exists to prove the credential path end to end
 * (client_credentials grant against the correctly-scoped service account,
 * scoped admin-API reads, rendered in the UI) before any write risk is added.
 *
 * Endpoints:
 *   GET /admin/users   — every user, with their hill90-ui client roles
 */
import { Router, Request, Response } from 'express';
import {
  listUsers,
  getClientUuid,
  getUserClientRoles,
  KeycloakAdminNotConfiguredError,
} from '../helpers/keycloak-admin-client';

const router = Router();

const HILL90_UI_CLIENT_ID = 'hill90-ui';

router.get('/', async (_req: Request, res: Response) => {
  try {
    const [users, clientUuid] = await Promise.all([
      listUsers(),
      getClientUuid(HILL90_UI_CLIENT_ID),
    ]);

    const withRoles = await Promise.all(
      users.map(async (user) => {
        const roles = await getUserClientRoles(user.id, clientUuid);
        return {
          id: user.id,
          username: user.username,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          enabled: user.enabled,
          hill90UiRoles: roles.map((r) => r.name).sort(),
        };
      }),
    );

    res.json({ users: withRoles });
  } catch (err) {
    if (err instanceof KeycloakAdminNotConfiguredError) {
      // 503, not an empty 200: this must never render as "there are no users".
      res.status(503).json({ error: err.message });
      return;
    }
    throw err; // caught by app.ts's terminal error handler
  }
});

export default router;
