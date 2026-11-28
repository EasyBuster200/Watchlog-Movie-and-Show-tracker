// Account keys, session tokens, pairing codes, signing requests in, and rate limits.
//
// ACCOUNT KEY: the account's credential (docs/ROADMAP.md, Phase 3). 27 random characters of
// Crockford base32 (135 bits) plus 1 check character, shown as 7 groups of 4:
// "7KQ2-WLG4-…-…-…-…-…". Crockford base32 has no I, L, O or U, and reading accepts the usual
// mix-ups (O→0, I/L→1), lower case, spaces and dashes. The check character catches a mistyped
// or swapped character before the server is asked. Only a SHA-256 hash of the 27 data
// characters is stored: the key is random and long, so a fast hash is safe (and fits the free
// plan's 10 ms CPU per request, which a password hash wouldn't).
//
// SESSION TOKEN: 32 random bytes (base64url), sent as `Authorization: Bearer <token>`. Stored
// hashed. A session expires SESSION_IDLE_DAYS after it was last used; using it pushes that out.
//
// PAIRING CODE: 8 Crockford characters ("XXXX-XXXX", 40 bits), single use, valid
// PAIRING_CODE_MINUTES. Short enough to type; rate limits make guessing hopeless. Invite codes
// (the admin page) have the same shape, hashed under their own name.
//
// ACCOUNT STATUS: 'active'; 'pending' (asked to join, waiting for the owner's approval: it can
// only check its own account, routes opt in with allowPending); 'suspended' (signed out
// everywhere, and can't sign in).

import { ApiError } from './router.js';

export const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const KEY_DATA_LENGTH = 27;
const PAIRING_CODE_LENGTH = 8;
export const SESSION_IDLE_DAYS = 180;
export const PAIRING_CODE_MINUTES = 10;
// Writing last_used_at on every request would spend D1's daily write allowance for nothing.
const SESSION_TOUCH_EVERY_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function randomChars(count) {
  const bytes = crypto.getRandomValues(new Uint8Array(count));
  // 256 is a multiple of 32, so `& 31` keeps every character equally likely.
  return Array.from(bytes, b => ALPHABET[b & 31]).join('');
}

function checkChar(data) {
  // Weighted sum mod 31 (a prime): any single wrong character, and any two neighbours swapped,
  // change it (except the rare 0↔Z pair, 31 apart).
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += ALPHABET.indexOf(data[i]) * (i + 1);
  return ALPHABET[sum % 31];
}

function groups(text) {
  return text.match(/.{1,4}/g).join('-');
}

export function normalizeCode(input) {
  return String(input || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export function generateAccountKey() {
  const data = randomChars(KEY_DATA_LENGTH);
  return groups(data + checkChar(data));
}

// The key's 27 data characters if it's well formed and its check character matches, else null.
export function accountKeyData(input) {
  const clean = normalizeCode(input);
  if (clean.length !== KEY_DATA_LENGTH + 1) return null;
  if ([...clean].some(c => !ALPHABET.includes(c))) return null;
  const data = clean.slice(0, KEY_DATA_LENGTH);
  return checkChar(data) === clean[KEY_DATA_LENGTH] ? data : null;
}

export function generatePairingCode() {
  return groups(randomChars(PAIRING_CODE_LENGTH));
}

export function pairingCodeData(input) {
  const clean = normalizeCode(input);
  if (clean.length !== PAIRING_CODE_LENGTH || [...clean].some(c => !ALPHABET.includes(c))) return null;
  return clean;
}

export function generateSessionToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Hashes are namespaced so a value of one kind can never match a stored hash of another.
export const hashAccountKey = data => sha256(`account-key:${data}`);
export const hashSessionToken = token => sha256(`session:${token}`);
export const hashPairingCode = code => sha256(`pairing:${code}`);
export const hashInviteCode = code => sha256(`invite:${code}`);

export function nowIso(now = new Date()) {
  return now.toISOString();
}

function sessionExpiry(now) {
  return new Date(now.getTime() + SESSION_IDLE_DAYS * DAY_MS).toISOString();
}

// Creates a session for an account; returns the token (shown to the device once) and its row.
export async function createSession(env, accountId, deviceName, now = new Date()) {
  const token = generateSessionToken();
  const session = {
    id: crypto.randomUUID(),
    accountId,
    deviceName,
    createdAt: nowIso(now),
    lastUsedAt: nowIso(now),
    expiresAt: sessionExpiry(now),
  };
  await env.DB.prepare(
    'INSERT INTO sessions (id, account_id, token_hash, device_name, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(session.id, accountId, await hashSessionToken(token), deviceName, session.createdAt, session.lastUsedAt, session.expiresAt).run();
  return { token, session };
}

function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

const SIGNED_OUT = () => new ApiError(401, 'signed_out', 'This device is signed out. Sign in again.');
export const PENDING = () => new ApiError(403, 'account_pending', 'Your account is waiting for the owner to approve it.');

// Returns { account, session } for the request's session token, or throws a 401 (or a 403 for
// an account still waiting for approval, unless the route allows it).
export async function requireAuth(request, env, { now = new Date(), allowPending = false } = {}) {
  const token = bearerToken(request);
  if (!token) throw SIGNED_OUT();
  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.device_name, s.created_at AS session_created_at, s.last_used_at, s.expires_at,
            a.id AS account_id, a.display_name, a.email, a.created_at AS account_created_at, a.key_changed_at, a.status
       FROM sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.token_hash = ?`
  ).bind(await hashSessionToken(token)).first();
  if (!row || !['active', 'pending'].includes(row.status)) throw SIGNED_OUT();
  if (row.status === 'pending' && !allowPending) throw PENDING();
  if (Date.parse(row.expires_at) <= now.getTime()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(row.session_id).run();
    throw SIGNED_OUT();
  }
  let lastUsedAt = row.last_used_at;
  if (now.getTime() - Date.parse(row.last_used_at) >= SESSION_TOUCH_EVERY_MS) {
    lastUsedAt = nowIso(now);
    await env.DB.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?')
      .bind(lastUsedAt, sessionExpiry(now), row.session_id).run();
  }
  return {
    account: { id: row.account_id, displayName: row.display_name, email: row.email, createdAt: row.account_created_at, keyChangedAt: row.key_changed_at, status: row.status },
    session: { id: row.session_id, deviceName: row.device_name, createdAt: row.session_created_at, lastUsedAt },
  };
}

// Fixed-window rate limit in D1. `key` identifies who is limited (e.g. 'sign-in:ip:<hash>').
// Throws a 429 once `limit` requests were made in the current window of `windowSeconds`.
export async function rateLimit(env, key, limit, windowSeconds, now = new Date()) {
  const windowStart = Math.floor(now.getTime() / 1000 / windowSeconds) * windowSeconds;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
     RETURNING count`
  ).bind(key, windowStart).first();
  if (row && row.count > limit) {
    const retryAfter = windowStart + windowSeconds - Math.floor(now.getTime() / 1000);
    throw new ApiError(429, 'too_many_requests', 'Too many attempts. Wait a little and try again.', { retryAfter });
  }
}

// Who a rate limit is about, without storing the IP address itself.
export async function clientKey(request) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return (await sha256(`ip:${ip}`)).slice(0, 32);
}

// Per-minute burst limits (admin page part 2), on top of each route's hourly/daily limits:
// every route anyone can call without signing in (sign-up, email codes, signing in, pairing,
// recovery) shares one count per address, so a script hammering several of them at once is
// slowed down within a minute instead of an hour.
export const BURST_LIMITS = {
  perClient: [20, 60],
  accountsPerMinute: [10, 60],
  emailsPerMinute: [20, 60],
  friendRequestsPerMinute: [5, 60],
};

export async function burstLimit(env, request) {
  await rateLimit(env, `burst:client:${await clientKey(request)}`, ...BURST_LIMITS.perClient);
}

export function cleanName(value, { max, fallback = null } = {}) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!text) return fallback;
  return text.slice(0, max);
}
