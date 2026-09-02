import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { CONFIG, Configuration } from '../src/config';
import { Dependencies } from '../src/dependencies';
import { IdentityMail } from '../src/identity/mail';
import { configureHttp } from '../src/http';

test(
  'identity lifecycle, CSRF, role boundaries and PostgreSQL RLS under runtime role',
  { timeout: 60000 },
  async () => {
    const app = await NestFactory.create(AppModule, { logger: false });
    const config = app.get<Configuration>(CONFIG);
    const deps = app.get(Dependencies);
    const sent: { email: string; purpose: string; token: string }[] = [];
    app.get(IdentityMail).send = async (email, purpose, token) => {
      sent.push({ email, purpose, token });
    };
    configureHttp(app, config, false);
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const password = 'Integration-password-123!';
    const emailA = `a-${randomUUID()}@example.test`;
    const emailB = `b-${randomUUID()}@example.test`;
    const emailC = `c-${randomUUID()}@example.test`;
    const call = (
      method: string,
      path: string,
      body?: object,
      bearer?: string,
      headers: Record<string, string> = {},
    ) =>
      fetch(base + '/api/v1' + path, {
        method,
        headers: {
          Origin: config.CORS_ORIGIN,
          'Content-Type': 'application/json',
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const json = async (response: Response, status: number) => {
      assert.equal(response.status, status, await response.clone().text());
      return response.json();
    };
    const token = (email: string, purpose: string) => {
      const item = sent.filter((x) => x.email === email && x.purpose === purpose).at(-1);
      assert(item);
      return item.token;
    };
    try {
      const [role] = await deps.db.$queryRaw<
        { rolsuper: boolean; rolbypassrls: boolean; rolname: string }[]
      >`SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
      assert.equal(role?.rolname, 'melissa_runtime');
      assert.equal(role.rolsuper, false);
      assert.equal(role.rolbypassrls, false);
      const tables = await deps.db.$queryRaw<
        { relrowsecurity: boolean; relforcerowsecurity: boolean; owner: boolean }[]
      >`SELECT relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner)=current_user AS owner FROM pg_class WHERE relname IN ('tenants','memberships','invitations','audit_events')`;
      assert.equal(tables.length, 4);
      for (const table of tables) {
        assert(table.relrowsecurity);
        assert(table.relforcerowsecurity);
        assert(!table.owner);
      }
      for (const email of [emailA, emailB, emailC]) {
        assert.equal(
          (await call('POST', '/auth/register', { email, password, name: 'Test User' })).status,
          202,
        );
        assert.equal((await call('POST', '/auth/login', { email, password })).status, 401);
        const verification = token(email, 'verify');
        assert.equal((await call('POST', '/auth/verify', { token: verification })).status, 204);
        assert.equal((await call('POST', '/auth/verify', { token: verification })).status, 400);
      }
      assert.equal(
        (await call('POST', '/auth/register', { email: emailA, password, name: 'Duplicate' }))
          .status,
        202,
      );
      const loginA = await call('POST', '/auth/login', { email: emailA, password });
      const cookieA = loginA.headers.get('set-cookie')!.split(';')[0]!;
      assert(loginA.headers.get('set-cookie')!.includes('HttpOnly'));
      const a = (await json(loginA, 200)) as { access_token: string; csrf_token: string };
      const b = (await json(
        await call('POST', '/auth/login', { email: emailB, password }),
        200,
      )) as { access_token: string };
      const c = (await json(
        await call('POST', '/auth/login', { email: emailC, password }),
        200,
      )) as { access_token: string };
      assert.equal(
        (await call('POST', '/auth/refresh', undefined, undefined, { Cookie: cookieA })).status,
        403,
      );
      assert.equal(
        (
          await call('GET', '/auth/csrf', undefined, undefined, {
            Cookie: cookieA,
            Origin: 'https://evil.example',
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await call('POST', '/auth/login', { email: emailA, password }, undefined, {
            Origin: 'https://evil.example',
          })
        ).status,
        403,
      );
      const ta = (await json(
        await call(
          'POST',
          '/tenants',
          { name: 'A', countryCode: 'PT', timezone: 'Europe/Lisbon' },
          a.access_token,
        ),
        201,
      )) as { id: string };
      const tb = (await json(
        await call(
          'POST',
          '/tenants',
          { name: 'B', countryCode: 'BR', timezone: 'America/Sao_Paulo' },
          b.access_token,
        ),
        201,
      )) as { id: string };
      assert.equal((await call('GET', `/tenants/${tb.id}`, undefined, a.access_token)).status, 404);
      assert.equal(
        (
          await call(
            'PATCH',
            `/tenants/${tb.id}`,
            { name: 'Hijacked', countryCode: 'PT', timezone: 'UTC' },
            a.access_token,
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await call('GET', `/tenants/${ta.id}`, undefined, a.access_token, {
            'X-Tenant-Id': tb.id,
          })
        ).status,
        403,
      );
      assert.equal((await call('GET', '/tenants')).status, 401);
      assert.equal(
        (
          await call(
            'POST',
            '/tenants',
            { name: 'X', countryCode: 'PT', timezone: 'UTC', tenantId: tb.id },
            a.access_token,
          )
        ).status,
        400,
      );
      const listed = (await json(
        await call('GET', '/tenants', undefined, a.access_token),
        200,
      )) as { tenant: { id: string } }[];
      assert.deepEqual(
        listed.map((x) => x.tenant.id),
        [ta.id],
      );
      assert.equal((await deps.db.tenant.findMany()).length, 0);
      assert.equal((await deps.db.membership.findMany()).length, 0);
      await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id',${ta.id},true)`;
        assert.deepEqual(
          (await tx.tenant.findMany()).map((t) => t.id),
          [ta.id],
        );
        assert.equal(
          (await tx.tenant.updateMany({ where: { id: tb.id }, data: { name: 'Wrong' } })).count,
          0,
        );
        await assert.rejects(
          tx.membership.create({ data: { tenantId: tb.id, userId: randomUUID(), role: 'owner' } }),
        );
      });
      assert.equal(
        (await deps.db.tenant.findMany()).length,
        0,
        'transaction context must not leak to pool',
      );
      const ma = (await json(
        await call('GET', `/tenants/${ta.id}/memberships`, undefined, a.access_token),
        200,
      )) as { id: string }[];
      assert.equal(
        (
          await call(
            'PATCH',
            `/tenants/${ta.id}/memberships/${ma[0]!.id}`,
            { role: 'viewer', active: false },
            a.access_token,
          )
        ).status,
        403,
        'last owner cannot be removed',
      );
      assert.equal(
        (
          await call(
            'PATCH',
            `/tenants/${tb.id}/memberships/${ma[0]!.id}`,
            { role: 'viewer', active: false },
            b.access_token,
          )
        ).status,
        404,
      );
      await json(
        await call(
          'POST',
          `/tenants/${ta.id}/invitations`,
          { email: emailC, role: 'viewer' },
          a.access_token,
        ),
        201,
      );
      const invitation = token(emailC, 'invite');
      assert.equal(
        (
          await call(
            'POST',
            `/tenants/${ta.id}/invitations/accept`,
            { token: invitation },
            b.access_token,
          )
        ).status,
        404,
        'email must match',
      );
      const member = (await json(
        await call(
          'POST',
          `/tenants/${ta.id}/invitations/accept`,
          { token: invitation },
          c.access_token,
        ),
        201,
      )) as { id: string };
      assert.equal(
        (
          await call(
            'POST',
            `/tenants/${ta.id}/invitations/accept`,
            { token: invitation },
            c.access_token,
          )
        ).status,
        404,
      );
      assert.equal((await call('GET', `/tenants/${ta.id}`, undefined, c.access_token)).status, 200);
      assert.equal(
        (
          await call(
            'PATCH',
            `/tenants/${ta.id}`,
            { name: 'Wrong', countryCode: 'PT', timezone: 'UTC' },
            c.access_token,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await call(
            'POST',
            `/tenants/${ta.id}/invitations`,
            { email: emailB, role: 'owner' },
            a.access_token,
          )
        ).status,
        403,
      );
      assert.equal(
        (
          await call(
            'PATCH',
            `/tenants/${ta.id}/memberships/${member.id}`,
            { role: 'viewer', active: false },
            a.access_token,
          )
        ).status,
        200,
      );
      assert.equal(
        (await call('GET', `/tenants/${ta.id}`, undefined, c.access_token)).status,
        404,
        'membership revocation applies to existing JWT',
      );
      const refreshed = await call('POST', '/auth/refresh', undefined, undefined, {
        Cookie: cookieA,
        'X-CSRF-Token': a.csrf_token,
      });
      const next = (await json(refreshed, 200)) as { access_token: string };
      assert.equal(
        (
          await call('POST', '/auth/refresh', undefined, undefined, {
            Cookie: cookieA,
            'X-CSRF-Token': a.csrf_token,
          })
        ).status,
        401,
      );
      assert.equal(
        (await call('GET', '/auth/me', undefined, next.access_token)).status,
        401,
        'replay revocation must commit',
      );
      assert.equal((await call('POST', '/auth/forgot-password', { email: emailB })).status, 202);
      const reset = token(emailB, 'reset');
      assert.equal(
        (
          await call('POST', '/auth/reset-password', {
            token: reset,
            password: 'New-integration-password!',
          })
        ).status,
        204,
      );
      assert.equal((await call('GET', '/auth/me', undefined, b.access_token)).status, 401);
      assert.equal(
        (await call('POST', '/auth/reset-password', { token: reset, password })).status,
        400,
      );
      const fresh = (await json(
        await call('POST', '/auth/login', { email: emailB, password: 'New-integration-password!' }),
        200,
      )) as { access_token: string };
      assert.equal((await call('POST', '/auth/logout', undefined, fresh.access_token)).status, 204);
      assert.equal((await call('GET', '/auth/me', undefined, fresh.access_token)).status, 401);
      const stored = await deps.db.user.findUniqueOrThrow({ where: { email: emailA } });
      assert(stored.passwordHash.startsWith('$argon2id$'));
      assert(!stored.passwordHash.includes(password));
    } finally {
      await app.close();
    }
  },
);
