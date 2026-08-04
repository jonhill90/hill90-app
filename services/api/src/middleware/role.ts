import { Request, Response, NextFunction } from 'express';
import { rolesFrom } from './keycloak-config';

/**
 * Which client roles imply which others (#277).
 *
 * `hill90-ui` has exactly two client roles in realm `platform`: `user` and `admin`.
 * `admin` is not a sibling of `user` here, it is a superset — every `admin` route in
 * this service is a more privileged operation on a resource the `user` routes
 * already expose (start/stop/delete an agent, read its logs, write skills, tools and
 * container profiles, reach /admin/secrets and /docs).
 *
 * THIS IS THE CODE'S OWN POSITION, not a preference imposed on it. Ten route files
 * hold 61 branches on `includes('admin')` / `isAdmin(req)` sitting BEHIND a
 * `requireRole('user')` gate — `/usage` widens its query for admins, chat and agents
 * scope by ownership, model-policies and provider-connections admit platform-owned
 * rows. Before this map, a principal holding only `admin` could not pass those gates,
 * so all 61 branches were unreachable for exactly the principal they were written
 * for.
 *
 * WHY A MAP RATHER THAN LISTING BOTH ROLES AT EVERY ROUTE. The alternative is
 * `requireRole(['user','admin'])` at all 117 `user` sites. It was rejected on cost
 * and on failure direction, and the trade is worth stating because it is not
 * obvious:
 *
 *   - listing per route fails LOUD but often: any route that forgets `admin` returns
 *     403 to an administrator. That is a safe direction and a recurring annoyance,
 *     and it puts the obligation on 117 existing sites plus every future one.
 *   - a central map fails SILENT but once: if a future role is orthogonal rather
 *     than a subset and someone adds it here carelessly, every route gated on it
 *     admits admins with no complaint from anyone.
 *
 * The second risk is bounded to these four lines, so it is made loud deliberately:
 * `role-hierarchy.test.ts` pins this object exactly, and adding a third client role
 * fails that test until someone decides where it belongs. The first risk cannot be
 * bounded that way — nothing can test that a route not yet written listed a role.
 *
 * The implication runs ONE WAY. `user` never implies `admin`, and a role that is not
 * a key here grants itself and nothing else.
 */
export const ROLE_IMPLIES: Record<string, readonly string[]> = {
  admin: ['user'],
};

/**
 * Expand granted roles into everything they confer.
 *
 * Deliberately not recursive: the map is one level deep and pinned by a test, so a
 * transitive chain cannot exist without that test failing first. A recursive walk
 * here would quietly accommodate a hierarchy nobody had agreed to.
 */
export function effectiveRoles(granted: string[]): Set<string> {
  const out = new Set<string>(granted);
  for (const role of granted) {
    for (const implied of ROLE_IMPLIES[role] ?? []) out.add(implied);
  }
  return out;
}

export function requireRole(role: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = (req as any).user;
    if (!user) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    // rolesFrom reads ONLY resource_access.<client>.roles. Authorisation here is by
    // CLIENT role: the platform realm role `admin` grants Grafana Admin and OpenBao,
    // and an app administrator must not inherit infrastructure administration.
    if (!effectiveRoles(rolesFrom(user)).has(role)) {
      res.status(403).json({ error: `Requires ${role} role` });
      return;
    }

    next();
  };
}
