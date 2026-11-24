import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createEnv, createCtx, request, ORIGIN } from './helpers.js';

async function call(req, env = createEnv()) {
  const response = await worker.fetch(req, env, createCtx());
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch (error) { body = text; }
  return { status: response.status, headers: response.headers, body };
}

test('health: the Worker is up, the database answers, and the newest migration is reported', async () => {
  const { status, body, headers } = await call(request('/v1/health'));
  assert.equal(status, 200);
  assert.deepEqual(body, { ok: true, environment: 'test', database: 'ok', migration: '0001_init.sql' });
  assert.match(headers.get('Content-Type'), /application\/json/);
  assert.equal(headers.get('Cache-Control'), 'no-store');
});

test('health: a database failure is a 503, without internal details', async () => {
  const env = createEnv({ DB: { prepare() { throw new Error('D1_ERROR: secret internals'); } } });
  const { status, body } = await call(request('/v1/health'), env);
  assert.equal(status, 503);
  assert.deepEqual(body, { ok: false, environment: 'test', database: 'error', migration: null });
});

test('unknown API addresses are a JSON 404, a wrong method a 405', async () => {
  const missing = await call(request('/v1/nothing-here'));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'not_found');

  const wrongMethod = await call(request('/v1/health', { method: 'POST' }));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.body.error, 'method_not_allowed');
});

test('anything outside /v1/ goes to the static files, untouched', async () => {
  const env = createEnv();
  for (const path of ['/main.html', '/does-not-exist', '/v1x', '/api/lists']) {
    const { status, body } = await call(request(path), env);
    assert.equal(status, 200, path);
    assert.equal(body, 'asset', path);
  }
  assert.deepEqual(env.ASSETS.requests, ['/main.html', '/does-not-exist', '/v1x', '/api/lists']);
});

test('CORS: the site itself and the Android app may call the API; other sites may not', async () => {
  const same = await call(request('/v1/health', { origin: ORIGIN }));
  assert.equal(same.status, 200);

  const android = await call(request('/v1/health', { origin: 'https://localhost' }));
  assert.equal(android.status, 200);
  assert.equal(android.headers.get('Access-Control-Allow-Origin'), 'https://localhost');
  assert.match(android.headers.get('Vary'), /Origin/);

  const other = await call(request('/v1/health', { origin: 'https://evil.example' }));
  assert.equal(other.status, 403);
  assert.equal(other.body.error, 'origin_not_allowed');
  assert.equal(other.headers.get('Access-Control-Allow-Origin'), null);

  // No Origin header at all (curl, a health monitor): allowed, no CORS headers needed.
  const plain = await call(request('/v1/health'));
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('Access-Control-Allow-Origin'), null);
});

test('CORS preflight: allowed origins get the methods and headers, others a 403', async () => {
  const allowed = await call(request('/v1/health', { method: 'OPTIONS', origin: 'https://localhost' }));
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('Access-Control-Allow-Origin'), 'https://localhost');
  assert.match(allowed.headers.get('Access-Control-Allow-Headers'), /Authorization/);

  const refused = await call(request('/v1/health', { method: 'OPTIONS', origin: 'https://evil.example' }));
  assert.equal(refused.status, 403);
});
