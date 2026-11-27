// Web Push to people's devices (roadmap Phase 6): the owner's devices hear about new sign-up
// requests (notifyAdmins), and the hourly job (notifications.js) sends new episodes, release
// reminders and the weekly recap. The sending itself (encryption, VAPID) is in webpush.js.
//
// Needs the VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY Worker secrets (tools/make-vapid-keys.mjs
// makes a pair; both are secrets so a deploy never drops them), and optionally VAPID_SUBJECT (a
// contact address for push services: an https:// or mailto: URL; the repository's address by
// default). Without the keys nothing is sent, and the admin page says so.
//
// A subscription belongs to one signed-in device (push_subscriptions.session_id), so signing
// that device out removes it. Each says which kinds it wants (notify_requests, notify_episodes,
// notify_releases, notify_recap, notify_friends). Push services answer 404/410 for a subscription that's gone
// (app uninstalled, permission withdrawn); those are deleted.

import { sendWebPush } from './webpush.js';
import { adminIds } from './admin.js';

const DEFAULT_SUBJECT = 'https://github.com/EasyBuster200/Watchlog-Movie-and-Show-tracker';

// The kinds a device can switch on, and their columns.
export const PUSH_KINDS = {
  requests: 'notify_requests',
  episodes: 'notify_episodes',
  releases: 'notify_releases',
  recap: 'notify_recap',
  friends: 'notify_friends',
};

export function pushConfigured(env) {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

function vapidFor(env) {
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || DEFAULT_SUBJECT };
}

// Sends one message ({ title, body, url, tag }) to one subscription row. Resolves 'sent',
// 'gone' (the row is deleted) or 'failed'.
export async function sendToSubscription(env, sub, message, { fetchImpl } = {}) {
  try {
    const result = await sendWebPush(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(message),
      vapidFor(env),
      { topic: message.tag ? message.tag.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 32) : undefined, fetchImpl }
    );
    if (result.gone) {
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run();
      return 'gone';
    }
    if (result.ok) return 'sent';
    console.error('Push refused', result.status, new URL(sub.endpoint).host);
  } catch (error) {
    console.error('Push failed', error && error.message ? error.message : error);
  }
  return 'failed';
}

// Sends `message` to every device of these accounts that has notifications on (only those that
// want `kind`, when given). Resolves { sent, removed }.
export async function notifyAccounts(env, accountIds, message, { kind = null } = {}) {
  if (!pushConfigured(env) || !accountIds.length) return { sent: 0, removed: 0 };
  const placeholders = accountIds.map(() => '?').join(', ');
  const column = kind ? PUSH_KINDS[kind] : null;
  const { results } = await env.DB.prepare(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE account_id IN (${placeholders})${column ? ` AND ${column} = 1` : ''}`
  ).bind(...accountIds).all();
  let sent = 0;
  let removed = 0;
  for (const sub of results) {
    const outcome = await sendToSubscription(env, sub, message);
    if (outcome === 'sent') sent++;
    else if (outcome === 'gone') removed++;
  }
  return { sent, removed };
}

export function notifyAdmins(env, message) {
  return notifyAccounts(env, adminIds(env), message, { kind: 'requests' });
}
