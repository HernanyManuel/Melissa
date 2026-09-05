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
import { redisFaultProxy } from './redis-fault-proxy';

// Dedicated disposable CI database/Redis only. Never signal an external PID.
test(
  'accepted inbound survives worker restart and Redis transport outage without duplicates',
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
    let proxy: Awaited<ReturnType<typeof redisFaultProxy>> | undefined;
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
        env: { ...process.env, WORKER_PORT: '3002', REDIS_URL: proxy!.url },
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
      proxy = await redisFaultProxy(config.REDIS_URL);
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

      // Cut established TCP sockets and reject reconnects only for this worker.
      const activeWorker = (() => {
        assert(child?.pid);
        return child;
      })();
      proxy.cut();
      const health = await fetch('http://127.0.0.1:3002/health/ready', {
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(health.status, 503);
      assert.equal(
        (
          await fetch('http://127.0.0.1:3002/health/live', {
            signal: AbortSignal.timeout(5000),
          })
        ).status,
        200,
      );
      const outageInput = {
        ...input,
        eventId: randomUUID(),
        text: 'Synthetic Redis outage payload',
      };
      const queued = await request<{ eventId: string }>('POST', inboundPath, 202, outageInput);
      const outageReceiptPath = `${tenantPath}/message-receipts/${queued.eventId}`;
      await delay(3500); // Several dispatch opportunities, beyond queue command timeout.
      assert.equal(
        (await request<{ state: string }>('GET', outageReceiptPath, 200)).state,
        'pending',
      );
      await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenant.id},true)`;
        const payload = await tx.inboundOutbox.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: tenant.id, id: queued.eventId } },
        });
        assert.equal(payload.contentText, outageInput.text);
        assert.equal(await tx.message.count({ where: { externalEventId: queued.eventId } }), 0);
      });
      proxy.restore();
      await waitReady('http://127.0.0.1:3002');
      let recoveredId: string | undefined;
      for (let attempt = 0; attempt < 150; attempt++) {
        const receipt = await request<{ state: string; message: { id: string } | null }>(
          'GET',
          outageReceiptPath,
          200,
        );
        if (receipt.state === 'processed') {
          recoveredId = receipt.message?.id;
          break;
        }
        await delay(100);
      }
      assert(recoveredId, 'Transport recovery must resume dispatch without restarting the worker');
      assert.equal(child, activeWorker);
      assert.equal(activeWorker.exitCode, null);
      assert.equal(activeWorker.signalCode, null);
      assert.equal(
        (await request<{ duplicate: boolean }>('POST', inboundPath, 202, outageInput)).duplicate,
        true,
      );
      await deps.db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id',${tenant.id},true)`;
        assert.equal(await tx.message.count({ where: { externalEventId: queued.eventId } }), 1);
        assert.equal(
          await tx.auditEvent.count({
            where: { targetId: recoveredId, action: 'message.mock_received' },
          }),
          1,
        );
        const payload = await tx.inboundOutbox.findUniqueOrThrow({
          where: { tenantId_id: { tenantId: tenant.id, id: queued.eventId } },
        });
        assert.equal(payload.contentText, null);
      });
    } finally {
      try {
        await stop();
      } finally {
        try {
          await proxy?.close();
        } finally {
          await app.close();
        }
      }
    }
  },
);
