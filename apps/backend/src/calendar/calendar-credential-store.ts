import { Prisma } from '@prisma/client';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isUUID } from 'class-validator';
import { Dependencies } from '../dependencies';
import {
  SecretResolver,
  SecretUnavailable,
  validateSecretReference,
} from '../secrets/secret-resolver';

// prettier-ignore
const REFERENCE = /^secret:\/\/calendar-db\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const MAX_TOKEN_LENGTH = 4096;
const MAX_SCOPES = 64;

export interface CalendarCredentialKey {
  id: string;
  key: Buffer;
}

export interface CalendarCredentialKeyring {
  current: CalendarCredentialKey;
  resolve(keyId: string): Buffer | null;
}

export interface CalendarCredential {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date;
  scopes: string[];
}

export class CalendarCredentialReauthRequired extends Error {
  constructor() {
    super('Calendar credential requires reauthorization');
    this.name = 'CalendarCredentialReauthRequired';
  }
}

export interface CalendarCredentialRefresher {
  refresh(refreshToken: string): Promise<CalendarCredential>;
}

interface EncryptedCredentialRow {
  keyId: string;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
}

interface StoredCredential {
  v: 1;
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: string;
  scopes: string[];
}

// prettier-ignore
export function calendarCredentialReference(tenantId: string, connectionId: string): string {
  if (!isUUID(tenantId) || !isUUID(connectionId)) throw new SecretUnavailable();
  return `secret://calendar-db/${tenantId}/${connectionId}`;
}

// prettier-ignore
export class CalendarCredentialStore implements SecretResolver {
  constructor(
    private readonly deps: Dependencies,
    private readonly keys: CalendarCredentialKeyring,
    private readonly refresher: CalendarCredentialRefresher | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.validateKey(keys.current);
  }

  async put(input: {
    tenantId: string;
    connectionId: string;
    credential: CalendarCredential;
  }): Promise<string> {
    return this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${input.tenantId}, true)`;
      return this.putInTransaction(tx, input);
    });
  }

  async putInTransaction(
    tx: Prisma.TransactionClient,
    input: {
      tenantId: string;
      connectionId: string;
      credential: CalendarCredential;
    },
  ): Promise<string> {
    const reference = calendarCredentialReference(input.tenantId, input.connectionId);
    const credential = this.normalizeCredential(input.credential);
    const plaintext = Buffer.from(JSON.stringify(credential), 'utf8');
    if (plaintext.byteLength > 16384) throw new SecretUnavailable();

    const key = this.keys.current;
    this.validateKey(key);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key.key, nonce);
    cipher.setAAD(this.aad(input.tenantId, input.connectionId, key.id));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const connection = await tx.$queryRaw<Array<{ provider: string }>>(Prisma.sql`
      SELECT provider
      FROM calendar_connections
      WHERE tenant_id=${input.tenantId}::uuid AND id=${input.connectionId}::uuid
      FOR UPDATE
    `);
    if (connection.length !== 1 || connection[0]?.provider !== 'google')
      throw new SecretUnavailable();
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO calendar_credentials (
        tenant_id, connection_id, key_id, nonce, ciphertext, tag, updated_at
      ) VALUES (
        ${input.tenantId}::uuid, ${input.connectionId}::uuid, ${key.id},
        ${nonce}, ${ciphertext}, ${tag}, CURRENT_TIMESTAMP
      )
      ON CONFLICT (tenant_id, connection_id) DO UPDATE SET
        key_id=EXCLUDED.key_id,
        nonce=EXCLUDED.nonce,
        ciphertext=EXCLUDED.ciphertext,
        tag=EXCLUDED.tag,
        updated_at=CURRENT_TIMESTAMP
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE calendar_connections
      SET credential_ref=${reference}, updated_at=CURRENT_TIMESTAMP
      WHERE tenant_id=${input.tenantId}::uuid AND id=${input.connectionId}::uuid
    `);
    return reference;
  }

  async read(reference: string): Promise<CalendarCredential> {
    const parsed = this.parseReference(reference);
    const row = await this.deps.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${parsed.tenantId}, true)`;
      const [credential] = await tx.$queryRaw<EncryptedCredentialRow[]>(Prisma.sql`
        SELECT
          key_id AS "keyId",
          nonce,
          ciphertext,
          tag
        FROM calendar_credentials
        WHERE tenant_id=${parsed.tenantId}::uuid
          AND connection_id=${parsed.connectionId}::uuid
      `);
      return credential;
    });
    if (!row) throw new SecretUnavailable();
    return this.decrypt(parsed.tenantId, parsed.connectionId, row);
  }

  async resolve(reference: string): Promise<string> {
    const parsed = this.parseReference(reference);
    const credential = await this.read(reference);
    if (credential.accessTokenExpiresAt > this.now()) return credential.accessToken;
    if (!credential.refreshToken || !this.refresher) throw new SecretUnavailable();

    let refreshed: CalendarCredential;
    try {
      refreshed = await this.refresher.refresh(credential.refreshToken);
    } catch (error) {
      if (error instanceof CalendarCredentialReauthRequired) await this.markReauthRequired(parsed);
      throw new SecretUnavailable();
    }

    const replacement: CalendarCredential = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? credential.refreshToken,
      accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
      scopes: refreshed.scopes.length > 0 ? refreshed.scopes : credential.scopes,
    };
    await this.put({ ...parsed, credential: replacement });
    return replacement.accessToken;
  }

  private async markReauthRequired(parsed: { tenantId: string; connectionId: string }): Promise<void> {
    try {
      await this.deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${parsed.tenantId}, true)`;
        await tx.$executeRaw(Prisma.sql`
          UPDATE calendar_connections
          SET status='reauth_required', updated_at=CURRENT_TIMESTAMP
          WHERE tenant_id=${parsed.tenantId}::uuid AND id=${parsed.connectionId}::uuid
        `);
      });
    } catch {
      // Credential resolution must fail closed even if status bookkeeping is unavailable.
    }
  }

  private decrypt(tenantId: string, connectionId: string, row: EncryptedCredentialRow): CalendarCredential {
    const key = this.keys.resolve(row.keyId);
    if (!key || key.byteLength !== 32) throw new SecretUnavailable();
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, row.nonce);
      decipher.setAAD(this.aad(tenantId, connectionId, row.keyId));
      decipher.setAuthTag(row.tag);
      const plaintext = Buffer.concat([decipher.update(row.ciphertext), decipher.final()]);
      const decoded = JSON.parse(plaintext.toString('utf8')) as unknown;
      return this.decodeCredential(decoded);
    } catch {
      throw new SecretUnavailable();
    }
  }

  private parseReference(reference: string): { tenantId: string; connectionId: string } {
    const match = REFERENCE.exec(validateSecretReference(reference));
    if (!match?.[1] || !match[2]) throw new SecretUnavailable();
    return { tenantId: match[1], connectionId: match[2] };
  }

  private normalizeCredential(input: CalendarCredential): StoredCredential {
    const accessToken = this.token(input.accessToken);
    const refreshToken = input.refreshToken === null ? null : this.token(input.refreshToken);
    if (!(input.accessTokenExpiresAt instanceof Date) || Number.isNaN(input.accessTokenExpiresAt.getTime()))
      throw new SecretUnavailable();
    if (!Array.isArray(input.scopes) || input.scopes.length > MAX_SCOPES)
      throw new SecretUnavailable();
    const scopes = [...new Set(input.scopes.map((scope) => this.scope(scope)))].sort();
    return {
      v: 1,
      accessToken,
      refreshToken,
      accessTokenExpiresAt: input.accessTokenExpiresAt.toISOString(),
      scopes,
    };
  }

  private decodeCredential(value: unknown): CalendarCredential {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SecretUnavailable();
    const item = value as Partial<StoredCredential>;
    if (item.v !== 1 || typeof item.accessTokenExpiresAt !== 'string') throw new SecretUnavailable();
    const expiresAt = new Date(item.accessTokenExpiresAt);
    return {
      accessToken: this.token(item.accessToken),
      refreshToken: item.refreshToken === null ? null : this.token(item.refreshToken),
      accessTokenExpiresAt: expiresAt,
      scopes: Array.isArray(item.scopes) ? item.scopes.map((scope) => this.scope(scope)) : [],
    };
  }

  private token(value: unknown): string {
    if (
      typeof value !== 'string' ||
      value.length < 16 ||
      value.length > MAX_TOKEN_LENGTH ||
      value !== value.trim() ||
      /[\u0000-\u001f\u007f]/.test(value)
    )
      throw new SecretUnavailable();
    return value;
  }

  private scope(value: unknown): string {
    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > 256 ||
      value !== value.trim() ||
      /[\u0000-\u001f\u007f]/.test(value)
    )
      throw new SecretUnavailable();
    return value;
  }

  private aad(tenantId: string, connectionId: string, keyId: string): Buffer {
    return Buffer.from(JSON.stringify(['calendar-credential-v1', tenantId, connectionId, keyId]));
  }

  private validateKey(key: CalendarCredentialKey): void {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(key.id) || key.key.byteLength !== 32)
      throw new SecretUnavailable();
  }
}
