import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { CONFIG, Configuration } from '../src/config';
import { configureHttp } from '../src/http';
import { IdentityMail } from '../src/identity/mail';
import { Dependencies } from '../src/dependencies';
import { waitReady } from './wait-ready';

// Dedicated disposable CI database/Redis only. Never signal an external PID.
test(
  'accepted inbound survives abrupt worker death and repeated restart without duplicates',
  { timeout: 60000 },
  async () => {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.equal(process.env.RUN_WORKER_RESTART_TEST, 'true');
    const app = await NestFactory.create(AppModule, { logger: false });
    const config = app.get<Configuration>(CONFIG);
    const deps = app.get(Dependencies);
    let verification = '';
    app.get(IdentityMail).send = async (_email, purpose, token) => {
      if (purpose === 'verify') verification = token;
    };
    configureHttp(app, config, false);
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    let bearer = '';
    let child: ChildProcess | undefined;
    const stop = async () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      assert(child.kill('SIGKILL'));
      const [, signal] = await exited;
      assert.equal(signal, 'SIGKILL');
      child = undefined;
    };
    const start = async () => {
      assert(!child);
      child = spawn(process.execPath, [join(__dirname, '../src/worker.js')], {
        env: { ...process.env, WORKER_PORT: '3002' },
        stdio: 'ignore',
      });
      await once(child, 'spawn');
      for (let attempt = 0; attempt < 100; attempt++) {
        assert.equal(child.exitCode, null, 'Owned worker exited before readiness');
        try {
          const response = await fetch('http://127.0.0.1:3002/health/ready', {
            signal: AbortSignal.timeout(500),
          });
          if (response.ok) return;
        } catch {
          /* Connection refusal is expected during startup. */
        }
        await delay(100);
      }
      throw new Error('Owned worker did not become ready');
    };
    const request = async <T>(
      method: string,
      path: string,
      status: number,
      body?: object,
    ): Promise<T> => {
      const response = await fetch(base + '/api/v1' + path, {
        method,
        headers: {
          Origin: config.CORS_ORIGIN,
          'Content-Type': 'application/json',
          ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(response.status, status);
      return (status === 204 ? undefined : await response.json()) as T;
    };
    try {
      await waitReady(base);
      const email = `restart-${randomUUID()}@example.test`;
      const password = 'Worker-restart-test-123!';
      await request('POST', '/auth/register', 202, {
        email,
        password,
        name: 'Restart test',
        termsAccepted: true,
      });
      await request('POST', '/auth/verify', 204, { token: verification });
      bearer = (
        await request<{ access_token: string }>('POST', '/auth/login', 200, { email, password })
      ).access_token;
      const tenant = await request<{ id: string }>('POST', '/tenants', 201, {
        name: 'Restart fixture',
        countryCode: 'PT',
        timezone: 'Europe/Lisbon',
      });
      const tenantPath = `/tenants/${tenant.id}`;
      const customer = await request<{ id: string }>('POST', `${tenantPath}/customers`, 201, {
        displayName: 'Synthetic customer',
        phoneE164: '+351912345678',
        language: 'pt',
      });
      const channel = await request<{ id: string }>('POST', `${tenantPath}/channels/mock`, 201, {
        displayName: 'Restart fixture',
      });
      const inboundPath = `${tenantPath}/channels/${channel.id}/mock-inbound`;
      const input = {
        customerId: customer.id,
        eventId: randomUUID(),
        text: 'Synthetic durable payload',
      };
      await start();
      await stop(); // Real SIGKILL, not Queue.pause() or an in-process mock.
      const accepted = await request<{ eventId: string; duplicate: boolean }>(
        'POST',
        inboundPath,
        202,
        input,
      );
      assert.equal(accepted.duplicate, false);
      const receiptPath = `${tenantPath}/message-receipts/${accepted.eventId}`;
      await delay(1200); // More than a dispatch cycle: no other consumer may be alive.
      const pending = await request<{ state: string; message: unknown }>('GET', receiptPath, 200);
      assert.equal(pending.state, 'pending');
      assert.equal(pending.message, null);
      await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenant.id},true)`;
        const payload = await tx.inboundOutbox.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: tenant.id, id: accepted.eventId } },
        });
        assert.equal(payload.contentText, input.text);
      });
      await start();
      let messageId: string | undefined;
      for (let attempt = 0; attempt < 150; attempt++) {
        const receipt = await request<{ state: string; message: { id: string } | null }>(
          'GET',
          receiptPath,
          200,
        );
        if (receipt.state === 'processed') {
          messageId = receipt.message?.id;
          break;
        }
        await delay(100);
      }
      assert(messageId, 'Restart must recover the durable PostgreSQL outbox');
      await stop();
      await start();
      const replay = await request<{ eventId: string; duplicate: boolean }>(
        'POST',
        inboundPath,
        202,
        input,
      );
      assert.equal(replay.duplicate, true);
      assert.equal(replay.eventId, accepted.eventId);
      await delay(1200);
      await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenant.id},true)`;
        assert.equal(await tx.message.count({ where: { externalEventId: accepted.eventId } }), 1);
        assert.equal(
          await tx.auditEvent.count({
            where: { targetId: messageId, action: 'message.mock_received' },
          }),
          1,
        );
        const payload = await tx.inboundOutbox.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: tenant.id, id: accepted.eventId } },
        });
        assert.equal(payload.contentText, null);
      });
    } finally {
      await stop();
      await app.close();
    }
  },
);
