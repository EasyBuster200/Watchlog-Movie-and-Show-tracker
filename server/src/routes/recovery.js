// Recovering an account with its email (roadmap Phase 3c), for when the key and every signed-in
// device are lost:
//
//   POST   /v1/recovery/code       { email }                  a code to the address (same answer
//                                                             whether or not it has an account)
//   POST   /v1/recovery            { email, code, deviceName } -> { recoveryToken, completesAt, displayName }
//   POST   /v1/recovery/complete   { recoveryToken, deviceName } -> { account, session, token, accountKey }
//                                  (409 recovery_waiting until completesAt)
//   DELETE /v1/account/recovery    a signed-in device cancels it
//
// The hold (decided with the user: 24 hours) guards against a hacked inbox: meanwhile the
// address is told, the account's devices get a push notification and a banner (each sync reply
// and GET /v1/account carry `recovery`), and any of them can cancel. Completing it makes a new
// account key (the old one stops working) and signs every other device out.

import { route, json, noContent, readJson, ApiError } from '../router.js';
import {
  generateAccountKey, accountKeyData, hashAccountKey, generateSessionToken, sha256,
  createSession, requireAuth, rateLimit, clientKey, cleanName, nowIso,
} from '../auth.js';
import {
  normalizeEmail, hashEmail, sendEmail, sendNotice, issueEmailCode, useEmailCode,
  codeEmail, recoveryStartedEmail, recoveryCancelledEmail,
} from '../email.js';
import { notifyAccounts } from '../push.js';
import { accountJson, ACCOUNT_COLUMNS } from './accounts.js';

export const RECOVERY_HOLD_HOURS = 24;
const HOUR = 3600;
const DEVICE_MAX = 60;

export const RECOVERY_LIMITS = {
  codesPerClient: [5, HOUR],
  codesPerAddress: [3, HOUR],
  startsPerClient: [10, HOUR],
  completesPerClient: [30, HOUR],
};

const limited = (env, key, [limit, seconds]) => rateLimit(env, key, limit, seconds);
const hashRecoveryToken = token => sha256(`recovery:${token}`);
const INVALID_EMAIL = () => new ApiError(400, 'invalid_email', "That doesn't look like an email address.");

route('POST', '/recovery/code', async ({ request, env }) => {
  const email = normalizeEmail((await readJson(request)).email);
  if (!email) throw INVALID_EMAIL();
  await limited(env, `recovery-code:client:${await clientKey(request)}`, RECOVERY_LIMITS.codesPerClient);
  await limited(env, `recovery-code:address:${await hashEmail(email)}`, RECOVERY_LIMITS.codesPerAddress);
  const account = await env.DB.prepare("SELECT id FROM accounts WHERE email_hash = ? AND status != 'suspended'")
    .bind(await hashEmail(email)).first();
  if (account) {
    const code = await issueEmailCode(env, 'recover', email, account.id);
    await sendEmail(env, { to: email, ...codeEmail('recover', code) });
  }
  return json({ sent: true });
});

route('POST', '/recovery', async ({ request, env, ctx }) => {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  if (!email) throw INVALID_EMAIL();
  await limited(env, `recovery:client:${await clientKey(request)}`, RECOVERY_LIMITS.startsPerClient);
  const { accountId } = await useEmailCode(env, 'recover', email, body.code);
  const account = await env.DB.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`).bind(accountId).first();
  if (!account || account.status === 'suspended') throw new ApiError(400, 'wrong_email_code', 'That code is wrong or has expired. Ask for a new one.');

  const token = generateSessionToken();
  const now = new Date();
  const completesAt = new Date(now.getTime() + RECOVERY_HOLD_HOURS * HOUR * 1000).toISOString();
  // A new recovery replaces an earlier one (its device can't finish it any more).
  await env.DB.prepare(
    `INSERT INTO recoveries (account_id, token_hash, device_name, requested_at, completes_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (account_id) DO UPDATE SET token_hash = excluded.token_hash, device_name = excluded.device_name,
       requested_at = excluded.requested_at, completes_at = excluded.completes_at`
  ).bind(account.id, await hashRecoveryToken(token), cleanName(body.deviceName, { max: DEVICE_MAX, fallback: 'Unknown device' }), nowIso(now), completesAt).run();

  const warn = Promise.all([
    sendNotice(env, { to: account.email, ...recoveryStartedEmail(completesAt) }),
    notifyAccounts(env, [account.id], {
      title: 'Someone is recovering your Watchlog account',
      body: 'Not you? Open Watchlog and tap Cancel.',
      url: '/settings.html',
      tag: 'recovery',
    }).catch(error => console.error('Recovery push failed', error && error.message ? error.message : error)),
  ]);
  if (ctx && ctx.waitUntil) ctx.waitUntil(warn); else await warn;
  return json({ recoveryToken: token, completesAt, displayName: account.displayName }, 201);
});

route('POST', '/recovery/complete', async ({ request, env }) => {
  const body = await readJson(request);
  await limited(env, `recovery-complete:client:${await clientKey(request)}`, RECOVERY_LIMITS.completesPerClient);
  const token = typeof body.recoveryToken === 'string' ? body.recoveryToken : '';
  const row = token && await env.DB.prepare('SELECT account_id AS accountId, completes_at AS completesAt FROM recoveries WHERE token_hash = ?')
    .bind(await hashRecoveryToken(token)).first();
  if (!row) throw new ApiError(404, 'recovery_cancelled', 'This recovery was cancelled, replaced by a newer one, or already finished.');
  if (Date.parse(row.completesAt) > Date.now()) {
    throw new ApiError(409, 'recovery_waiting', `Your account will be ready on ${new Date(row.completesAt).toUTCString()}.`);
  }
  // Take the row in one statement, so it can only be finished once.
  const taken = await env.DB.prepare('DELETE FROM recoveries WHERE token_hash = ? RETURNING account_id').bind(await hashRecoveryToken(token)).first();
  if (!taken) throw new ApiError(404, 'recovery_cancelled', 'This recovery was cancelled, replaced by a newer one, or already finished.');
  const account = await env.DB.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ?`).bind(row.accountId).first();
  if (!account || account.status === 'suspended') throw new ApiError(403, 'account_suspended', 'This account is suspended. Ask the owner of this Watchlog.');

  const accountKey = generateAccountKey();
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare('UPDATE accounts SET key_hash = ?, key_changed_at = ? WHERE id = ?').bind(await hashAccountKey(accountKeyData(accountKey)), now, account.id),
    env.DB.prepare('DELETE FROM sessions WHERE account_id = ?').bind(account.id),
    env.DB.prepare('DELETE FROM pairing_codes WHERE account_id = ?').bind(account.id),
  ]);
  const deviceName = cleanName(body.deviceName, { max: DEVICE_MAX, fallback: 'Unknown device' });
  const { token: sessionToken, session } = await createSession(env, account.id, deviceName);
  return json({
    account: accountJson({ ...account, keyChangedAt: now }),
    session: { id: session.id, deviceName: session.deviceName, createdAt: session.createdAt, lastUsedAt: session.lastUsedAt, current: true },
    token: sessionToken,
    accountKey,
  }, 201);
});

route('DELETE', '/account/recovery', async ({ request, env }) => {
  const { account } = await requireAuth(request, env, { allowPending: true });
  const result = await env.DB.prepare('DELETE FROM recoveries WHERE account_id = ?').bind(account.id).run();
  if (result.meta && result.meta.changes && account.email) await sendNotice(env, { to: account.email, ...recoveryCancelledEmail() });
  return noContent();
});
