import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';

test('relocated production bundle creates sessions and authenticates room requests', async (t) => {
  // Reproduce the serverless layout without workspace source or node_modules.
  const directory = await mkdtemp(join(tmpdir(), 'nexashare-api-'));
  t.after(async () => {
    const name = relative(tmpdir(), directory);
    assert.match(name, /^nexashare-api-[^\\/]+$/);
    await rm(directory, { recursive: true, force: true });
  });
  const entrypoint = join(directory, 'app.cjs');
  await copyFile(new URL('../dist/app.cjs', import.meta.url), entrypoint);

  process.env.NODE_ENV = 'production';
  for (const key of ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'KV_REST_API_URL', 'KV_REST_API_TOKEN']) {
    delete process.env[key];
  }
  const require = createRequire(import.meta.url);
  const { default: app } = require(entrypoint);
  assert.equal(typeof app, 'function');

  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  for (const prefix of ['/api/v1', '/v1']) {
    const health = await fetch(`${base}${prefix}/health/live`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const created = await fetch(`${base}${prefix}/sessions`, { method: 'POST' });
    assert.equal(created.status, 201);
    const session = await created.json();
    assert.match(session.sessionId, /^[0-9a-f-]{36}$/);
    assert.ok(session.token.startsWith(`${session.sessionId}.`));
    assert.equal(session.expiresInSeconds, 7200);

    const room = await fetch(`${base}${prefix}/rooms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ deviceLabel: 'Deployment smoke test' }),
    });
    assert.equal(room.status, 201);
    const data = await room.json();
    assert.match(data.code, /^\d{3}-\d{3}$/);

    const metadata = await fetch(`${base}${prefix}/rooms/${data.roomId}`, {
      headers: { Authorization: `Bearer ${session.token}` },
    });
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.json()).roomId, data.roomId);
  }

  const unauthorized = await fetch(`${base}/api/v1/rooms`, {
    method: 'POST',
    headers: { Authorization: 'Bearer invalid-token' },
  });
  assert.equal(unauthorized.status, 401);
});
