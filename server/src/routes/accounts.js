// Online accounts: create one (or ask to join), sign a device in (account key or pairing code),
// see and change the account, make a new key, add a device, list and sign out devices, delete
// the account. See docs/DEVELOPMENT.md ("Accounts API") for the request and response shapes.
//
// Who may create an account depends on the admin page's sign-up mode (settings.js). In
// 'approval' mode an account without an invite code starts 'pending': it gets its key and a
// session like any account, but can only check on itself until the owner approves it, and the
// owner's devices get a push notification (push.js) and an email (email.js).
//
// Every account has a verified email (roadmap Phase 3c): sign-up first asks for a code sent to
// it (POST /email-codes), and POST /accounts needs that code. The address can be changed later
// (POST /account/email-code, then PUT /account/email). Recovery with it is in recovery.js.

import { route, json, noContent, readJson, ApiError } from '../router.js';
import {
  generateAccountKey, accountKeyData, hashAccountKey,
  generatePairingCode, pairingCodeData, hashPairingCode, hashInviteCode, PAIRING_CODE_MINUTES,
  createSession, requireAuth, rateLimit, clientKey, cleanName, nowIso,
} from '../auth.js';
import { getSettings } from '../settings.js';
import { isAdmin, adminIds } from '../admin.js';
import { notifyAdmins } from '../push.js';
import {
  normalizeEmail, hashEmail, sendEmail, sendNotice, issueEmailCode, useEmailCode,
  codeEmail, alreadyHaveAccountEmail, emailChangedEmail, joinRequestEmail,
} from '../email.js';

const NAME_MAX = 40;
const DEVICE_MAX = 60;
const NOTE_MAX = 200;
const HOUR = 3600;

// Account creation is limited per address and overall, whatever the sign-up mode.
export const LIMITS = {
  createAccountPerClient: [5, HOUR],
  createAccountTotal: [100, 24 * HOUR],
  signInPerClient: [10, 15 * 60],
  pairPerClient: [10, 15 * 60],
  pairingCodesPerAccount: [10, HOUR],
  newKeyPerAccount: [5, HOUR],
  emailCodesPerClient: [10, HOUR],
  emailCodesPerAddress: [5, HOUR],
  emailChangesPerAccount: [5, HOUR],
};

const limited = (env, key, [limit, seconds]) => rateLimit(env, key, limit, seconds);

export function accountJson(row) {
  return { id: row.id, displayName: row.displayName, email: row.email || null, createdAt: row.createdAt, keyChangedAt: row.keyChangedAt, status: row.status || 'active' };
}

export const ACCOUNT_COLUMNS = 'id, display_name AS displayName, email, created_at AS createdAt, key_changed_at AS keyChangedAt, status';

const INVALID_EMAIL = () => new ApiError(400, 'invalid_email', "That doesn't look like an email address.");
const EMAIL_TAKEN = () => new ApiError(409, 'email_taken', 'Another account already uses that email. If it is yours, choose "Lost your key?" to get back in.');

async function accountIdByEmail(env, email) {
  const row = await env.DB.prepare('SELECT id FROM accounts WHERE email_hash = ?').bind(await hashEmail(email)).first();
  return row ? row.id : null;
}

// The owner's email alert about a request to join (on top of the push notification).
async function emailAdminsAboutRequest(env, request, { displayName, note, email }) {
  const ids = adminIds(env);
  if (!ids.length) return;
  const { results } = await env.DB.prepare(`SELECT email FROM accounts WHERE email IS NOT NULL AND id IN (${ids.map(() => '?').join(', ')})`).bind(...ids).all();
  const adminUrl = `${new URL(request.url).origin}/admin.html#requests`;
  for (const row of results) await sendNotice(env, { to: row.email, ...joinRequestEmail({ displayName, note, email, adminUrl }) });
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
  const row = await env.DB.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE key_hash = ?`).bind(await hashAccountKey(data)).first();
  return row || null;
}

const SUSPENDED = () => new ApiError(403, 'account_suspended', 'This account is suspended. Ask the owner of this Watchlog.');

async function isFirstAccount(env) {
  return !(await env.DB.prepare('SELECT 1 FROM accounts LIMIT 1').first());
}

// The sign-up mode that applies right now: the very first account always gets in.
async function signupMode(env) {
  if (await isFirstAccount(env)) return { mode: 'open', firstAccount: true };
  return { mode: (await getSettings(env)).signupMode, firstAccount: false };
}

// The invite row for a code, if it can still be used.
async function usableInvite(env, code, now) {
  const data = pairingCodeData(code);
  if (!data) return null;
  const row = await env.DB.prepare('SELECT id FROM invites WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?')
    .bind(await hashInviteCode(data), now).first();
  return row || null;
}

// What the sign-up screen should ask for.
route('GET', '/signup', async ({ env }) => {
  return json(await signupMode(env));
});

// Sign-up step 1: a code to the address. If it already belongs to an account, that address gets
// a note saying so instead, and the answer is the same (so nobody learns who has an account).
route('POST', '/email-codes', async ({ request, env }) => {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  if (!email) throw INVALID_EMAIL();
  if (body.purpose !== undefined && body.purpose !== 'signup') throw new ApiError(400, 'invalid_purpose', 'Unknown code purpose.');
  await limited(env, `email-code:client:${await clientKey(request)}`, LIMITS.emailCodesPerClient);
  await limited(env, `email-code:address:${await hashEmail(email)}`, LIMITS.emailCodesPerAddress);
  if (await accountIdByEmail(env, email)) {
    await sendEmail(env, { to: email, ...alreadyHaveAccountEmail() });
  } else {
    const code = await issueEmailCode(env, 'signup', email);
    await sendEmail(env, { to: email, ...codeEmail('signup', code) });
  }
  return json({ sent: true });
});

// Create an account (or, in 'approval' mode without an invite, ask to join). Returns its account
// key, the only time the server ever sends it.
route('POST', '/accounts', async ({ request, env, ctx }) => {
  const body = await readJson(request);
  const displayName = cleanName(body.displayName, { max: NAME_MAX });
  if (!displayName) throw new ApiError(400, 'name_required', 'Enter a name for the account.');
  const client = await clientKey(request);
  await limited(env, `create-account:client:${client}`, LIMITS.createAccountPerClient);
  await limited(env, 'create-account:all', LIMITS.createAccountTotal);

  const now = nowIso();
  const { mode } = await signupMode(env);
  const inviteCode = typeof body.inviteCode === 'string' && body.inviteCode.trim() ? body.inviteCode : null;
  let invite = null;
  if (mode === 'closed') throw new ApiError(403, 'signup_closed', "Sign-ups are closed right now. Ask the owner of this Watchlog.");
  if (inviteCode && mode !== 'open') {
    invite = await usableInvite(env, inviteCode, now);
    if (!invite) throw new ApiError(400, 'wrong_invite', 'That invite code is wrong, used or expired. Ask for a new one.');
  }
  if (mode === 'invite' && !invite) throw new ApiError(403, 'invite_required', 'You need an invite code to make an account.');
  const status = mode === 'approval' && !invite ? 'pending' : 'active';
  const requestNote = status === 'pending' ? cleanName(body.note, { max: NOTE_MAX }) : null;

  // The email, proven by the code sent to it (POST /email-codes).
  const email = normalizeEmail(body.email);
  if (!email) throw INVALID_EMAIL();
  const { emailHash } = await useEmailCode(env, 'signup', email, body.emailCode);
  if (await accountIdByEmail(env, email)) throw EMAIL_TAKEN();

  const accountKey = generateAccountKey();
  const account = { id: crypto.randomUUID(), displayName, email, createdAt: now, keyChangedAt: now, status };
  try {
    await env.DB.prepare(`INSERT INTO accounts (id, key_hash, display_name, status, request_note, created_at, key_changed_at, email, email_hash, email_verified_at)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(account.id, await hashAccountKey(accountKeyData(accountKey)), displayName, status, requestNote, now, now, email, emailHash, now).run();
  } catch (error) {
    if (/UNIQUE/i.test(String(error && error.message))) throw EMAIL_TAKEN();
    throw error;
  }

  if (invite) {
    // Claim the invite only if it's still unused: two sign-ups racing for one code can't both win.
    const claimed = await env.DB.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL')
      .bind(now, account.id, invite.id).run();
    if (!claimed.meta || !claimed.meta.changes) {
      await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(account.id).run();
      throw new ApiError(400, 'wrong_invite', 'That invite code was just used. Ask for a new one.');
    }
  }
  if (status === 'pending') {
    const notify = notifyAdmins(env, {
      title: 'Someone wants to join Watchlog',
      body: requestNote ? `${displayName}: "${requestNote}"` : displayName,
      url: '/admin.html#requests',
      tag: 'signup-requests',
    }).catch(error => console.error('Push to the owner failed', error && error.stack ? error.stack : error));
    const mail = emailAdminsAboutRequest(env, request, { displayName, note: requestNote, email })
      .catch(error => console.error('Email to the owner failed', error && error.stack ? error.stack : error));
    if (ctx && ctx.waitUntil) { ctx.waitUntil(notify); ctx.waitUntil(mail); } else await Promise.all([notify, mail]);
  }
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
  if (account.status === 'suspended') throw SUSPENDED();
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
  const account = await env.DB.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = ? AND status = 'active'`).bind(claimed.account_id).first();
  if (!account) throw new ApiError(401, 'wrong_code', 'That code is wrong or has expired. Make a new one on your other device.');
  return signedInResponse(env, account, deviceNameFrom(body));
});

// Also how a device waiting for approval checks on itself (account.status).
route('GET', '/account', async ({ request, env }) => {
  const { account, session } = await requireAuth(request, env, { allowPending: true });
  const recovery = await env.DB.prepare('SELECT completes_at AS completesAt FROM recoveries WHERE account_id = ?').bind(account.id).first();
  return json({
    account: accountJson(account), session: sessionJson(session, session.id), isAdmin: isAdmin(env, account.id),
    recovery: recovery ? { completesAt: recovery.completesAt } : null,
  });
});

// Changing the email, step 1: a code to the new address.
route('POST', '/account/email-code', async ({ request, env }) => {
  const { account } = await requireAuth(request, env, { allowPending: true });
  const email = normalizeEmail((await readJson(request)).email);
  if (!email) throw INVALID_EMAIL();
  await limited(env, `email-change:account:${account.id}`, LIMITS.emailChangesPerAccount);
  const owner = await accountIdByEmail(env, email);
  if (owner === account.id) throw new ApiError(400, 'same_email', 'That is already your email.');
  if (owner) throw EMAIL_TAKEN();
  const code = await issueEmailCode(env, 'change', email, account.id);
  await sendEmail(env, { to: email, ...codeEmail('change', code) });
  return json({ sent: true });
});

// Changing the email, step 2: the code proves the new address. The old one is told.
route('PUT', '/account/email', async ({ request, env }) => {
  const { account } = await requireAuth(request, env, { allowPending: true });
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  if (!email) throw INVALID_EMAIL();
  const { accountId, emailHash } = await useEmailCode(env, 'change', email, body.code);
  if (accountId !== account.id) throw new ApiError(400, 'wrong_email_code', 'That code is wrong or has expired. Ask for a new one.');
  const now = nowIso();
  try {
    await env.DB.prepare('UPDATE accounts SET email = ?, email_hash = ?, email_verified_at = ? WHERE id = ?').bind(email, emailHash, now, account.id).run();
  } catch (error) {
    if (/UNIQUE/i.test(String(error && error.message))) throw EMAIL_TAKEN();
    throw error;
  }
  if (account.email && account.email !== email) await sendNotice(env, { to: account.email, ...emailChangedEmail(email) });
  return json({ account: accountJson({ ...account, email }) });
});

route('PATCH', '/account', async ({ request, env }) => {
  const { account } = await requireAuth(request, env);
  const body = await readJson(request);
  const displayName = cleanName(body.displayName, { max: NAME_MAX });
  if (!displayName) throw new ApiError(400, 'name_required', 'Enter a name for the account.');
  await env.DB.prepare('UPDATE accounts SET display_name = ? WHERE id = ?').bind(displayName, account.id).run();
  return json({ account: accountJson({ ...account, displayName }) });
});

// Deletes the account and everything the server holds for it (sessions, codes). Someone waiting
// for approval can withdraw their request this way too.
route('DELETE', '/account', async ({ request, env }) => {
  const { account } = await requireAuth(request, env, { allowPending: true });
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
  const { session } = await requireAuth(request, env, { allowPending: true });
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
