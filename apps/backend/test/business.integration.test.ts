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
import { Queue } from 'bullmq';
import { queueConnection } from '../src/queue-connection';
import { setTimeout as delay } from 'node:timers/promises';
import { InboundProcessor } from '../src/messaging/inbound-processor';
import { testWhatsAppRouting } from './whatsapp-routing.integration';
import { testQuarantineOperations } from './quarantine-operations.integration';
import { testProcessing } from './processing.integration';
import { testOutboundIntents } from './outbound-intents.integration';
import { testOutboundAcceptance } from './outbound-acceptance.integration';
import { assertOutboundOpenApi } from './outbound-http.integration';
import { TenantService } from '../src/tenancy/tenant.service';
import { waitReady } from './wait-ready';
import { createOpenApi } from '../src/openapi';
import { assertQuarantineOpenApi } from './quarantine-openapi';

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
      await waitReady(base);
      assertQuarantineOpenApi(createOpenApi(app));
      assertOutboundOpenApi(createOpenApi(app));
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
      // Customer security regression: use real HTTP, runtime role and PostgreSQL RLS.
      const customersA = `/tenants/${tenantA.id}/customers`;
      const channelsA = `/tenants/${tenantA.id}/channels`;
      const channelsB = `/tenants/${tenantB.id}/channels`;
      assert.equal((await call('GET', channelsA)).status, 401);
      assert.equal((await call('GET', channelsA, undefined, actorB.access_token)).status, 404);
      assert.equal(
        (
          await call(
            'POST',
            `${channelsA}/mock`,
            { displayName: 'Test', externalPhoneId: 'stolen-number' },
            actorA.access_token,
          )
        ).status,
        400,
      );
      assert.equal(
        (await call('POST', `${channelsA}/mock`, { displayName: '   ' }, actorA.access_token))
          .status,
        400,
      );
      const channel = await data<{ id: string; mode: string; status: string }>(
        await call(
          'POST',
          `${channelsA}/mock`,
          { displayName: 'Test channel' },
          actorA.access_token,
        ),
        201,
      );
      assert.equal(channel.mode, 'mock');
      assert.equal(channel.status, 'active');
      assert.equal('credentialsReference' in channel, false);
      assert.equal('externalPhoneId' in channel, false);
      assert.equal('metadata' in channel, false);
      assert.equal(
        (await call('POST', `${channelsB}/${channel.id}/disconnect`, {}, actorB.access_token))
          .status,
        404,
      );
      const disconnects = await Promise.all(
        [1, 2].map(() =>
          call('POST', `${channelsA}/${channel.id}/disconnect`, {}, actorA.access_token),
        ),
      );
      for (const response of disconnects) {
        const revoked = await data<{ status: string; disconnectedAt: string }>(response, 200);
        assert.equal(revoked.status, 'disconnected');
        assert(revoked.disconnectedAt);
      }
      assert.equal((await deps.db.channelConnection.findMany()).length, 0);
      await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenantA.id},true)`;
        assert.equal(
          (await tx.channelConnection.findMany({ where: { tenantId: tenantB.id } })).length,
          0,
        );
        const stored = await tx.channelConnection.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: tenantA.id, id: channel.id } },
        });
        assert.equal(stored.externalPhoneId, `mock:${channel.id}`);
        assert.equal(stored.credentialsReference, null);
        assert.equal(
          await tx.auditEvent.count({
            where: { targetId: channel.id, action: 'channel.disconnected' },
          }),
          1,
        );
      });
      const customersB = `/tenants/${tenantB.id}/customers`;
      const customerInput = {
        displayName: '  Cliente  ',
        phoneE164: '+351912345678',
        language: 'pt',
        email: 'client@example.test',
        notes: 'Private note',
      };
      assert.equal((await call('GET', customersA)).status, 401);
      assert.equal((await call('GET', customersA, undefined, actorB.access_token)).status, 404);
      for (const invalid of [
        { ...customerInput, phoneE164: '912345678' },
        { ...customerInput, displayName: '   ' },
        { ...customerInput, language: 'unknown' },
        { ...customerInput, tenantId: tenantB.id },
      ])
        assert.equal((await call('POST', customersA, invalid, actorA.access_token)).status, 400);
      const attempts = await Promise.all(
        [1, 2].map(() => call('POST', customersA, customerInput, actorA.access_token)),
      );
      assert.deepEqual(attempts.map((r) => r.status).sort(), [201, 409]);
      const customer = await data<{ id: string; displayName: string }>(
        attempts.find((r) => r.status === 201)!,
        201,
      );
      assert.equal(customer.displayName, 'Cliente');
      const inboxChannel = await data<{ id: string }>(
        await call('POST', `${channelsA}/mock`, { displayName: 'Inbox test' }, actorA.access_token),
        201,
      );
      const inboundPath = `${channelsA}/${inboxChannel.id}/mock-inbound`;
      const inbound = {
        customerId: customer.id,
        eventId: randomUUID(),
        text: 'Olá, gostaria de marcar.',
      };
      const deliveries = await Promise.all(
        [1, 2].map(() => call('POST', inboundPath, inbound, actorA.access_token)),
      );
      const received = await Promise.all(
        deliveries.map((r) =>
          data<{
            duplicate: boolean;
            eventId: string;
          }>(r, 202),
        ),
      );
      assert.deepEqual(received.map((r) => r.duplicate).sort(), [false, true]);
      assert.equal(received[0]!.eventId, received[1]!.eventId);
      const waitReceipt = async (id: string, expected: string) => {
        for (let i = 0; i < 100; i++) {
          const receipt = await data<{
            state: string;
            message: { id: string; conversationId: string } | null;
          }>(
            await call(
              'GET',
              `/tenants/${tenantA.id}/message-receipts/${id}`,
              undefined,
              actorA.access_token,
            ),
            200,
          );
          if (receipt.state === expected) return receipt;
          await delay(100);
        }
        throw new Error(`Receipt did not become ${expected}`);
      };
      const completed = await waitReceipt(received[0]!.eventId, 'processed');
      assert(completed.message);
      await Promise.all([1, 2].map(() => new InboundProcessor(deps).process(received[0]!.eventId)));
      assert.equal(
        (
          await call(
            'GET',
            `/tenants/${tenantA.id}/message-receipts/${received[0]!.eventId}`,
            undefined,
            actorB.access_token,
          )
        ).status,
        404,
      );
      assert.equal(
        (await call('POST', inboundPath, { ...inbound, text: 'Changed' }, actorA.access_token))
          .status,
        409,
      );
      assert.equal((await call('POST', inboundPath, inbound, actorB.access_token)).status, 404);
      assert.equal(
        (
          await call(
            'POST',
            inboundPath,
            { ...inbound, eventId: randomUUID(), customerId: randomUUID() },
            actorA.access_token,
          )
        ).status,
        404,
      );
      const conversationId = completed.message.conversationId;
      const messagePath = `/tenants/${tenantA.id}/conversations/${conversationId}/messages`;
      const history = await data<{ items: { contentText: string }[]; next: null }>(
        await call('GET', messagePath, undefined, actorA.access_token),
        200,
      );
      assert.equal(history.items.length, 1);
      assert.equal(history.items[0]!.contentText, inbound.text);
      assert.equal(history.next, null);
      assert.equal((await call('GET', messagePath, undefined, actorB.access_token)).status, 404);
      assert.equal(
        (await call('GET', `${messagePath}?after=${randomUUID()}`, undefined, actorA.access_token))
          .status,
        404,
      );
      const conversationPage = await data<{ items: { mode: string }[] }>(
        await call('GET', `/tenants/${tenantA.id}/conversations`, undefined, actorA.access_token),
        200,
      );
      assert.equal(conversationPage.items[0]!.mode, 'AI_PAUSED');
      const searchPath = `/tenants/${tenantA.id}/conversations`;
      for (const q of ['  cLiEnTe  ', 'INBOX TEST', '']) {
        const found = await data<{ items: { id: string }[] }>(
          await call(
            'GET',
            `${searchPath}?q=${encodeURIComponent(q)}`,
            undefined,
            actorA.access_token,
          ),
          200,
        );
        assert.equal(found.items.length, 1);
        assert.equal(found.items[0]!.id, conversationId);
      }
      for (const q of ['nonexistent-name', 'gostaria', '%', '_', '\\']) {
        const found = await data<{ items: unknown[] }>(
          await call(
            'GET',
            `${searchPath}?q=${encodeURIComponent(q)}`,
            undefined,
            actorA.access_token,
          ),
          200,
        );
        assert.equal(found.items.length, 0, 'Only literal customer/channel names are searched');
      }
      assert.equal(
        (await call('GET', `${searchPath}?q=${'x'.repeat(81)}`, undefined, actorA.access_token))
          .status,
        400,
      );
      assert.equal(
        (await call('GET', `${searchPath}?q=a&q=b`, undefined, actorA.access_token)).status,
        400,
      );
      assert.equal(
        (await call('GET', `${searchPath}?q=Cliente`, undefined, actorB.access_token)).status,
        404,
      );
      const afterMatch = await data<{ items: unknown[] }>(
        await call(
          'GET',
          `${searchPath}?q=Cliente&after=${conversationId}`,
          undefined,
          actorA.access_token,
        ),
        200,
      );
      assert.equal(afterMatch.items.length, 0);
      assert.equal((await deps.db.message.findMany()).length, 0);
      assert.equal((await deps.db.externalEvent.findMany()).length, 0);
      assert.equal((await deps.db.conversation.findMany()).length, 0);
      await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenantA.id},true)`;
        assert.equal(await tx.externalEvent.count(), 1);
        assert.equal(
          await tx.auditEvent.count({ where: { action: 'message.duplicate_payload_conflict' } }),
          1,
        );
      });
      const testQueue = new Queue('incoming-messages', {
        connection: queueConnection(config.REDIS_URL),
      });
      let rejectedId = '';
      let recoveryId = '';
      let secondRecoveryId = '';
      try {
        await testQueue.pause();
        const pending = await data<{ eventId: string }>(
          await call(
            'POST',
            inboundPath,
            { ...inbound, eventId: randomUUID() },
            actorA.access_token,
          ),
          202,
        );
        rejectedId = pending.eventId;
        const pendingReceipt = await waitReceipt(rejectedId, 'pending');
        assert.equal(pendingReceipt.message, null);
        assert.equal(
          (await deps.db.inboundOutbox.findMany()).length,
          0,
          'Outbox payload requires tenant context',
        );
        const recoveryChannel = await data<{ id: string }>(
          await call('POST', `${channelsA}/mock`, { displayName: 'Recovery' }, actorA.access_token),
          201,
        );
        const recovery = await data<{ eventId: string }>(
          await call(
            'POST',
            `${channelsA}/${recoveryChannel.id}/mock-inbound`,
            { ...inbound, eventId: randomUUID() },
            actorA.access_token,
          ),
          202,
        );
        recoveryId = recovery.eventId;
        const secondRecovery = await data<{ eventId: string }>(
          await call(
            'POST',
            `${channelsA}/${recoveryChannel.id}/mock-inbound`,
            { ...inbound, eventId: randomUUID(), text: 'Mais uma mensagem' },
            actorA.access_token,
          ),
          202,
        );
        secondRecoveryId = secondRecovery.eventId;
        await deps.db.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenantA.id},true)`;
          const first = await tx.inboundOutbox.findUniqueOrThrow({
            where: { tenantId_id: { tenantId: tenantA.id, id: recoveryId } },
          });
          const second = await tx.inboundOutbox.findUniqueOrThrow({
            where: { tenantId_id: { tenantId: tenantA.id, id: secondRecoveryId } },
          });
          assert(first.batchId);
          assert.equal(first.batchId, second.batchId);
          const other = await tx.inboundOutbox.findUniqueOrThrow({
            where: { tenantId_id: { tenantId: tenantA.id, id: rejectedId } },
          });
          assert.notEqual(first.batchId, other.batchId);
          const batch = await tx.inboundBatch.findUniqueOrThrow({
            where: { tenantId_id: { tenantId: tenantA.id, id: first.batchId } },
          });
          assert.equal(batch.sealedAt, null);
          assert(batch.dueAt.getTime() <= batch.createdAt.getTime() + 5000);
        });
        const exhausted = await data<{ eventId: string }>(
          await call(
            'POST',
            `${channelsA}/${recoveryChannel.id}/mock-inbound`,
            { ...inbound, eventId: randomUUID() },
            actorA.access_token,
          ),
          202,
        );
        for (let attempt = 0; attempt < 5; attempt++)
          await new InboundProcessor(deps).recordFailure(exhausted.eventId);
        assert.equal((await waitReceipt(exhausted.eventId, 'failed')).message, null);
        await call('POST', `${channelsA}/${inboxChannel.id}/disconnect`, {}, actorA.access_token);
      } finally {
        await testQueue.resume();
        await testQueue.close();
      }
      assert.equal((await waitReceipt(rejectedId, 'rejected')).message, null);
      assert((await waitReceipt(recoveryId, 'processed')).message);
      assert((await waitReceipt(secondRecoveryId, 'processed')).message);
      await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenantA.id},true)`;
        const messages = await tx.message.findMany({
          where: { externalEventId: { in: [recoveryId, secondRecoveryId] } },
        });
        assert.equal(messages.length, 2);
        assert(messages[0]!.batchId);
        assert.equal(messages[0]!.batchId, messages[1]!.batchId);
        const sealed = await tx.inboundBatch.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: tenantA.id, id: messages[0]!.batchId! } },
        });
        assert(sealed.sealedAt);
        assert.equal(
          (
            await tx.inboundOutbox.findUniqueOrThrow({
              where: { tenantId_id: { tenantId: tenantA.id, id: recoveryId } },
            })
          ).contentText,
          null,
        );
        assert.equal(
          (
            await tx.inboundOutbox.findUniqueOrThrow({
              where: { tenantId_id: { tenantId: tenantA.id, id: rejectedId } },
            })
          ).contentText,
          null,
        );
      });
      assert.equal(
        (
          await call(
            'POST',
            inboundPath,
            { ...inbound, eventId: randomUUID() },
            actorA.access_token,
          )
        ).status,
        404,
      );
      await data(await call('POST', customersB, customerInput, actorB.access_token), 201);
      assert.equal(
        (await call('PUT', `${customersB}/${customer.id}`, customerInput, actorB.access_token))
          .status,
        404,
      );
      assert.equal(
        (await call('DELETE', `${customersB}/${customer.id}`, undefined, actorB.access_token))
          .status,
        404,
      );
      assert.equal((await deps.db.customer.findMany()).length, 0, 'Customer RLS without context');
      await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenantA.id},true)`;
        assert.equal((await tx.customer.findMany({ where: { tenantId: tenantB.id } })).length, 0);
        // Generate a second page without burdening HTTP with 50 fixture requests.
        await tx.customer.createMany({
          data: Array.from({ length: 50 }, (_, i) => ({
            tenantId: tenantA.id,
            displayName: `Page ${i}`,
            phoneE164: `+35193000${String(i).padStart(4, '0')}`,
          })),
        });
      });
      const firstPage = await data<{ items: { id: string }[]; next: string }>(
        await call('GET', customersA, undefined, actorA.access_token),
        200,
      );
      assert.equal(firstPage.items.length, 50);
      assert(firstPage.next);
      const secondPage = await data<{ items: { id: string }[]; next: null }>(
        await call('GET', `${customersA}?after=${firstPage.next}`, undefined, actorA.access_token),
        200,
      );
      assert.equal(secondPage.items.length, 1);
      assert.equal(secondPage.next, null);
      assert.equal(
        new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size,
        51,
      );
      assert.equal(
        (await call('GET', `${customersA}?after=invalid`, undefined, actorA.access_token)).status,
        400,
      );
      const updatedCustomer = await data<{ email: null; notes: null }>(
        await call(
          'PUT',
          `${customersA}/${customer.id}`,
          { displayName: 'Updated', phoneE164: customerInput.phoneE164, language: 'en' },
          actorA.access_token,
        ),
        200,
      );
      assert.equal(updatedCustomer.email, null);
      assert.equal(updatedCustomer.notes, null);
      assert.equal(
        (await call('DELETE', `${customersA}/${customer.id}`, undefined, actorA.access_token))
          .status,
        204,
      );
      assert.equal(
        (await call('DELETE', `${customersA}/${customer.id}`, undefined, actorA.access_token))
          .status,
        404,
      );
      assert.equal(
        (await call('PUT', `${customersA}/${customer.id}`, customerInput, actorA.access_token))
          .status,
        404,
      );
      assert.equal(
        (await call('POST', customersA, customerInput, actorA.access_token)).status,
        409,
      );
      await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenantA.id},true)`;
        const events = await tx.auditEvent.findMany({ where: { targetId: customer.id } });
        assert.deepEqual(events.map((e) => e.action).sort(), [
          'customer.archived',
          'customer.created',
          'customer.updated',
        ]);
      });
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
      await testWhatsAppRouting(deps.db, tenantA.id, tenantB.id);
      await testQuarantineOperations(
        tenantA.id,
        tenantB.id,
        actorA.access_token,
        actorB.access_token,
        (path, token) => call('GET', path, undefined, token),
      );
      await testOutboundIntents(tenantA.id, tenantB.id);
      await testOutboundAcceptance(app.get(TenantService), tenantA.id, tenantB.id, {
        call,
        ownerToken: actorA.access_token,
        otherToken: actorB.access_token,
      });
      await testProcessing(
        tenantA.id,
        tenantB.id,
        actorA.access_token,
        actorB.access_token,
        (path, token) => call('GET', path, undefined, token),
      );
    } finally {
      await app.close();
    }
  },
);
