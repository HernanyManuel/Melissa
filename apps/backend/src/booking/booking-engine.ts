import { Dependencies } from '../dependencies';

export class BookingEngine {
  constructor(private readonly deps: Dependencies) {}

  async ensureDefaultResource(tenantId: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      await tx.$executeRaw`
        INSERT INTO booking_resources (tenant_id, kind, name)
        VALUES (${tenantId}::uuid, 'default', 'Default resource')
        ON CONFLICT DO NOTHING
      `;

      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text
        FROM booking_resources
        WHERE tenant_id=${tenantId}::uuid AND kind='default' AND active=true
        LIMIT 1
      `;
      const resource = rows[0];
      if (!resource) throw new Error('Default booking resource is unavailable');
      return resource.id;
    });
  }
}
