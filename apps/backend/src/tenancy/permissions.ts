import { TenantRole } from '@prisma/client';
export type Permission =
  | 'messages:read'
  | 'conversations:takeover'
  | 'conversations:reply'
  | 'channels:manage'
  | 'customers:read'
  | 'customers:write'
  | 'tenant:read'
  | 'tenant:write'
  | 'members:read'
  | 'members:write'
  | 'audit:read'
  | 'business:read'
  | 'business:write'
  | 'integration:write';
const permissions: Record<TenantRole, readonly Permission[]> = {
  owner: [
    'messages:read',
    'conversations:takeover',
    'conversations:reply',
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
    'integration:write',
  ],
  admin: [
    'messages:read',
    'conversations:takeover',
    'conversations:reply',
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
    'integration:write',
  ],
  manager: [
    'tenant:read',
    'business:read',
    'business:write',
    'customers:read',
    'customers:write',
    'messages:read',
    'conversations:takeover',
    'conversations:reply',
  ],
  staff: [
    'tenant:read',
    'business:read',
    'customers:read',
    'messages:read',
    'conversations:takeover',
    'conversations:reply',
  ],
  viewer: ['tenant:read', 'business:read'],
};
export function allows(role: TenantRole, permission: Permission): boolean {
  return permissions[role].includes(permission);
}
