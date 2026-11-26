import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { generateVapidKeys, base64UrlEncode } from '../src/webpush.js';
import { createEnv, createCtx, ORIGIN, signupEmail } from './helpers.js';

// One "device": an IP address and, once signed in, its session token. Background work the
// request started (ctx.waitUntil: push notifications) is finished before returning.
async function api(env, method, path, { body, token, ip = '203.0.113.1' } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctx = createCtx();
  const response = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await Promise.all(ctx.waits);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

let ipCount = 10;
const nextIp = () => `203.0.113.${ipCount++ % 250}`;

async function signUp(env, displayName, extra = {}) {
  return api(env, 'POST', '/v1/accounts', { body: { displayName, deviceName: 'Phone', ...(await signupEmail(env)), ...extra }, ip: nextIp() });
}

// The owner's account (the first one, so it gets in whatever the mode) and an env that knows it
// as the admin. Then the sign-up mode is set as asked.
async function withOwner({ signupMode = 'approval', ...overrides } = {}) {
  const env = createEnv({ signupMode: null, ...overrides });
  const owner = (await signUp(env, 'Owner')).body;
  env.ADMIN_ACCOUNT_IDS = owner.account.id;
  if (signupMode !== 'approval') await api(env, 'PATCH', '/v1/admin/settings', { token: owner.token, body: { signupMode } });
  return { env, owner, admin: owner.token };
}

const sync = (env, token) => api(env, 'POST', '/v1/sync', { token, body: { since: 0, changes: [] } });

test('the first account gets in whatever the mode, and approval is the default after that', async () => {
  const env = createEnv({ signupMode: null });
  assert.deepEqual((await api(env, 'GET', '/v1/signup')).body, { mode: 'open', firstAccount: true });
  const first = await signUp(env, 'Owner');
  assert.equal(first.body.account.status, 'active');
  assert.deepEqual((await api(env, 'GET', '/v1/signup')).body, { mode: 'approval', firstAccount: false });
});

test('asking to join: a pending account can only check on itself until the owner approves it', async () => {
  const { env, admin } = await withOwner({ TMDB_TOKEN: 'tmdb-token' });
  const asked = await signUp(env, 'Rui', { note: "Ana's brother" });
  assert.equal(asked.status, 201);
  assert.equal(asked.body.account.status, 'pending');
  assert.ok(asked.body.accountKey, 'the key is given now, to save while waiting');
  const rui = asked.body.token;

  assert.equal((await api(env, 'GET', '/v1/account', { token: rui })).body.account.status, 'pending');
  const blocked = await sync(env, rui);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error, 'account_pending');
  assert.equal((await api(env, 'GET', '/v1/tmdb/movie/550', { token: rui })).body.error, 'account_pending');
  assert.equal((await api(env, 'POST', '/v1/pairing-codes', { token: rui })).status, 403);

  const users = (await api(env, 'GET', '/v1/admin/users', { token: admin })).body.users;
  assert.equal(users[0].displayName, 'Rui', 'requests come first');
  assert.equal(users[0].requestNote, "Ana's brother");
  assert.equal((await sync(env, admin)).body.admin.pendingRequests, 1, "the owner's app hears about it on its next sync");

  assert.equal((await api(env, 'POST', `/v1/admin/users/${asked.body.account.id}/approve`, { token: admin })).status, 200);
  assert.equal((await sync(env, rui)).status, 200);
  assert.equal((await api(env, 'GET', '/v1/account', { token: rui })).body.account.status, 'active');
  assert.equal((await sync(env, admin)).body.admin.pendingRequests, 0);
  assert.equal((await sync(env, rui)).body.admin, undefined, 'only the owner gets admin news');
});

test('declining a request deletes it; the person can also withdraw it themself', async () => {
  const { env, admin } = await withOwner();
  const asked = (await signUp(env, 'Stranger')).body;
  assert.equal((await api(env, 'DELETE', `/v1/admin/users/${asked.account.id}`, { token: admin })).status, 204);
  assert.equal((await api(env, 'GET', '/v1/account', { token: asked.token })).body.error, 'signed_out');
  const log = (await api(env, 'GET', '/v1/admin/audit', { token: admin })).body.entries;
  assert.equal(log[0].action, 'decline');

  const other = (await signUp(env, 'Changed my mind')).body;
  assert.equal((await api(env, 'DELETE', '/v1/account', { token: other.token })).status, 204);
});

test('invites: single use, expire, skip the wait in approval mode, and are required in invite mode', async () => {
  const { env, admin } = await withOwner();
  const made = await api(env, 'POST', '/v1/admin/invites', { token: admin, body: { note: 'for Mum', days: 3 } });
  assert.equal(made.status, 201);
  assert.match(made.body.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);

  const mum = await signUp(env, 'Mum', { inviteCode: made.body.code.toLowerCase() });
  assert.equal(mum.body.account.status, 'active', 'an invite skips the approval');
  const again = await signUp(env, 'Someone', { inviteCode: made.body.code });
  assert.equal(again.status, 400);
  assert.equal(again.body.error, 'wrong_invite');
  const invites = (await api(env, 'GET', '/v1/admin/invites', { token: admin })).body.invites;
  assert.equal(invites[0].usedBy, 'Mum');
  assert.equal(invites[0].note, 'for Mum');

  await api(env, 'PATCH', '/v1/admin/settings', { token: admin, body: { signupMode: 'invite' } });
  assert.equal((await signUp(env, 'No code')).body.error, 'invite_required');
  const fresh = (await api(env, 'POST', '/v1/admin/invites', { token: admin, body: {} })).body;
  env.DB.sqlite.prepare("UPDATE invites SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(fresh.invite.id);
  assert.equal((await signUp(env, 'Late', { inviteCode: fresh.code })).body.error, 'wrong_invite', 'expired');

  const cancelled = (await api(env, 'POST', '/v1/admin/invites', { token: admin, body: {} })).body;
  assert.equal((await api(env, 'DELETE', `/v1/admin/invites/${cancelled.invite.id}`, { token: admin })).status, 204);
  assert.equal((await signUp(env, 'Cancelled', { inviteCode: cancelled.code })).body.error, 'wrong_invite');
  assert.equal((await api(env, 'POST', '/v1/admin/invites', { token: admin, body: { days: 99 } })).status, 400);
});

test('closed means closed, and open lets anyone in', async () => {
  const { env, admin } = await withOwner({ signupMode: 'closed' });
  const refused = await signUp(env, 'Late');
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'signup_closed');
  await api(env, 'PATCH', '/v1/admin/settings', { token: admin, body: { signupMode: 'open' } });
  assert.equal((await signUp(env, 'Anyone')).body.account.status, 'active');
  assert.equal((await api(env, 'PATCH', '/v1/admin/settings', { token: admin, body: { signupMode: 'party' } })).status, 400);
});

test('only the admin gets in, and the overview counts what matters', async () => {
  const { env, admin } = await withOwner({ signupMode: 'open' });
  const user = (await signUp(env, 'Rui')).body;
  for (const [method, path] of [['GET', '/v1/admin/overview'], ['GET', '/v1/admin/users'], ['POST', '/v1/admin/invites'], ['PATCH', '/v1/admin/settings']]) {
    const res = await api(env, method, path, { token: user.token, body: method === 'GET' ? undefined : {} });
    assert.equal(res.status, 403, path);
    assert.equal(res.body.error, 'not_admin');
  }
  assert.equal((await api(env, 'GET', '/v1/admin/overview')).status, 401);

  await api(env, 'POST', '/v1/sync', { token: user.token, body: { since: 0, changes: [{ kind: 'watched_movie', key: '550', data: { tmdbId: 550 }, updatedAt: new Date().toISOString() }] } });
  const overview = (await api(env, 'GET', '/v1/admin/overview', { token: admin })).body;
  assert.deepEqual(overview.accounts, { active: 2, pending: 0, suspended: 0 });
  assert.equal(overview.syncRecords, 1);
  assert.equal(overview.settings.signupMode, 'open');
  assert.equal(overview.lastBackup, null);
  assert.equal((await api(env, 'GET', '/v1/account', { token: admin })).body.isAdmin, true);
  assert.equal((await api(env, 'GET', '/v1/account', { token: user.token })).body.isAdmin, false);
});

test('suspending signs every device out and stops sign-in, until unsuspended; admins are protected', async () => {
  const { env, owner, admin } = await withOwner({ signupMode: 'open' });
  const rui = (await signUp(env, 'Rui')).body;
  assert.equal((await api(env, 'POST', `/v1/admin/users/${rui.account.id}/suspend`, { token: admin })).status, 200);
  assert.equal((await sync(env, rui.token)).body.error, 'signed_out');
  const signIn = await api(env, 'POST', '/v1/sessions', { body: { accountKey: rui.accountKey }, ip: nextIp() });
  assert.equal(signIn.status, 403);
  assert.equal(signIn.body.error, 'account_suspended');

  await api(env, 'POST', `/v1/admin/users/${rui.account.id}/unsuspend`, { token: admin });
  assert.equal((await api(env, 'POST', '/v1/sessions', { body: { accountKey: rui.accountKey }, ip: nextIp() })).status, 201);

  for (const action of ['suspend', 'sign-out']) {
    assert.equal((await api(env, 'POST', `/v1/admin/users/${owner.account.id}/${action}`, { token: admin })).body.error, 'is_admin');
  }
  assert.equal((await api(env, 'DELETE', `/v1/admin/users/${owner.account.id}`, { token: admin })).body.error, 'is_admin');
  const actions = (await api(env, 'GET', '/v1/admin/audit', { token: admin })).body.entries.map(e => e.action);
  assert.deepEqual(actions.slice(0, 2), ['unsuspend', 'suspend']);
});

test("the TMDB switch and daily cap are the admin page's settings", async () => {
  const { env, admin } = await withOwner({ signupMode: 'open', TMDB_TOKEN: 'tmdb-token' });
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"id":550}', { status: 200 });
  try {
    await api(env, 'PATCH', '/v1/admin/settings', { token: admin, body: { tmdbProxy: 'off' } });
    assert.equal((await api(env, 'GET', '/v1/tmdb/movie/550', { token: admin })).body.error, 'tmdb_paused');
    await api(env, 'PATCH', '/v1/admin/settings', { token: admin, body: { tmdbProxy: 'on', tmdbDailyCap: 100 } });
    for (let i = 0; i < 100; i++) assert.equal((await api(env, 'GET', `/v1/tmdb/movie/${i}`, { token: admin })).status, 200);
    assert.equal((await api(env, 'GET', '/v1/tmdb/movie/101', { token: admin })).status, 429);
    assert.equal((await api(env, 'GET', '/v1/admin/overview', { token: admin })).body.tmdbToday, 101);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal((await api(env, 'PATCH', '/v1/admin/settings', { token: admin, body: { tmdbDailyCap: 5 } })).status, 400);
});

// ---------- Push ----------

async function browserSubscription(endpoint) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const p256dh = base64UrlEncode(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { endpoint, keys: { p256dh, auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))) } };
}

test("a sign-up request is pushed to the owner's devices; dead subscriptions are dropped", async () => {
  const vapid = await generateVapidKeys();
  const { env, admin } = await withOwner({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:owner@example.com' });
  assert.equal((await api(env, 'GET', '/v1/push/key')).body.publicKey, vapid.publicKey);
  await api(env, 'PUT', '/v1/push/subscription', { token: admin, body: await browserSubscription('https://push.example/alive') });
  await api(env, 'PUT', '/v1/push/subscription', { token: admin, body: await browserSubscription('https://push.example/gone') });
  assert.equal((await api(env, 'PUT', '/v1/push/subscription', { token: admin, body: { endpoint: 'http://insecure', keys: {} } })).status, 400);

  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), headers: init.headers });
    return new Response(null, { status: String(url).endsWith('/gone') ? 410 : 201 });
  };
  try {
    await signUp(env, 'Rui', { note: 'hi' });
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(sent.map(s => s.url).sort(), ['https://push.example/alive', 'https://push.example/gone']);
  assert.match(sent[0].headers.Authorization, /^vapid t=/);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 1, 'the gone one was deleted');

  // Signing the device out removes its subscription.
  await api(env, 'DELETE', '/v1/session', { token: admin });
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 0);
});

test('without VAPID keys, push is simply unavailable and sign-ups still work', async () => {
  const { env, admin } = await withOwner();
  assert.equal((await api(env, 'GET', '/v1/push/key')).body.error, 'push_unavailable');
  assert.equal((await api(env, 'POST', '/v1/push/test', { token: admin })).status, 404);
  assert.equal((await signUp(env, 'Rui')).status, 201);
});

test("the owner's own account, if it started out waiting, is let in by opening the admin page", async () => {
  const env = createEnv({ signupMode: null });
  await signUp(env, 'Someone first');
  const owner = (await signUp(env, 'Owner')).body;
  assert.equal(owner.account.status, 'pending');
  assert.equal((await api(env, 'GET', '/v1/admin/overview', { token: owner.token })).body.error, 'account_pending', 'not admin yet');
  env.ADMIN_ACCOUNT_IDS = owner.account.id;
  assert.equal((await api(env, 'GET', '/v1/account', { token: owner.token })).body.isAdmin, true);
  assert.equal((await api(env, 'GET', '/v1/admin/overview', { token: owner.token })).status, 200);
  assert.equal((await api(env, 'GET', '/v1/account', { token: owner.token })).body.account.status, 'active');
});
