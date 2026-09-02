import { TenantRole } from '@prisma/client';
export type Permission =
  | 'tenant:read'
  | 'tenant:write'
  | 'members:read'
  | 'members:write'
  | 'audit:read';
const permissions: Record<TenantRole, readonly Permission[]> = {
  owner: ['tenant:read', 'tenant:write', 'members:read', 'members:write', 'audit:read'],
  admin: ['tenant:read', 'tenant:write', 'members:read', 'members:write', 'audit:read'],
  manager: ['tenant:read'],
  staff: ['tenant:read'],
  viewer: ['tenant:read'],
};
export function allows(role: TenantRole, permission: Permission): boolean {
  return permissions[role].includes(permission);
}
