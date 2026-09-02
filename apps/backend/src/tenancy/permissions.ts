import { TenantRole } from '@prisma/client';
export type Permission =
  | 'tenant:read'
  | 'tenant:write'
  | 'members:read'
  | 'members:write'
  | 'audit:read'
  | 'business:read'
  | 'business:write';
const permissions: Record<TenantRole, readonly Permission[]> = {
  owner: [
    'tenant:read',
    'tenant:write',
    'members:read',
    'members:write',
    'audit:read',
    'business:read',
    'business:write',
  ],
  admin: [
    'tenant:read',
    'tenant:write',
    'members:read',
    'members:write',
    'audit:read',
    'business:read',
    'business:write',
  ],
  manager: ['tenant:read', 'business:read', 'business:write'],
  staff: ['tenant:read', 'business:read'],
  viewer: ['tenant:read', 'business:read'],
};
export function allows(role: TenantRole, permission: Permission): boolean {
  return permissions[role].includes(permission);
}
