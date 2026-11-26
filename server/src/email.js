// Email (roadmap Phase 3c): one-time codes to verify an address and to recover an account,
// notices about the account (a recovery started or was cancelled, the address changed), and
// an alert to the owner when someone asks to join.
//
// Sent through Resend's API (decided with the user: Cloudflare's own sending is free only to
// addresses verified in the Cloudflare account). Needs the RESEND_API_KEY Worker secret (a key
// with sending access only) and the domain verified in Resend (DNS records on the zone);
// EMAIL_FROM (a var) overrides the sender. Resend's free plan sends 100 a day, so the server
// stops at EMAIL_LIMITS.perDay and says so.
//
// Without the key nothing is sent: requests that need an email answer 503 email_unavailable.
// EMAIL_DEV_LOG = "on" (only ever in .dev.vars) instead logs each email, codes included, so
// sign-up can be tried locally.
//
// Emails are plain text: nothing to render, and nothing for a mail app to block.

import { ApiError } from './router.js';
import { sha256, rateLimit, nowIso } from './auth.js';

const RESEND_API = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'Watchlog <no-reply@watchlogtracker.com>';
export const EMAIL_LIMITS = { perDay: 90 };
export const EMAIL_CODE_MINUTES = 15;
export const EMAIL_CODE_TRIES = 5;
const EMAIL_MAX = 254;

export function normalizeEmail(input) {
  const email = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (!email || email.length > EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return null;
  return email;
}

export const hashEmail = email => sha256(`email:${email}`);
const hashEmailCode = (purpose, emailHash, code) => sha256(`email-code:${purpose}:${emailHash}:${code}`);

function devLog(env) {
  return String(env.EMAIL_DEV_LOG || '').toLowerCase() === 'on';
}

export function emailConfigured(env) {
  return Boolean(env.RESEND_API_KEY) || devLog(env);
}

const UNAVAILABLE = () => new ApiError(503, 'email_unavailable', "Emails can't be sent right now. Try again later.");

// Sends one email ({ to, subject, text }). Throws email_unavailable / email_busy when it can't
// be sent, so a person waiting for a code hears about it; callers that only notify catch it.
export async function sendEmail(env, { to, subject, text }, { fetchImpl = fetch } = {}) {
  if (!emailConfigured(env)) throw UNAVAILABLE();
  try {
    await rateLimit(env, 'email:all', EMAIL_LIMITS.perDay, 24 * 60 * 60);
  } catch (error) {
    throw new ApiError(503, 'email_busy', 'Too many emails went out today. Try again tomorrow.');
  }
  if (!env.RESEND_API_KEY) {
    console.log(`Email (not sent, EMAIL_DEV_LOG) to ${to}: ${subject}\n${text}`);
    return { ok: true, logged: true };
  }
  let response;
  try {
    response = await fetchImpl(RESEND_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM || DEFAULT_FROM, to: [to], subject, text }),
    });
  } catch (error) {
    console.error('Email failed', error && error.message ? error.message : error);
    throw UNAVAILABLE();
  }
  if (!response.ok) {
    console.error('Email refused', response.status, await response.text().catch(() => ''));
    throw UNAVAILABLE();
  }
  return { ok: true };
}

// For notices nobody is waiting on: a failure is logged, never thrown.
export function sendNotice(env, message, options) {
  return sendEmail(env, message, options).catch(error => {
    console.error('Notice email not sent', error && error.code ? error.code : error);
    return { ok: false };
  });
}

function sixDigits() {
  // Rejection sampling keeps every code equally likely.
  const limit = Math.floor(0xffffffff / 1000000) * 1000000;
  for (;;) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0];
    if (n < limit) return String(n % 1000000).padStart(6, '0');
  }
}

// Makes a code for `purpose` and `email` (replacing any earlier one) and returns it.
export async function issueEmailCode(env, purpose, email, accountId = null, now = new Date()) {
  const emailHash = await hashEmail(email);
  const code = sixDigits();
  const expiresAt = new Date(now.getTime() + EMAIL_CODE_MINUTES * 60 * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO email_codes (purpose, email_hash, account_id, code_hash, attempts, created_at, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?)
     ON CONFLICT (purpose, email_hash) DO UPDATE SET account_id = excluded.account_id, code_hash = excluded.code_hash,
       attempts = 0, created_at = excluded.created_at, expires_at = excluded.expires_at`
  ).bind(purpose, emailHash, accountId, await hashEmailCode(purpose, emailHash, code), nowIso(now), expiresAt).run();
  return code;
}

const WRONG_CODE = () => new ApiError(400, 'wrong_email_code', 'That code is wrong or has expired. Ask for a new one.');

// Checks a code and uses it up. Returns its row ({ accountId }). A wrong code counts as a try;
// after EMAIL_CODE_TRIES the code is gone.
export async function useEmailCode(env, purpose, email, code, now = new Date()) {
  const digits = String(code || '').replace(/\D/g, '');
  const emailHash = await hashEmail(email);
  const row = await env.DB.prepare(
    'SELECT account_id AS accountId, code_hash AS codeHash, attempts, expires_at AS expiresAt FROM email_codes WHERE purpose = ? AND email_hash = ?'
  ).bind(purpose, emailHash).first();
  if (!row || Date.parse(row.expiresAt) <= now.getTime() || row.attempts >= EMAIL_CODE_TRIES) throw WRONG_CODE();
  if (digits.length !== 6 || await hashEmailCode(purpose, emailHash, digits) !== row.codeHash) {
    await env.DB.prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE purpose = ? AND email_hash = ?').bind(purpose, emailHash).run();
    throw WRONG_CODE();
  }
  // Delete it in one statement, so the same code can't be used twice at once.
  const used = await env.DB.prepare('DELETE FROM email_codes WHERE purpose = ? AND email_hash = ? AND code_hash = ? RETURNING account_id AS accountId')
    .bind(purpose, emailHash, row.codeHash).first();
  if (!used) throw WRONG_CODE();
  return { accountId: used.accountId, emailHash };
}

// ---------- The emails ----------

const SIGN_OFF = '\n\nWatchlog\nYou get this email because this address was entered in the Watchlog app.';

export function codeEmail(purpose, code) {
  const what = { signup: 'finish making your Watchlog account', change: 'use this address for your Watchlog account', recover: 'recover your Watchlog account' }[purpose];
  return {
    subject: `${code} is your Watchlog code`,
    text: `Your code is ${code}. Enter it in Watchlog to ${what}. It works once, for ${EMAIL_CODE_MINUTES} minutes.\n\nIf you didn't ask for it, ignore this email.${SIGN_OFF}`,
  };
}

export function alreadyHaveAccountEmail() {
  return {
    subject: 'You already have a Watchlog account',
    text: `Someone tried to make a Watchlog account with this address, but it already belongs to an account.\n\nIf it was you and you can't get in, choose "Lost your key?" on the sign-in screen. If it wasn't you, ignore this email.${SIGN_OFF}`,
  };
}

export function recoveryStartedEmail(completesAt) {
  return {
    subject: 'Someone is recovering your Watchlog account',
    text: `A device asked to recover your Watchlog account with a code sent to this address. It gets a new account key on ${new Date(completesAt).toUTCString()}, and every other device is signed out then.\n\nIf this wasn't you, open Watchlog on any device that's signed in to the account and tap Cancel. Nothing changes until then.${SIGN_OFF}`,
  };
}

export function recoveryCancelledEmail() {
  return {
    subject: 'Recovery of your Watchlog account was cancelled',
    text: `A signed-in device cancelled the recovery of your Watchlog account. Your account key hasn't changed.${SIGN_OFF}`,
  };
}

export function emailChangedEmail(newEmail) {
  return {
    subject: 'Your Watchlog email was changed',
    text: `Your Watchlog account's email is now ${newEmail}. This address won't get its emails any more.\n\nIf you didn't do this, open Watchlog on a signed-in device and change it back, or make a new account key in Settings.${SIGN_OFF}`,
  };
}

export function joinRequestEmail({ displayName, note, email, adminUrl }) {
  return {
    subject: `${displayName} wants to join Watchlog`,
    text: `${displayName} (${email}) asked to join your Watchlog.\n\n${note ? `Their note: "${note}"\n\n` : ''}Approve or decline: ${adminUrl}${SIGN_OFF}`,
  };
}
