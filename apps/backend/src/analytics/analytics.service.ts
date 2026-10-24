import { Injectable } from '@nestjs/common';
import { Actor } from '../identity/auth.service';
import { TenantService } from '../tenancy/tenant.service';

interface CountRow {
  count: string;
}

export interface TechnicalAnalytics {
  period: { kind: 'rolling_30_days_utc'; from: Date; to: Date };
  financialStatus: 'not_defined';
  billable: false;
  entitlementGranted: false;
  conversationsOpened: string;
  aiTurnsStarted: string;
  aiTurnsCompleted: string;
  aiTurnsFailed: string;
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly tenants: TenantService) {}

  summary(actor: Actor, tenantId: string): Promise<TechnicalAnalytics> {
    return this.tenants.scoped(actor, tenantId, 'audit:read', async (tx) => {
      const to = new Date();
      const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      const [conversations] = await tx.$queryRaw<CountRow[]>`
        SELECT COUNT(*)::text AS count FROM conversations
        WHERE tenant_id=${tenantId}::uuid AND opened_at >= ${from} AND opened_at < ${to}`;
      const [turns] = await tx.$queryRaw<
        Array<{ started: string; completed: string; failed: string }>
      >`
        SELECT COUNT(*)::text AS started,
          COUNT(*) FILTER (WHERE status='completed')::text AS completed,
          COUNT(*) FILTER (WHERE status='failed')::text AS failed
        FROM ai_turns
        WHERE tenant_id=${tenantId}::uuid AND started_at >= ${from} AND started_at < ${to}`;
      return {
        period: { kind: 'rolling_30_days_utc', from, to },
        financialStatus: 'not_defined',
        billable: false,
        entitlementGranted: false,
        conversationsOpened: conversations?.count ?? '0',
        aiTurnsStarted: turns?.started ?? '0',
        aiTurnsCompleted: turns?.completed ?? '0',
        aiTurnsFailed: turns?.failed ?? '0',
      };
    });
  }
}
