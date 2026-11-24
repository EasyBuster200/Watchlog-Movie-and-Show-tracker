// Online accounts: create one, sign a device in (account key or pairing code), see and change
// the account, make a new key, add a device, list and sign out devices, delete the account.
// See docs/DEVELOPMENT.md ("Accounts API") for the request and response shapes.

import { route, json, noContent, readJson, ApiError } from '../router.js';
import {
  generateAccountKey, accountKeyData, hashAccountKey,
  generatePairingCode, pairingCodeData, hashPairingCode, PAIRING_CODE_MINUTES,
  createSession, requireAuth, rateLimit, clientKey, cleanName, nowIso,
} from '../auth.js';

const NAME_MAX = 40;
const DEVICE_MAX = 60;
const HOUR = 3600;

// Sign-up is open for now (decided with the user, until the admin page has invites), so account
// creation is limited per address and overall.
export const LIMITS = {
  createAccountPerClient: [5, HOUR],
  createAccountTotal: [100, 24 * HOUR],
  signInPerClient: [10, 15 * 60],
  pairPerClient: [10, 15 * 60],
  pairingCodesPerAccount: [10, HOUR],
  newKeyPerAccount: [5, HOUR],
};

const limited = (env, key, [limit, seconds]) => rateLimit(env, key, limit, seconds);

function accountJson(row) {
  return { id: row.id, displayName: row.displayName, createdAt: row.createdAt, keyChangedAt: row.keyChangedAt };
}

function sessionJson(session, currentId) {
  return {
    id: session.id,
    deviceName: session.deviceName,
    createdAt: session.createdAt,
    lastUsedAt: session.lastUsedAt,
    current: session.id === currentId,
  };
}

function deviceNameFrom(body) {
  return cleanName(body.deviceName, { max: DEVICE_MAX, fallback: 'Unknown device' });
}

async function signedInResponse(env, account, deviceName, extra = {}) {
  const { token, session } = await createSession(env, account.id, deviceName);
  return json({ account: accountJson(account), session: sessionJson(session, session.id), token, ...extra }, 201);
}

async function accountByKey(env, data) {
  const row = await env.DB.prepare(
    "SELECT id, display_name AS displayName, created_at AS createdAt, key_changed_at AS keyChangedAt FROM accounts WHERE key_hash = ? AND status = 'active'"
  ).bind(await hashAccountKey(data)).first();
  return row || null;
}

// Create an account. Returns its account key, the only time the server ever sends it.
route('POST', '/accounts', async ({ request, env }) => {
  const body = await readJson(request);
  const displayName = cleanName(body.displayName, { max: NAME_MAX });
  if (!displayName) throw new ApiError(400, 'name_required', 'Enter a name for the account.');
  const client = await clientKey(request);
  await limited(env, `create-account:client:${client}`, LIMITS.createAccountPerClient);
  await limited(env, 'create-account:all', LIMITS.createAccountTotal);

  const accountKey = generateAccountKey();
  const now = nowIso();
  const account = { id: crypto.randomUUID(), displayName, createdAt: now, keyChangedAt: now };
  await env.DB.prepare('INSERT INTO accounts (id, key_hash, display_name, created_at, key_changed_at) VALUES (?, ?, ?, ?, ?)')
    .bind(account.id, await hashAccountKey(accountKeyData(accountKey)), displayName, now, now).run();
  return signedInResponse(env, account, deviceNameFrom(body), { accountKey });
});

// Sign a device in with the account key.
route('POST', '/sessions', async ({ request, env }) => {
  const body = await readJson(request);
  await limited(env, `sign-in:client:${await clientKey(request)}`, LIMITS.signInPerClient);
  const data = accountKeyData(body.accountKey);
  if (!data) throw new ApiError(400, 'invalid_key_format', "That doesn't look like an account key. Check it for typos.");
  const account = await accountByKey(env, data);
  if (!account) throw new ApiError(401, 'wrong_key', 'No account has that key.');
  return signedInResponse(env, account, deviceNameFrom(body));
});

// Sign a device in with a one-time pairing code from a signed-in device.
route('POST', '/sessions/pair', async ({ request, env }) => {
  const body = await readJson(request);
  await limited(env, `pair:client:${await clientKey(request)}`, LIMITS.pairPerClient);
  const code = pairingCodeData(body.code);
  if (!code) throw new ApiError(400, 'invalid_code_format', "That doesn't look like a device code. Check it for typos.");
  const codeHash = await hashPairingCode(code);
  // Claim the code in one statement, so two devices can't both use it.
  const claimed = await env.DB.prepare('DELETE FROM pairing_codes WHERE code_hash = ? RETURNING account_id, expires_at').bind(codeHash).first();
  if (!claimed || Date.parse(claimed.expires_at) <= Date.now()) {
    throw new ApiError(401, 'wrong_code', 'That code is wrong or has expired. Make a new one on your other device.');
  }
  const account = await env.DB.prepare(
    "SELECT id, display_name AS displayName, created_at AS createdAt, key_changed_at AS keyChangedAt FROM accounts WHERE id = ? AND status = 'active'"
  ).bind(claimed.account_id).first();
  if (!account) throw new ApiError(401, 'wrong_code', 'That code is wrong or has expired. Make a new one on your other device.');
  return signedInResponse(env, account, deviceNameFrom(body));
});

route('GET', '/account', async ({ request, env }) => {
  const { account, session } = await requireAuth(request, env);
  return json({ account: accountJson(account), session: sessionJson(session, session.id) });
});

route('PATCH', '/account', async ({ request, env }) => {
  const { account } = await requireAuth(request, env);
  const body = await readJson(request);
  const displayName = cleanName(body.displayName, { max: NAME_MAX });
  if (!displayName) throw new ApiError(400, 'name_required', 'Enter a name for the account.');
  await env.DB.prepare('UPDATE accounts SET display_name = ? WHERE id = ?').bind(displayName, account.id).run();
  return json({ account: accountJson({ ...account, displayName }) });
});

// Deletes the account and everything the server holds for it (sessions, codes).
route('DELETE', '/account', async ({ request, env }) => {
  const { account } = await requireAuth(request, env);
  await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(account.id).run();
  return noContent();
});

// Make a new account key. The old one stops working at once; signed-in devices stay signed in.
route('POST', '/account/key', async ({ request, env }) => {
  const { account } = await requireAuth(request, env);
  await limited(env, `new-key:account:${account.id}`, LIMITS.newKeyPerAccount);
  const accountKey = generateAccountKey();
  const now = nowIso();
  await env.DB.prepare('UPDATE accounts SET key_hash = ?, key_changed_at = ? WHERE id = ?')
    .bind(await hashAccountKey(accountKeyData(accountKey)), now, account.id).run();
  return json({ accountKey, account: accountJson({ ...account, keyChangedAt: now }) });
});

// A one-time code for adding a device. Any earlier unused code for the account stops working.
route('POST', '/pairing-codes', async ({ request, env }) => {
  const { account } = await requireAuth(request, env);
  await limited(env, `pairing-code:account:${account.id}`, LIMITS.pairingCodesPerAccount);
  const code = generatePairingCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PAIRING_CODE_MINUTES * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM pairing_codes WHERE account_id = ?').bind(account.id),
    env.DB.prepare('INSERT INTO pairing_codes (code_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await hashPairingCode(pairingCodeData(code)), account.id, nowIso(now), expiresAt),
  ]);
  return json({ code, expiresAt }, 201);
});

// The account's signed-in devices, most recently used first.
route('GET', '/sessions', async ({ request, env }) => {
  const { account, session } = await requireAuth(request, env);
  const { results } = await env.DB.prepare(
    `SELECT id, device_name AS deviceName, created_at AS createdAt, last_used_at AS lastUsedAt
       FROM sessions WHERE account_id = ? AND expires_at > ? ORDER BY last_used_at DESC`
  ).bind(account.id, nowIso()).all();
  return json({ sessions: results.map(s => sessionJson(s, session.id)) });
});

// Sign out this device.
route('DELETE', '/session', async ({ request, env }) => {
  const { session } = await requireAuth(request, env);
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(session.id).run();
  return noContent();
});

// Sign out one of the account's devices (this one included).
route('DELETE', '/sessions/:id', async ({ request, env, params }) => {
  const { account } = await requireAuth(request, env);
  const result = await env.DB.prepare('DELETE FROM sessions WHERE id = ? AND account_id = ?').bind(params.id, account.id).run();
  if (!result.meta || !result.meta.changes) throw new ApiError(404, 'not_found', 'That device is not signed in to this account.');
  return noContent();
});
