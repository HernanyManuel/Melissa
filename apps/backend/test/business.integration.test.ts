import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { CONFIG, Configuration } from '../src/config';
import { configureHttp } from '../src/http';
import { IdentityMail } from '../src/identity/mail';
import { Dependencies } from '../src/dependencies';

test(
  'business onboarding persists validated tenant-scoped configuration',
  { timeout: 60000 },
  async () => {
    const app = await NestFactory.create(AppModule, { logger: false });
    const config = app.get<Configuration>(CONFIG);
    const deps = app.get(Dependencies);
    const tokens = new Map<string, string>();
    app.get(IdentityMail).send = async (email, purpose, token) => {
      if (purpose === 'verify') tokens.set(email, token);
    };
    configureHttp(app, config, false);
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const call = (method: string, path: string, body?: object, bearer?: string) =>
      fetch(base + '/api/v1' + path, {
        method,
        headers: {
          Origin: config.CORS_ORIGIN,
          'Content-Type': 'application/json',
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    const data = async <T>(response: Response, status: number): Promise<T> => {
      assert.equal(response.status, status, await response.clone().text());
      return response.json() as Promise<T>;
    };
    const createActor = async () => {
      const email = `business-${randomUUID()}@example.test`;
      const password = 'Business-integration-123!';
      assert.equal(
        (
          await call('POST', '/auth/register', {
            email,
            password,
            name: 'Owner',
            termsAccepted: true,
          })
        ).status,
        202,
      );
      assert.equal((await call('POST', '/auth/verify', { token: tokens.get(email) })).status, 204);
      return data<{ access_token: string }>(
        await call('POST', '/auth/login', { email, password }),
        200,
      );
    };
    try {
      const [actorA, actorB] = await Promise.all([createActor(), createActor()]);
      const templates = await data<{ key: string }[]>(
        await call('GET', '/industry-templates', undefined, actorA.access_token),
        200,
      );
      assert(templates.some((item) => item.key === 'barbershop'));
      const tenantA = await data<{ id: string }>(
        await call(
          'POST',
          '/tenants',
          { name: 'Barbearia', countryCode: 'PT', timezone: 'Europe/Lisbon' },
          actorA.access_token,
        ),
        201,
      );
      const tenantB = await data<{ id: string }>(
        await call(
          'POST',
          '/tenants',
          { name: 'Other', countryCode: 'PT', timezone: 'Europe/Lisbon' },
          actorB.access_token,
        ),
        201,
      );
      assert.equal(
        (
          await call(
            'PUT',
            `/tenants/${tenantA.id}/profile`,
            {
              name: 'Barbearia Central',
              legalName: 'Central Lda',
              industryKey: 'barbershop',
              countryCode: 'PT',
              city: 'Lisboa',
              timezone: 'Europe/Lisbon',
              locale: 'pt',
              currency: 'EUR',
              website: 'http://unsafe.example',
            },
            actorA.access_token,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await call(
            'PUT',
            `/tenants/${tenantA.id}/profile`,
            {
              name: 'Barbearia Central',
              industryKey: 'barbershop',
              countryCode: 'PT',
              city: 'Lisboa',
              timezone: 'Europe/Lisbon',
              locale: 'pt',
              currency: 'EUR',
            },
            actorA.access_token,
          )
        ).status,
        200,
      );
      const service = await data<{ id: string; price: string }>(
        await call(
          'POST',
          `/tenants/${tenantA.id}/services`,
          {
            name: 'Corte',
            price: '18.00',
            currency: 'EUR',
            durationMinutes: 30,
            bufferBeforeMinutes: 0,
            bufferAfterMinutes: 5,
            bookingEnabled: true,
            active: true,
          },
          actorA.access_token,
        ),
        201,
      );
      assert.equal(String(service.price), '18');
      assert.equal(
        (await call('GET', `/tenants/${tenantA.id}/services`, undefined, actorB.access_token))
          .status,
        404,
      );
      assert.equal(
        (
          await call(
            'PUT',
            `/tenants/${tenantA.id}/business-hours`,
            {
              periods: [
                { weekday: 1, startTime: '09:00', endTime: '13:00', enabled: true },
                { weekday: 1, startTime: '12:00', endTime: '19:00', enabled: true },
              ],
            },
            actorA.access_token,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await call(
            'PUT',
            `/tenants/${tenantA.id}/business-hours`,
            {
              periods: [
                { weekday: 1, startTime: '09:00', endTime: '13:00', enabled: true },
                { weekday: 1, startTime: '14:00', endTime: '19:00', enabled: true },
                { weekday: 6, startTime: '09:00', endTime: '14:00', enabled: true },
              ],
            },
            actorA.access_token,
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await call(
            'POST',
            `/tenants/${tenantA.id}/schedule-exceptions`,
            { date: '2026-12-25', closed: true, reason: 'Holiday' },
            actorA.access_token,
          )
        ).status,
        201,
      );
      assert.equal(
        (
          await call(
            'POST',
            `/tenants/${tenantA.id}/faqs`,
            { question: 'Aceitam cartão?', answer: 'Sim.', active: true },
            actorA.access_token,
          )
        ).status,
        201,
      );
      assert.equal(
        (
          await call(
            'POST',
            `/tenants/${tenantA.id}/staff`,
            {
              name: 'Ana',
              active: true,
              timezone: 'Europe/Lisbon',
              serviceIds: [service.id],
            },
            actorA.access_token,
          )
        ).status,
        201,
      );
      assert.equal(
        (
          await call(
            'POST',
            `/tenants/${tenantB.id}/staff`,
            {
              name: 'Cross tenant',
              active: true,
              timezone: 'Europe/Lisbon',
              serviceIds: [service.id],
            },
            actorB.access_token,
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await call(
            'PUT',
            `/tenants/${tenantA.id}/configuration`,
            {
              cancellation: '24 hours',
              tone: 'friendly',
              useEmojis: false,
              useCustomerName: true,
              replyInCustomerLanguage: true,
              verbosity: 'normal',
            },
            actorA.access_token,
          )
        ).status,
        200,
      );
      const status = await data<{
        completed: Record<string, boolean>;
        activation: { allowed: boolean; blockers: string[] };
      }>(
        await call('GET', `/tenants/${tenantA.id}/onboarding`, undefined, actorA.access_token),
        200,
      );
      assert.deepEqual(status.completed, { business: true, services: true, schedule: true });
      assert.equal(status.activation.allowed, false);
      assert(status.activation.blockers.includes('channel'));
      assert.equal(
        (await deps.db.businessService.findMany()).length,
        0,
        'RLS denies reads without context',
      );
      await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenantA.id},true)`;
        assert.deepEqual(
          (await tx.businessService.findMany()).map((item) => item.id),
          [service.id],
        );
        assert.equal(
          (await tx.businessService.findMany({ where: { tenantId: tenantB.id } })).length,
          0,
        );
      });
    } finally {
      await app.close();
    }
  },
);
