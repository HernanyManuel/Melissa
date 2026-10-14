import { Injectable } from '@nestjs/common';
import { Actor } from '../identity/auth.service';
import { TenantService } from '../tenancy/tenant.service';

// An observed AI turn is not a "billable conversation" and no computed
// token count proves an invoice, an entitlement, or an amount owed.
interface ObservationTotals {
  sourceOutcome: string;
  events: string;
  inputTokens: string;
  outputTokens: string;
}

export interface TechnicalUsageReport {
  meter: 'ai_turn_tokens_observed';
  window: { from: Date; to: Date; days: 30 };
  billable: false;
  financialStatus: 'not_defined';
  entitlementGranted: false;
  events: string;
  inputTokens: string;
  outputTokens: string;
  outcomes: Array<{
    outcome: string;
    events: string;
    inputTokens: string;
    outputTokens: string;
  }>;
}

@Injectable()
export class BillingUsageService {
  constructor(private readonly tenants: TenantService) {}

  report(actor: Actor, tenantId: string): Promise<TechnicalUsageReport> {
    return this.tenants.scoped(actor, tenantId, 'billing:read', async (tx) => {
      const to = new Date();
      const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      const rows = await tx.$queryRaw<ObservationTotals[]>`
        SELECT source_outcome AS "sourceOutcome",
          COUNT(*)::text AS events,
          COALESCE(SUM(input_tokens),0)::text AS "inputTokens",
          COALESCE(SUM(output_tokens),0)::text AS "outputTokens"
        FROM billing_usage_observations
        WHERE tenant_id=${tenantId}::uuid
          AND observed_at >= ${from} AND observed_at < ${to}
        GROUP BY source_outcome ORDER BY source_outcome`;
      let events = 0n;
      let inputTokens = 0n;
      let outputTokens = 0n;
      for (const row of rows) {
        events += BigInt(row.events);
        inputTokens += BigInt(row.inputTokens);
        outputTokens += BigInt(row.outputTokens);
      }
      return {
        meter: 'ai_turn_tokens_observed',
        window: { from, to, days: 30 },
        billable: false,
        financialStatus: 'not_defined',
        entitlementGranted: false,
        events: events.toString(),
        inputTokens: inputTokens.toString(),
        outputTokens: outputTokens.toString(),
        outcomes: rows.map(({ sourceOutcome, ...totals }) => ({
          outcome: sourceOutcome,
          ...totals,
        })),
      };
    });
  }
}
