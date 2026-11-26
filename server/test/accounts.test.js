import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { accountKeyData, generateAccountKey, normalizeCode, ALPHABET } from '../src/auth.js';
import { runCleanup } from '../src/cleanup.js';
import { LIMITS } from '../src/routes/accounts.js';
import { createEnv, createCtx, ORIGIN, signupEmail } from './helpers.js';

// One "device": an IP address and, once signed in, its session token.
async function api(env, method, path, { body, token, ip = '203.0.113.1' } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await worker.fetch(
    new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env, createCtx(),
  );
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : null };
}

async function createAccount(env, opts = {}) {
  const res = await api(env, 'POST', '/v1/accounts', { body: { displayName: 'Ana', deviceName: 'iPhone', ...(await signupEmail(env)), ...opts.body }, ip: opts.ip });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const rows = (env, sql, ...params) => env.DB.sqlite.prepare(sql).all(...params).map(r => ({ ...r }));

// ---------- the account key ----------

test('account keys are 7 groups of 4, with a check character that catches typos', () => {
  const key = generateAccountKey();
  assert.match(key, /^([0-9A-Z]{4}-){6}[0-9A-Z]{4}$/);
  assert.ok([...key.replace(/-/g, '')].every(c => ALPHABET.includes(c)));
  assert.ok(accountKeyData(key));

  // Lower case, spaces and the usual look-alikes are accepted.
  const typed = key.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l');
  assert.equal(accountKeyData(typed), accountKeyData(key));

  // One wrong character, or two neighbours swapped, is caught.
  const clean = normalizeCode(key);
  for (let i = 0; i < clean.length; i++) {
    const wrong = clean.slice(0, i) + ALPHABET[(ALPHABET.indexOf(clean[i]) + 7) % 32] + clean.slice(i + 1);
    assert.equal(accountKeyData(wrong), null, `changed character ${i}`);
  }
  for (let i = 0; i < clean.length - 1; i++) {
    if (clean[i] === clean[i + 1]) continue;
    const swapped = clean.slice(0, i) + clean[i + 1] + clean[i] + clean.slice(i + 2);
    const a = ALPHABET.indexOf(clean[i]); const b = ALPHABET.indexOf(clean[i + 1]);
    if (Math.abs(a - b) === 31) continue; // 0 and Z: the one pair mod 31 can't tell apart
    assert.equal(accountKeyData(swapped), null, `swapped ${i} and ${i + 1}`);
  }
  assert.equal(accountKeyData('too-short'), null);
  assert.equal(accountKeyData(''), null);
});

// ---------- creating an account ----------

test('creating an account returns its key and signs this device in; only hashes are stored', async () => {
  const env = createEnv();
  const created = await createAccount(env);
  assert.ok(accountKeyData(created.accountKey));
  assert.equal(created.account.displayName, 'Ana');
  assert.equal(created.session.deviceName, 'iPhone');
  assert.equal(created.session.current, true);
  assert.ok(created.token.length >= 40);

  const stored = JSON.stringify([...rows(env, 'SELECT * FROM accounts'), ...rows(env, 'SELECT * FROM sessions')]);
  assert.ok(!stored.includes(created.accountKey) && !stored.includes(normalizeCode(created.accountKey).slice(0, 27)), 'the key is never stored');
  assert.ok(!stored.includes(created.token), 'the session token is never stored');

  const me = await api(env, 'GET', '/v1/account', { token: created.token });
  assert.equal(me.status, 200);
  assert.deepEqual(me.body.account, created.account);
});

test('an account needs a name; names and device names are tidied and capped', async () => {
  const env = createEnv();
  const missing = await api(env, 'POST', '/v1/accounts', { body: { displayName: '   ' } });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'name_required');

  const created = await createAccount(env, { body: { displayName: '  Ana   Maria  ', deviceName: 'x'.repeat(200) } });
  assert.equal(created.account.displayName, 'Ana Maria');
  assert.equal(created.session.deviceName.length, 60);
  const noDevice = await createAccount(env, { body: { deviceName: undefined }, ip: '203.0.113.2' });
  assert.equal(noDevice.session.deviceName, 'Unknown device');

  const bad = await worker.fetch(new Request(`${ORIGIN}/v1/accounts`, { method: 'POST', body: '{not json' }), env, createCtx());
  assert.equal(bad.status, 400);
});

// ---------- signing in ----------

test('signing in with the account key, as typed by a person', async () => {
  const env = createEnv();
  const { accountKey, account } = await createAccount(env);
  const res = await api(env, 'POST', '/v1/sessions', { body: { accountKey: accountKey.toLowerCase().replace(/-/g, ' '), deviceName: 'Pixel' } });
  assert.equal(res.status, 201);
  assert.equal(res.body.account.id, account.id);
  assert.equal(res.body.session.deviceName, 'Pixel');

  const typo = await api(env, 'POST', '/v1/sessions', { body: { accountKey: accountKey.slice(0, -1) + (accountKey.endsWith('0') ? '1' : '0') } });
  assert.equal(typo.status, 400);
  assert.equal(typo.body.error, 'invalid_key_format');

  const otherKey = await api(env, 'POST', '/v1/sessions', { body: { accountKey: generateAccountKey() } });
  assert.equal(otherKey.status, 401);
  assert.equal(otherKey.body.error, 'wrong_key');
});

test('requests without a valid session are refused', async () => {
  const env = createEnv();
  for (const token of [undefined, 'not-a-real-token']) {
    const res = await api(env, 'GET', '/v1/account', { token });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'signed_out');
  }
});

test('sessions expire after 180 days unused, and using one pushes that out (at most hourly)', async () => {
  const env = createEnv();
  const { token, session } = await createAccount(env);
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  env.DB.sqlite.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?')
    .run(twoHoursAgo, new Date(Date.now() + 1000 * 3600).toISOString(), session.id);
  assert.equal((await api(env, 'GET', '/v1/account', { token })).status, 200);
  const touched = rows(env, 'SELECT last_used_at, expires_at FROM sessions WHERE id = ?', session.id)[0];
  assert.ok(touched.last_used_at > twoHoursAgo);
  assert.ok(Date.parse(touched.expires_at) > Date.now() + 179 * 24 * 3600 * 1000);

  env.DB.sqlite.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(new Date(Date.now() - 1000).toISOString(), session.id);
  const expired = await api(env, 'GET', '/v1/account', { token });
  assert.equal(expired.status, 401);
  assert.equal(rows(env, 'SELECT id FROM sessions').length, 0, 'the expired session is removed');
});

// ---------- the account ----------

test('renaming the account', async () => {
  const env = createEnv();
  const { token } = await createAccount(env);
  const res = await api(env, 'PATCH', '/v1/account', { token, body: { displayName: 'Ana C.' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.account.displayName, 'Ana C.');
  assert.equal((await api(env, 'GET', '/v1/account', { token })).body.account.displayName, 'Ana C.');
  assert.equal((await api(env, 'PATCH', '/v1/account', { token, body: { displayName: '' } })).status, 400);
});

test('a new key replaces the old one; signed-in devices stay signed in', async () => {
  const env = createEnv();
  const { accountKey: oldKey, token } = await createAccount(env);
  const res = await api(env, 'POST', '/v1/account/key', { token });
  assert.equal(res.status, 200);
  assert.notEqual(res.body.accountKey, oldKey);
  assert.equal((await api(env, 'POST', '/v1/sessions', { body: { accountKey: oldKey } })).status, 401);
  assert.equal((await api(env, 'POST', '/v1/sessions', { body: { accountKey: res.body.accountKey } })).status, 201);
  assert.equal((await api(env, 'GET', '/v1/account', { token })).status, 200);
});

test('deleting the account removes it and signs every device out', async () => {
  const env = createEnv();
  const { accountKey, token } = await createAccount(env);
  const second = (await api(env, 'POST', '/v1/sessions', { body: { accountKey } })).body.token;
  assert.equal((await api(env, 'DELETE', '/v1/account', { token })).status, 204);
  assert.equal((await api(env, 'GET', '/v1/account', { token: second })).status, 401);
  assert.equal((await api(env, 'POST', '/v1/sessions', { body: { accountKey } })).status, 401);
  assert.equal(rows(env, 'SELECT id FROM sessions').length, 0);
});

// ---------- adding a device with a one-time code ----------

test('a pairing code signs one new device in, once', async () => {
  const env = createEnv();
  const { token, account } = await createAccount(env);
  const made = await api(env, 'POST', '/v1/pairing-codes', { token });
  assert.equal(made.status, 201);
  assert.match(made.body.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.ok(Date.parse(made.body.expiresAt) > Date.now());

  const paired = await api(env, 'POST', '/v1/sessions/pair', { body: { code: made.body.code.toLowerCase(), deviceName: 'Tablet' }, ip: '198.51.100.7' });
  assert.equal(paired.status, 201);
  assert.equal(paired.body.account.id, account.id);
  assert.equal(paired.body.accountKey, undefined, 'pairing never hands out the account key');

  const again = await api(env, 'POST', '/v1/sessions/pair', { body: { code: made.body.code } });
  assert.equal(again.status, 401);
  assert.equal(again.body.error, 'wrong_code');
});

test('pairing codes expire, and a new code replaces the previous one', async () => {
  const env = createEnv();
  const { token } = await createAccount(env);
  const first = (await api(env, 'POST', '/v1/pairing-codes', { token })).body.code;
  const second = (await api(env, 'POST', '/v1/pairing-codes', { token })).body.code;
  assert.equal((await api(env, 'POST', '/v1/sessions/pair', { body: { code: first } })).status, 401, 'replaced');

  env.DB.sqlite.prepare('UPDATE pairing_codes SET expires_at = ?').run(new Date(Date.now() - 1000).toISOString());
  assert.equal((await api(env, 'POST', '/v1/sessions/pair', { body: { code: second } })).status, 401, 'expired');
  assert.equal((await api(env, 'POST', '/v1/sessions/pair', { body: { code: 'nope' } })).body.error, 'invalid_code_format');
  assert.equal((await api(env, 'POST', '/v1/pairing-codes')).status, 401, 'only a signed-in device can make a code');
});

// ---------- devices ----------

test('the device list marks this device; any device can be signed out, but only within the account', async () => {
  const env = createEnv();
  const { accountKey, token } = await createAccount(env);
  const pixel = (await api(env, 'POST', '/v1/sessions', { body: { accountKey, deviceName: 'Pixel' } })).body;
  const other = await createAccount(env, { ip: '203.0.113.9', body: { displayName: 'Rui' } });

  const list = (await api(env, 'GET', '/v1/sessions', { token })).body.sessions;
  assert.deepEqual(list.map(s => [s.deviceName, s.current]).sort(), [['Pixel', false], ['iPhone', true]]);

  assert.equal((await api(env, 'DELETE', `/v1/sessions/${other.session.id}`, { token })).status, 404, "another account's device");
  assert.equal((await api(env, 'DELETE', `/v1/sessions/${pixel.session.id}`, { token })).status, 204);
  assert.equal((await api(env, 'GET', '/v1/account', { token: pixel.token })).status, 401);

  assert.equal((await api(env, 'DELETE', '/v1/session', { token })).status, 204, 'sign out this device');
  assert.equal((await api(env, 'GET', '/v1/account', { token })).status, 401);
  assert.equal((await api(env, 'GET', '/v1/account', { token: other.token })).status, 200, 'other accounts unaffected');
});

// ---------- rate limits ----------

test('account creation is rate-limited per address', async () => {
  const env = createEnv();
  const [limit] = LIMITS.createAccountPerClient;
  for (let i = 0; i < limit; i++) await createAccount(env, { ip: '192.0.2.50' });
  const blocked = await api(env, 'POST', '/v1/accounts', { body: { displayName: 'Spam' }, ip: '192.0.2.50' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, 'too_many_requests');
  assert.ok(Number(blocked.headers.get('Retry-After')) > 0);
  await createAccount(env, { ip: '192.0.2.51' });

  const stored = JSON.stringify(rows(env, 'SELECT key FROM rate_limits'));
  assert.ok(!stored.includes('192.0.2.50'), 'addresses are stored hashed');
});

test('signing in with keys and codes is rate-limited per address', async () => {
  const env = createEnv();
  const [limit] = LIMITS.signInPerClient;
  for (let i = 0; i < limit; i++) {
    assert.equal((await api(env, 'POST', '/v1/sessions', { body: { accountKey: generateAccountKey() }, ip: '192.0.2.60' })).status, 401);
  }
  assert.equal((await api(env, 'POST', '/v1/sessions', { body: { accountKey: generateAccountKey() }, ip: '192.0.2.60' })).status, 429);

  const [pairLimit] = LIMITS.pairPerClient;
  for (let i = 0; i < pairLimit; i++) await api(env, 'POST', '/v1/sessions/pair', { body: { code: 'AAAA-AAAA' }, ip: '192.0.2.61' });
  assert.equal((await api(env, 'POST', '/v1/sessions/pair', { body: { code: 'AAAA-AAAA' }, ip: '192.0.2.61' })).status, 429);
});

// ---------- weekly cleanup ----------

test('the weekly cleanup removes expired sessions and codes and old rate-limit counters', async () => {
  const env = createEnv();
  const { token } = await createAccount(env);
  await api(env, 'POST', '/v1/pairing-codes', { token });
  const counters = rows(env, 'SELECT * FROM rate_limits').length;
  assert.ok(counters > 0);
  const later = new Date(Date.now() + 200 * 24 * 3600 * 1000);
  const result = await runCleanup(env, later);
  assert.deepEqual(result, { sessions: 1, pairingCodes: 1, rateLimits: counters, pushLog: 0, titles: 0, emailCodes: 0 });
  assert.equal(rows(env, 'SELECT * FROM rate_limits').length, 0);
  assert.equal(rows(env, 'SELECT * FROM accounts').length, 1, 'accounts are kept');
});

test('CORS headers let the Android app read rate-limit waits', async () => {
  const env = createEnv();
  const res = await worker.fetch(new Request(`${ORIGIN}/v1/account`, { headers: { Origin: 'https://localhost' } }), env, createCtx());
  assert.equal(res.status, 401);
  assert.match(res.headers.get('Access-Control-Expose-Headers'), /Retry-After/);
});
