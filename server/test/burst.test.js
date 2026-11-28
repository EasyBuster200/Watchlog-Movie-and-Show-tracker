// Per-minute burst limits (admin page part 2): one count per address across the routes anyone can
// call without signing in, a cap on emails per minute, and on friend requests per minute.

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { BURST_LIMITS } from '../src/auth.js';
import { sendEmail } from '../src/email.js';
import { createEnv, createCtx, ORIGIN, signupEmail } from './helpers.js';

async function api(env, method, path, { body, token, ip = '198.51.100.7' } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctx = createCtx();
  const response = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await Promise.all(ctx.waits);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null, retryAfter: response.headers.get('Retry-After') };
}

test('signing in, pairing and recovery share one per-minute count per address', async () => {
  const env = createEnv();
  const [limit] = BURST_LIMITS.perClient;
  // Spread over routes so no single route's own limit is reached first.
  const calls = [];
  for (let i = 0; i < 9; i++) calls.push(['POST', '/v1/sessions', { accountKey: 'nope', deviceName: 'x' }]);
  for (let i = 0; i < 9; i++) calls.push(['POST', '/v1/sessions/pair', { code: 'ABCD-1234', deviceName: 'x' }]);
  while (calls.length < limit) calls.push(['POST', '/v1/recovery/code', { email: 'nobody@example.com' }]);
  for (const [method, path, body] of calls) {
    assert.notEqual((await api(env, method, path, { body })).status, 429, `${path} before the limit`);
  }
  const over = await api(env, 'POST', '/v1/recovery/code', { body: { email: 'nobody@example.com' } });
  assert.equal(over.status, 429);
  assert.equal(over.body.error, 'too_many_requests');
  assert.ok(Number(over.retryAfter) > 0 && Number(over.retryAfter) <= 60);
  assert.notEqual((await api(env, 'POST', '/v1/sessions', { body: { accountKey: 'nope' }, ip: '198.51.100.8' })).status, 429, 'other addresses are fine');
});

test('emails are capped per minute as well as per day', async () => {
  const env = createEnv({ RESEND_API_KEY: 'resend-key' });
  const fetchImpl = async () => new Response('{"id":"x"}', { status: 200 });
  const [limit] = BURST_LIMITS.emailsPerMinute;
  for (let i = 0; i < limit; i++) await sendEmail(env, { to: `p${i}@example.com`, subject: 's', text: 't' }, { fetchImpl });
  await assert.rejects(sendEmail(env, { to: 'late@example.com', subject: 's', text: 't' }, { fetchImpl }), error => error.error === 'email_busy' && error.extra.retryAfter > 0);
});

test('friend requests are capped per minute', async () => {
  const env = createEnv();
  let n = 0;
  const person = async name => (await api(env, 'POST', '/v1/accounts', { body: { displayName: name, deviceName: 'Phone', ...(await signupEmail(env)) }, ip: `198.51.100.${20 + n++}` })).body;
  const ana = await person('Ana');
  const [limit] = BURST_LIMITS.friendRequestsPerMinute;
  for (let i = 0; i < limit; i++) {
    const other = await person(`P${i}`);
    const code = (await api(env, 'GET', '/v1/friends', { token: other.token })).body.code;
    assert.equal((await api(env, 'POST', '/v1/friends/requests', { token: ana.token, body: { code } })).status, 201);
  }
  const last = await person('Last');
  const code = (await api(env, 'GET', '/v1/friends', { token: last.token })).body.code;
  assert.equal((await api(env, 'POST', '/v1/friends/requests', { token: ana.token, body: { code } })).status, 429);
});
