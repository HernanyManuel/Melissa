import { TenantRole } from '@prisma/client';
export type Permission =
  | 'customers:read'
  | 'customers:write'
  | 'tenant:read'
  | 'tenant:write'
  | 'members:read'
  | 'members:write'
  | 'audit:read'
  | 'business:read'
  | 'business:write';
const permissions: Record<TenantRole, readonly Permission[]> = {
  owner: [
    'customers:read',
    'customers:write',
    'tenant:read',
    'tenant:write',
    'members:read',
    'members:write',
    'audit:read',
    'business:read',
    'business:write',
  ],
  admin: [
    'customers:read',
    'customers:write',
    'tenant:read',
    'tenant:write',
    'members:read',
    'members:write',
    'audit:read',
    'business:read',
    'business:write',
  ],
  manager: ['tenant:read', 'business:read', 'business:write', 'customers:read', 'customers:write'],
  staff: ['tenant:read', 'business:read', 'customers:read'],
  viewer: ['tenant:read', 'business:read'],
};
export function allows(role: TenantRole, permission: Permission): boolean {
  return permissions[role].includes(permission);
}
