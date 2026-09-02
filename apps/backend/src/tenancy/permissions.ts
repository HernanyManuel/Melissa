import { TenantRole } from '@prisma/client';
export type Permission =
  | 'messages:read'
  | 'channels:manage'
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
    'messages:read',
    'channels:manage',
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
    'messages:read',
    'channels:manage',
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
  manager: [
    'tenant:read',
    'business:read',
    'business:write',
    'customers:read',
    'customers:write',
    'messages:read',
  ],
  staff: ['tenant:read', 'business:read', 'customers:read', 'messages:read'],
  viewer: ['tenant:read', 'business:read'],
};
export function allows(role: TenantRole, permission: Permission): boolean {
  return permissions[role].includes(permission);
}
