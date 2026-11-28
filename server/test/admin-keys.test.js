// Admin page part 2: emailing a locked-out person a new account key, and cancelling a recovery.

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { maskEmail } from '../src/routes/admin.js';
import { createEnv, createCtx, ORIGIN, signupEmail } from './helpers.js';

async function api(env, method, path, { body, token, ip = '203.0.113.90' } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctx = createCtx();
  const response = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await Promise.all(ctx.waits);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

// Resend, faked: every email sent is kept in `inbox`; `failing` makes sends fail.
function withMail(fn) {
  return async () => {
    const inbox = [];
    const state = { failing: false };
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url) === 'https://api.resend.com/emails') {
        if (state.failing) return new Response('{"message":"down"}', { status: 500 });
        const body = JSON.parse(init.body);
        inbox.push({ to: body.to[0], subject: body.subject, text: body.text });
        return new Response('{"id":"x"}', { status: 200 });
      }
      return original(url, init);
    };
    try {
      await fn(inbox, state);
    } finally {
      globalThis.fetch = original;
    }
  };
}

let ipCount = 120;
async function signUp(env, name, email) {
  const made = await api(env, 'POST', '/v1/accounts', { body: { displayName: name, deviceName: 'Phone', ...(await signupEmail(env, email)) }, ip: `203.0.113.${ipCount++ % 250}` });
  assert.equal(made.status, 201);
  return made.body;
}

async function setup() {
  const env = createEnv({ RESEND_API_KEY: 'resend-key', signupMode: 'open' });
  const owner = await signUp(env, 'Owner', 'owner@example.com');
  env.ADMIN_ACCOUNT_IDS = owner.account.id;
  const rui = await signUp(env, 'Rui', 'rui@example.com');
  return { env, owner, rui };
}

const signIn = (env, accountKey) => api(env, 'POST', '/v1/sessions', { body: { accountKey, deviceName: 'Laptop' }, ip: `203.0.113.${ipCount++ % 250}` });

test('a new key is emailed to the account, never shown, and signs every device out', withMail(async inbox => {
  const { env, owner, rui } = await setup();
  inbox.length = 0;
  env.DB.sqlite.prepare("INSERT INTO recoveries (account_id, token_hash, requested_at, completes_at) VALUES (?, 'h', '2026-01-01', '2099-01-01')").run(rui.account.id);

  const sent = await api(env, 'POST', `/v1/admin/users/${rui.account.id}/new-key`, { token: owner.token });
  assert.equal(sent.status, 200);
  assert.deepEqual(sent.body, { ok: true, sentTo: 'r•••@example.com' });
  assert.equal(JSON.stringify(sent.body).includes(rui.accountKey), false);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].to, 'rui@example.com');
  const newKey = inbox[0].text.match(/\n\n([0-9A-Z]{4}(?:-[0-9A-Z]{4}){6})\n\n/)[1];

  assert.equal((await api(env, 'GET', '/v1/account', { token: rui.token })).status, 401, 'old devices signed out');
  assert.equal((await signIn(env, rui.accountKey)).status, 401, 'old key stops working');
  assert.equal((await signIn(env, newKey)).status, 201, 'the emailed key works');
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM recoveries').get().n, 0, 'recovery cancelled');
  const log = (await api(env, 'GET', '/v1/admin/audit', { token: owner.token })).body.entries;
  assert.equal(log[0].action, 'new-key');
}));

test('a failed email changes nothing; admins, requests and other people are refused', withMail(async (inbox, state) => {
  const { env, owner, rui } = await setup();
  state.failing = true;
  const failed = await api(env, 'POST', `/v1/admin/users/${rui.account.id}/new-key`, { token: owner.token });
  assert.ok(failed.status >= 500);
  assert.equal((await api(env, 'GET', '/v1/account', { token: rui.token })).status, 200, 'still signed in');
  assert.equal((await signIn(env, rui.accountKey)).status, 201, 'old key still works');
  state.failing = false;

  assert.equal((await api(env, 'POST', `/v1/admin/users/${owner.account.id}/new-key`, { token: owner.token })).body.error, 'is_admin');
  assert.equal((await api(env, 'POST', `/v1/admin/users/${owner.account.id}/new-key`, { token: rui.token })).status, 403);

  const noMail = createEnv({ signupMode: 'open' });
  const o = await signUp(noMail, 'Owner', 'o@example.com');
  noMail.ADMIN_ACCOUNT_IDS = o.account.id;
  const p = await signUp(noMail, 'Pat', 'p@example.com');
  assert.equal((await api(noMail, 'POST', `/v1/admin/users/${p.account.id}/new-key`, { token: o.token })).body.error, 'email_unavailable');
}));

test('cancelling a recovery: shown on the users list, deleted, and the person is told', withMail(async inbox => {
  const { env, owner, rui } = await setup();
  env.DB.sqlite.prepare("INSERT INTO recoveries (account_id, token_hash, requested_at, completes_at) VALUES (?, 'h', '2026-01-01', '2099-01-01T00:00:00.000Z')").run(rui.account.id);
  const users = (await api(env, 'GET', '/v1/admin/users', { token: owner.token })).body.users;
  assert.equal(users.find(u => u.id === rui.account.id).recoveryUntil, '2099-01-01T00:00:00.000Z');
  assert.equal(users.find(u => u.id === owner.account.id).recoveryUntil, null);

  inbox.length = 0;
  assert.equal((await api(env, 'DELETE', `/v1/admin/users/${rui.account.id}/recovery`, { token: owner.token })).status, 204);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM recoveries').get().n, 0);
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].text, /owner of this Watchlog cancelled/);
  assert.equal((await api(env, 'DELETE', `/v1/admin/users/${rui.account.id}/recovery`, { token: owner.token })).body.error, 'no_recovery');
}));

test('masking an email for the admin page', () => {
  assert.equal(maskEmail('rui@example.com'), 'r•••@example.com');
  assert.equal(maskEmail('nope'), '•••');
});

test('the person who asked to join is emailed the answer: approved or declined', withMail(async inbox => {
  const env = createEnv({ RESEND_API_KEY: 'resend-key', signupMode: null });
  const owner = await signUp(env, 'Owner', 'owner@example.com');
  env.ADMIN_ACCOUNT_IDS = owner.account.id;
  const rui = await signUp(env, 'Rui', 'rui@example.com');
  const bea = await signUp(env, 'Bea', 'bea@example.com');
  assert.equal(rui.account.status, 'pending');
  inbox.length = 0;

  assert.equal((await api(env, 'POST', `/v1/admin/users/${rui.account.id}/approve`, { token: owner.token })).status, 200);
  assert.deepEqual(inbox.map(m => [m.to, m.subject]), [['rui@example.com', "You're in: your Watchlog account is ready"]]);

  assert.equal((await api(env, 'DELETE', `/v1/admin/users/${bea.account.id}`, { token: owner.token })).status, 204);
  assert.deepEqual(inbox.at(-1).to, 'bea@example.com');
  assert.match(inbox.at(-1).text, /wasn't accepted/);

  // Deleting an account that was already in sends nothing.
  inbox.length = 0;
  assert.equal((await api(env, 'DELETE', `/v1/admin/users/${rui.account.id}`, { token: owner.token })).status, 204);
  assert.equal(inbox.length, 0);
}));
