import { PrismaClient } from '@prisma/client';
import { isUUID } from 'class-validator';
import { OutboundMockProcessor } from './outbound-mock-processor';

export class OutboundDispatchProcessor {
  constructor(
    private readonly db: PrismaClient,
    private readonly processor = new OutboundMockProcessor(db),
  ) {}

  async process(id: string, attempt: number): Promise<void> {
    if (!isUUID(id) || !Number.isInteger(attempt) || attempt < 0 || attempt >= 5)
      throw new Error('Invalid outbound job');
    // Never trust a tenant in a queue payload. Resolve the persisted envelope.
    const route = await this.db.outboundDispatch.findUnique({ where: { id } });
    if (
      !route ||
      route.state !== 'pending' ||
      route.attempts !== attempt ||
      route.nextAttemptAt > new Date()
    )
      return;
    try {
      await this.processor.process(route.tenantId, id);
    } catch {
      await this.settle(id, attempt, true);
      throw new Error('Outbound mock processing failed');
    }
    await this.settle(id, attempt, false);
  }

  private async settle(id: string, attempt: number, failed: boolean): Promise<void> {
    const route = await this.db.outboundDispatch.findUnique({ where: { id } });
    if (!route) return;
    await this.db.$transaction(async (tx) => {
      const tenantId = route.tenantId;
      await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenantId},true)`;
      await tx.$queryRaw`SELECT id FROM tenants WHERE id=${tenantId}::uuid FOR UPDATE`;
      const current = await tx.outboundDispatch.findUniqueOrThrow({ where: { id } });
      if (current.state !== 'pending') return;
      const result = await tx.outboundMockResult.findUnique({
        where: { tenantId_id: { tenantId, id } },
      });
      if (result) {
        // Recover a crash between result commit and envelope completion, without resending.
        await tx.outboundDispatch.update({ where: { id }, data: { state: result.state } });
        return;
      }
      if (!failed) throw new Error('Missing outbound result');
      if (current.attempts !== attempt) return;
      const attempts = attempt + 1;
      await tx.outboundDispatch.update({
        where: { id },
        data: {
          attempts,
          state: attempts === 5 ? 'failed' : 'pending',
          nextAttemptAt: new Date(Date.now() + Math.min(60000, 1000 * 2 ** attempt)),
        },
      });
      const intent = await tx.outboundIntent.findUniqueOrThrow({
        where: { tenantId_id: { tenantId, id } },
      });
      await tx.auditEvent.create({
        data: {
          tenantId,
          actorId: intent.actorId,
          actorType: 'user',
          action: attempts === 5 ? 'outbound.dispatch_failed' : 'outbound.dispatch_retry',
          targetId: id,
        },
      });
    });
  }
}
