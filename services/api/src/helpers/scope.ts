import { Request } from 'express';
import { rolesFrom } from '../middleware/keycloak-config';

interface ScopeResult {
  where: string;
  params: string[];
}

export function scopeToOwner(req: Request): ScopeResult {
  const user = (req as any).user;
  const roles: string[] = rolesFrom(user);

  if (roles.includes('admin')) {
    return { where: '1=1', params: [] };
  }

  return { where: 'created_by = $1', params: [user.sub] };
}
