import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function replica(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'nexashare-replica-'));
  t.after(async () => {
    assert.match(relative(tmpdir(), directory), /^nexashare-replica-[^\\/]+$/);
    await rm(directory, { recursive: true, force: true });
  });
  const entrypoint = join(directory, 'app.cjs');
  await copyFile(new URL('../dist/app.cjs', import.meta.url), entrypoint);
  const environment = {
    NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'production',
    UPSTASH_REDIS_REST_URL: undefined, UPSTASH_REDIS_REST_TOKEN: undefined,
    KV_REST_API_URL: undefined, KV_REST_API_TOKEN: undefined,
    ROOM_JOIN_TTL_SECONDS: '300', ROOM_PENDING_TTL_SECONDS: '300', ROOM_CONNECTED_TTL_SECONDS: '7200',
    ...config,
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  let module;
  try {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    module = createRequire(import.meta.url)(entrypoint);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return { ...module, base: await listen(t, createServer(module.default)) };
}

// Local Redis REST emulator: independent API replicas share only this server.
async function redis(t) {
  const entries = new Map();
  const control = { fail: false };
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (control.fail || req.headers.authorization !== 'Bearer test-write-token') {
      res.writeHead(401).end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const [command, key, ...args] = JSON.parse(body);
    let entry = entries.get(key);
    if (entry && entry.expiresAt <= Date.now()) {
      entries.delete(key);
      entry = undefined;
    }
    let result;
    switch (command) {
      case 'GET': result = entry?.value ?? null; break;
      case 'SET':
        entries.set(key, { value: args[0], expiresAt: Date.now() + Number(args[2]) * 1000 });
        result = 'OK'; break;
      case 'EXISTS': result = entry ? 1 : 0; break;
      case 'DEL': result = entries.delete(key) ? 1 : 0; break;
      case 'INCR':
        result = Number(entry?.value ?? 0) + 1;
        entries.set(key, { value: String(result), expiresAt: entry?.expiresAt ?? Infinity });
        break;
      case 'EXPIRE':
        if (entry) entry.expiresAt = Date.now() + Number(args[0]) * 1000;
        result = entry ? 1 : 0; break;
      case 'RPUSH':
        entry ??= { value: [], expiresAt: Infinity };
        entry.value.push(args[0]);
        entries.set(key, entry);
        result = entry.value.length; break;
      case 'LRANGE': result = entry?.value ?? []; break;
      default: throw new Error(`Unexpected Redis command: ${command}`);
    }
    res.end(JSON.stringify({ result }));
  });
  const url = await listen(t, server);
  return { entries, control, config: { UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: 'test-write-token' } };
}

async function request(base, path, { token, body, method = body ? 'POST' : 'GET' } = {}) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, data: await response.json() };
}

async function session(base) {
  const result = await request(base, '/sessions', { method: 'POST' });
  assert.equal(result.status, 201);
  return result.data.token;
}

test('Vercel requires shared state before creating a session; liveness remains available', async (t) => {
  for (const config of [{}, { UPSTASH_REDIS_REST_URL: 'https://example.com', KV_REST_API_TOKEN: 'test-write-token' }]) {
    const api = await replica(t, config);
    assert.equal((await request(api.base, '/health/live')).status, 200);
    assert.equal((await request(api.base, '/health/ready')).status, 503);
    const result = await request(api.base, '/sessions', { method: 'POST' });
    assert.equal(result.status, 503);
    assert.equal(result.data.error.code, 'STATE_STORE_NOT_CONFIGURED');
  }
});

test('two Vercel replicas preserve sessions and approve after 120 seconds', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const shared = await redis(t);
  const hostApi = await replica(t, shared.config);
  const guestApi = await replica(t, shared.config);
  const host = await session(hostApi.base);
  const guest = await session(guestApi.base);
  const room = await request(hostApi.base, '/rooms', { token: host, body: { deviceLabel: 'Host' } });
  assert.equal(room.status, 201);
  assert.equal(Date.parse(room.data.expiresAt) - room.data.serverTime, 300_000);
  now += 20_000;
  assert.equal((await request(guestApi.base, `/rooms/${room.data.roomId}`, { token: host })).status, 200);
  const joined = await request(guestApi.base, '/rooms/join', { token: guest, body: { code: room.data.code, deviceLabel: 'Guest' } });
  assert.equal(joined.status, 202);
  assert.equal(joined.data.expiresAt, room.data.expiresAt);
  now += 120_000;
  const inbox = await request(hostApi.base, `/signal/poll?roomId=${room.data.roomId}`, { token: host });
  assert.equal(inbox.status, 200);
  assert.equal(inbox.data.signals[0].payload.expiresAt, joined.data.expiresAt);
  const approved = await request(hostApi.base, `/rooms/${room.data.roomId}/requests/${joined.data.requestId}/approve`, { token: host, method: 'POST' });
  assert.equal(approved.status, 200);
  assert.equal((await request(guestApi.base, '/ice-servers', { token: guest })).status, 200);
  now += 301_000;
  assert.equal((await request(hostApi.base, `/rooms/${room.data.roomId}`, { token: guest })).status, 200);
});

test('late join is capped by room deadline, without expiring the device session', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const shared = await redis(t);
  const api = await replica(t, shared.config);
  const host = await session(api.base);
  const guest = await session(api.base);
  const room = await request(api.base, '/rooms', { token: host, body: { deviceLabel: 'Host' } });
  now += 250_000;
  const joined = await request(api.base, '/rooms/join', { token: guest, body: { code: room.data.code, deviceLabel: 'Guest' } });
  assert.equal(joined.data.expiresInSeconds, 50);
  assert.equal(joined.data.expiresAt, room.data.expiresAt);
  now += 51_000;
  assert.equal((await request(api.base, `/rooms/${room.data.roomId}/requests/${joined.data.requestId}/approve`, { token: host, method: 'POST' })).status, 409);
  assert.equal((await request(api.base, `/rooms/${room.data.roomId}`, { token: host })).status, 404);
  assert.equal((await request(api.base, '/rooms', { token: host, body: { deviceLabel: 'New host room' } })).status, 201);
});

test('an explicitly shorter approval deadline is reported while the room remains valid', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const shared = await redis(t);
  const api = await replica(t, { ...shared.config, ROOM_PENDING_TTL_SECONDS: '60' });
  const host = await session(api.base);
  const guest = await session(api.base);
  const room = await request(api.base, '/rooms', { token: host, body: { deviceLabel: 'Host' } });
  const joined = await request(api.base, '/rooms/join', { token: guest, body: { code: room.data.code, deviceLabel: 'Guest' } });
  assert.equal(joined.data.expiresInSeconds, 60);
  now += 61_000;
  assert.equal((await request(api.base, `/rooms/${room.data.roomId}`, { token: host })).status, 200);
  assert.equal((await request(api.base, `/rooms/${room.data.roomId}/requests/${joined.data.requestId}/approve`, { token: host, method: 'POST' })).status, 409);
});

test('Redis errors and missing records never revive sessions from instance memory', async (t) => {
  const shared = await redis(t);
  const api = await replica(t, shared.config);
  const token = await session(api.base);
  shared.control.fail = true;
  const unavailable = await request(api.base, '/rooms', { token, body: { deviceLabel: 'Host' } });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.data.error.code, 'STATE_STORE_UNAVAILABLE');
  assert.equal((await request(api.base, '/sessions', { method: 'POST' })).status, 503);
  shared.control.fail = false;
  shared.entries.clear();
  assert.equal((await request(api.base, '/rooms', { token, body: { deviceLabel: 'Host' } })).status, 401);
});
