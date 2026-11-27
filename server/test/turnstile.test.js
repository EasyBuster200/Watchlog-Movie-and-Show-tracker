// Turnstile (admin page part 2): the bot check before sign-up and recovery email codes.

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { SITEVERIFY_URL } from '../src/turnstile.js';
import { createEnv, createCtx, ORIGIN } from './helpers.js';

async function api(env, method, path, { body, ip = '192.0.2.10' } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const ctx = createCtx();
  const response = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await Promise.all(ctx.waits);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

// Cloudflare's siteverify and Resend, faked. `verdict` decides siteverify's answer
// ('pass', 'fail' or 'down'); every check and email is recorded.
function withFakes(fn) {
  return async () => {
    const fakes = { verdict: 'pass', checks: [], emails: [] };
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url) === SITEVERIFY_URL) {
        if (fakes.verdict === 'down') throw new Error('network');
        fakes.checks.push({ secret: init.body.get('secret'), response: init.body.get('response'), remoteip: init.body.get('remoteip') });
        return Response.json(fakes.verdict === 'pass' ? { success: true } : { success: false, 'error-codes': ['invalid-input-response'] });
      }
      if (String(url) === 'https://api.resend.com/emails') {
        fakes.emails.push(JSON.parse(init.body).to[0]);
        return new Response('{"id":"x"}', { status: 200 });
      }
      return original(url, init);
    };
    try {
      await fn(fakes);
    } finally {
      globalThis.fetch = original;
    }
  };
}

const turnstileEnv = () => createEnv({ RESEND_API_KEY: 'resend-key', TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET_KEY: 'secret-key' });

test('off unless both keys are set: no site key, no check', withFakes(async fakes => {
  const env = createEnv({ RESEND_API_KEY: 'resend-key', TURNSTILE_SITE_KEY: 'site-key' });
  assert.deepEqual((await api(env, 'GET', '/v1/turnstile')).body, { siteKey: null });
  assert.equal((await api(env, 'POST', '/v1/email-codes', { body: { email: 'a@example.com' } })).status, 200);
  assert.equal(fakes.checks.length, 0);
}));

test('sign-up codes need a passing check before any email goes out', withFakes(async fakes => {
  const env = turnstileEnv();
  assert.deepEqual((await api(env, 'GET', '/v1/turnstile')).body, { siteKey: 'site-key' });

  const missing = await api(env, 'POST', '/v1/email-codes', { body: { email: 'a@example.com' } });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'bot_check_needed');

  fakes.verdict = 'fail';
  assert.equal((await api(env, 'POST', '/v1/email-codes', { body: { email: 'a@example.com', turnstileToken: 'bad' } })).body.error, 'bot_check_failed');
  fakes.verdict = 'down';
  assert.equal((await api(env, 'POST', '/v1/email-codes', { body: { email: 'a@example.com', turnstileToken: 'tok' } })).body.error, 'bot_check_unavailable');
  assert.deepEqual(fakes.emails, [], 'nothing sent yet');

  fakes.verdict = 'pass';
  const ok = await api(env, 'POST', '/v1/email-codes', { body: { email: 'a@example.com', turnstileToken: 'good' }, ip: '192.0.2.44' });
  assert.equal(ok.status, 200);
  assert.deepEqual(fakes.checks.at(-1), { secret: 'secret-key', response: 'good', remoteip: '192.0.2.44' });
  assert.deepEqual(fakes.emails, ['a@example.com']);
}));

test('recovery codes need it too', withFakes(async fakes => {
  const env = turnstileEnv();
  assert.equal((await api(env, 'POST', '/v1/recovery/code', { body: { email: 'a@example.com' } })).body.error, 'bot_check_needed');
  assert.equal((await api(env, 'POST', '/v1/recovery/code', { body: { email: 'a@example.com', turnstileToken: 'good' } })).status, 200);
  assert.equal(fakes.checks.length, 1);
}));
