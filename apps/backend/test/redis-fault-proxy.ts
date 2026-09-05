import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection, createServer, Socket } from 'node:net';

// Test-only loopback transport. Never reads/logs RESP, credentials or message data.
export async function redisFaultProxy(redisUrl: string) {
  assert.equal(process.env.NODE_ENV, 'test');
  const target = new URL(redisUrl);
  assert.equal(target.protocol, 'redis:');
  assert(['127.0.0.1', 'localhost'].includes(target.hostname), 'Disposable local Redis only');
  let blocked = false;
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  };
  const server = createServer((client) => {
    if (blocked) {
      client.destroy();
      return;
    }
    const upstream = createConnection({ host: target.hostname, port: Number(target.port || 6379) });
    track(client);
    track(upstream);
    const closePair = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', closePair);
    upstream.on('error', closePair);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const proxied = new URL(redisUrl);
  proxied.hostname = '127.0.0.1';
  proxied.port = String(address.port);
  return {
    url: proxied.toString(),
    cut() {
      blocked = true;
      for (const socket of sockets) socket.destroy();
    },
    restore() {
      blocked = false;
    },
    async close() {
      blocked = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
