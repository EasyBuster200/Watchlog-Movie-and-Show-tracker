import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { EMAIL_LIMITS, normalizeEmail } from '../src/email.js';
import { createEnv, createCtx, ORIGIN, signupEmail } from './helpers.js';

async function api(env, method, path, { body, token, ip = '203.0.113.50' } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctx = createCtx();
  const response = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await Promise.all(ctx.waits);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

// Resend, faked: every email sent is kept in `inbox` ({ to, subject, text, from }).
function withMail(fn) {
  return async () => {
    const inbox = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (String(url) === 'https://api.resend.com/emails') {
        assert.equal(init.headers.Authorization, 'Bearer resend-key');
        const body = JSON.parse(init.body);
        inbox.push({ to: body.to[0], subject: body.subject, text: body.text, from: body.from });
        return new Response('{"id":"x"}', { status: 200 });
      }
      return original(url, init);
    };
    try {
      await fn(inbox);
    } finally {
      globalThis.fetch = original;
    }
  };
}

const mailEnv = (extra = {}) => createEnv({ RESEND_API_KEY: 'resend-key', ...extra });
const codeIn = mail => mail.text.match(/Your code is (\d{6})/)[1];

let ipCount = 60;
const ip = () => `203.0.113.${ipCount++}`;

async function signUp(env, email = 'ana@example.com', name = 'Ana') {
  const made = await api(env, 'POST', '/v1/accounts', { body: { displayName: name, deviceName: 'Phone', ...(await signupEmail(env, email)) }, ip: ip() });
  assert.equal(made.status, 201);
  return made.body;
}

test('email addresses are tidied and checked', () => {
  assert.equal(normalizeEmail('  Ana@Example.COM '), 'ana@example.com');
  assert.equal(normalizeEmail('ana@example'), null);
  assert.equal(normalizeEmail('not an email'), null);
});

test('signing up needs the code sent to the email', withMail(async inbox => {
  const env = mailEnv();
  assert.equal((await api(env, 'POST', '/v1/email-codes', { body: { email: 'nope' } })).body.error, 'invalid_email');
  assert.deepEqual((await api(env, 'POST', '/v1/email-codes', { body: { email: 'Ana@Example.com' } })).body, { sent: true });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].to, 'ana@example.com');
  assert.equal(inbox[0].from, 'Watchlog <no-reply@watchlogtracker.com>');
  const code = codeIn(inbox[0]);

  const body = { displayName: 'Ana', deviceName: 'Phone', email: 'ana@example.com' };
  assert.equal((await api(env, 'POST', '/v1/accounts', { body })).body.error, 'wrong_email_code', 'no code');
  assert.equal((await api(env, 'POST', '/v1/accounts', { body: { ...body, emailCode: code === '000000' ? '111111' : '000000' } })).body.error, 'wrong_email_code');
  const made = await api(env, 'POST', '/v1/accounts', { body: { ...body, emailCode: code } });
  assert.equal(made.status, 201);
  assert.equal(made.body.account.email, 'ana@example.com');
  assert.equal((await api(env, 'POST', '/v1/accounts', { body: { ...body, emailCode: code }, ip: ip() })).body.error, 'wrong_email_code', 'a code works once');

  // The same address again: a note to the inbox instead of a code, and the same answer.
  assert.deepEqual((await api(env, 'POST', '/v1/email-codes', { body: { email: 'ana@example.com' }, ip: ip() })).body, { sent: true });
  assert.match(inbox[1].subject, /already have a Watchlog account/);
  const again = await api(env, 'POST', '/v1/accounts', { body: { ...body, ...(await signupEmail(env, 'ana@example.com')) }, ip: ip() });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, 'email_taken');
}));

test('a code is gone after five wrong tries', withMail(async inbox => {
  const env = mailEnv();
  await api(env, 'POST', '/v1/email-codes', { body: { email: 'rui@example.com' } });
  const code = codeIn(inbox[0]);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) {
    await api(env, 'POST', '/v1/accounts', { body: { displayName: 'Rui', email: 'rui@example.com', emailCode: wrong }, ip: ip() });
  }
  assert.equal((await api(env, 'POST', '/v1/accounts', { body: { displayName: 'Rui', email: 'rui@example.com', emailCode: code }, ip: ip() })).body.error, 'wrong_email_code');
}));

test('without Resend, sign-up says email is unavailable; the daily cap is kept', withMail(async inbox => {
  const off = createEnv();
  const answer = await api(off, 'POST', '/v1/email-codes', { body: { email: 'ana@example.com' } });
  assert.equal(answer.status, 503);
  assert.equal(answer.body.error, 'email_unavailable');

  const env = mailEnv();
  env.DB.sqlite.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('email:all', ?, ?)")
    .run(Math.floor(Date.now() / 1000 / 86400) * 86400, EMAIL_LIMITS.perDay);
  assert.equal((await api(env, 'POST', '/v1/email-codes', { body: { email: 'ana@example.com' } })).body.error, 'email_busy');
  assert.equal(inbox.length, 0);
}));

test('changing the email: a code to the new address, and a note to the old one', withMail(async inbox => {
  const env = mailEnv();
  const ana = await signUp(env);
  await signUp(env, 'rui@example.com', 'Rui');
  assert.equal((await api(env, 'POST', '/v1/account/email-code', { token: ana.token, body: { email: 'rui@example.com' } })).body.error, 'email_taken');
  assert.equal((await api(env, 'POST', '/v1/account/email-code', { token: ana.token, body: { email: 'ana@example.com' } })).body.error, 'same_email');

  await api(env, 'POST', '/v1/account/email-code', { token: ana.token, body: { email: 'ana.new@example.com' } });
  const code = codeIn(inbox.at(-1));
  assert.equal(inbox.at(-1).to, 'ana.new@example.com');
  const changed = await api(env, 'PUT', '/v1/account/email', { token: ana.token, body: { email: 'ana.new@example.com', code } });
  assert.equal(changed.body.account.email, 'ana.new@example.com');
  assert.equal(inbox.at(-1).to, 'ana@example.com');
  assert.match(inbox.at(-1).text, /now ana\.new@example\.com/);
  assert.equal((await api(env, 'GET', '/v1/account', { token: ana.token })).body.account.email, 'ana.new@example.com');
}));

test('recovery: a code, a 24-hour hold any device can cancel, then a new key', withMail(async inbox => {
  const env = mailEnv();
  const ana = await signUp(env);
  const oldKey = ana.accountKey;

  // Unknown addresses get the same answer and no email.
  assert.deepEqual((await api(env, 'POST', '/v1/recovery/code', { body: { email: 'nobody@example.com' } })).body, { sent: true });
  assert.equal(inbox.length, 0);

  await api(env, 'POST', '/v1/recovery/code', { body: { email: 'ANA@example.com' }, ip: ip() });
  const started = await api(env, 'POST', '/v1/recovery', { body: { email: 'ana@example.com', code: codeIn(inbox[0]), deviceName: 'New phone' }, ip: ip() });
  assert.equal(started.status, 201);
  assert.equal(started.body.displayName, 'Ana');
  const hours = (Date.parse(started.body.completesAt) - Date.now()) / 3600000;
  assert.ok(hours > 23.9 && hours <= 24, 'a 24-hour hold');
  assert.match(inbox.at(-1).subject, /Someone is recovering/);

  // Signed-in devices hear about it, and can cancel.
  assert.equal((await api(env, 'GET', '/v1/account', { token: ana.token })).body.recovery.completesAt, started.body.completesAt);
  const synced = await api(env, 'POST', '/v1/sync', { token: ana.token, body: { since: 0, changes: [] } });
  assert.equal(synced.body.recovery.completesAt, started.body.completesAt);
  const early = await api(env, 'POST', '/v1/recovery/complete', { body: { recoveryToken: started.body.recoveryToken }, ip: ip() });
  assert.equal(early.status, 409);
  assert.equal(early.body.error, 'recovery_waiting');
  assert.equal((await api(env, 'DELETE', '/v1/account/recovery', { token: ana.token })).status, 204);
  assert.match(inbox.at(-1).subject, /cancelled/);
  assert.equal((await api(env, 'POST', '/v1/recovery/complete', { body: { recoveryToken: started.body.recoveryToken }, ip: ip() })).body.error, 'recovery_cancelled');
  assert.equal((await api(env, 'GET', '/v1/account', { token: ana.token })).body.recovery, null);

  // Again, and this time nobody cancels.
  await api(env, 'POST', '/v1/recovery/code', { body: { email: 'ana@example.com' }, ip: ip() });
  const second = await api(env, 'POST', '/v1/recovery', { body: { email: 'ana@example.com', code: codeIn(inbox.at(-1)), deviceName: 'New phone' }, ip: ip() });
  env.DB.sqlite.prepare("UPDATE recoveries SET completes_at = '2020-01-01T00:00:00.000Z'").run();
  const done = await api(env, 'POST', '/v1/recovery/complete', { body: { recoveryToken: second.body.recoveryToken, deviceName: 'New phone' }, ip: ip() });
  assert.equal(done.status, 201);
  assert.ok(done.body.accountKey && done.body.accountKey !== oldKey);
  assert.equal(done.body.account.id, ana.account.id);
  assert.equal((await api(env, 'GET', '/v1/account', { token: done.body.token })).status, 200);
  assert.equal((await api(env, 'GET', '/v1/account', { token: ana.token })).body.error, 'signed_out', 'every other device is signed out');
  assert.equal((await api(env, 'POST', '/v1/sessions', { body: { accountKey: oldKey }, ip: ip() })).body.error, 'wrong_key', 'the old key stopped working');
  assert.equal((await api(env, 'POST', '/v1/sessions', { body: { accountKey: done.body.accountKey }, ip: ip() })).status, 201);
  assert.equal((await api(env, 'POST', '/v1/recovery/complete', { body: { recoveryToken: second.body.recoveryToken }, ip: ip() })).body.error, 'recovery_cancelled', 'only once');
}));

test("the owner gets an email about each request to join, with the person's address", withMail(async inbox => {
  const env = mailEnv({ signupMode: null });
  const owner = await signUp(env, 'owner@example.com', 'Owner');
  env.ADMIN_ACCOUNT_IDS = owner.account.id;
  const asked = await api(env, 'POST', '/v1/accounts', { body: { displayName: 'Rui', note: "Ana's brother", ...(await signupEmail(env, 'rui@example.com')) }, ip: ip() });
  assert.equal(asked.body.account.status, 'pending');
  const alert = inbox.find(m => m.to === 'owner@example.com');
  assert.ok(alert, 'the owner was emailed');
  assert.equal(alert.subject, 'Rui wants to join Watchlog');
  assert.match(alert.text, /rui@example\.com/);
  assert.match(alert.text, /Ana's brother/);
  assert.match(alert.text, /\/admin\.html#requests/);
  const users = await api(env, 'GET', '/v1/admin/users', { token: owner.token });
  assert.equal(users.body.users.find(u => u.displayName === 'Rui').email, 'rui@example.com');
}));

test('migration 0006 deletes every earlier account and what hangs off it', async () => {
  const { createD1, applyMigrations, MIGRATIONS_DIR } = await import('./helpers.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const before = fs.mkdtempSync(path.join(os.tmpdir(), 'watchlog-migrations-'));
  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter(f => f < '0006')) fs.copyFileSync(path.join(MIGRATIONS_DIR, file), path.join(before, file));
  const db = createD1({ migrate: false });
  applyMigrations(db.sqlite, before);
  const now = '2026-11-01T00:00:00.000Z';
  db.sqlite.prepare("INSERT INTO accounts (id, key_hash, display_name, created_at, key_changed_at) VALUES ('old', 'h', 'Old', ?, ?)").run(now, now);
  db.sqlite.prepare("INSERT INTO sessions (id, account_id, token_hash, device_name, created_at, last_used_at, expires_at) VALUES ('s', 'old', 't', 'd', ?, ?, ?)").run(now, now, now);
  db.sqlite.prepare("INSERT INTO sync_records (account_id, kind, record_key, data, deleted, updated_at, seq) VALUES ('old', 'watched_movie', '550', '{}', 0, ?, 1)").run(now);

  applyMigrations(db.sqlite);
  for (const table of ['accounts', 'sessions', 'sync_records']) {
    assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, `${table} is empty`);
  }
  fs.rmSync(before, { recursive: true, force: true });
});
