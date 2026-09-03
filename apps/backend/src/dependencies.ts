import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { CONFIG, Configuration } from './config';
import { log } from './logging';

@Injectable()
export class Dependencies implements OnModuleDestroy {
  readonly db: PrismaClient;
  readonly redis: Redis;

  constructor(@Inject(CONFIG) config: Configuration) {
    this.db = new PrismaClient({ datasources: { db: { url: config.DATABASE_URL } } });
    this.redis = new Redis(config.REDIS_URL, {
      connectTimeout: 1000,
      commandTimeout: 1500,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.redis.on('error', () => log.warn({ event: 'redis_unavailable' }));
  }

  async ready(): Promise<boolean> {
    try {
      const [rows, pong] = await Promise.all([
        this.db.infrastructureMetadata.findUnique({ where: { key: 'schema_version' } }),
        this.redis.ping(),
      ]);
      const [role] = await this.db.$queryRaw<{ safe: boolean }[]>`
        SELECT NOT (rolsuper OR rolbypassrls) AND
          NOT EXISTS (SELECT FROM pg_class WHERE relname='tenants' AND relowner=pg_roles.oid)
          AS safe FROM pg_roles WHERE rolname=current_user`;
      return rows?.value === '10' && pong === 'PONG' && role?.safe === true;
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
    await this.db.$disconnect();
  }
}
