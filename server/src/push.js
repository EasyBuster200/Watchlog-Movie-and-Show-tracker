// Web Push to people's devices (roadmap Phase 6's foundation, built with the admin page): the
// owner's devices hear about new sign-up requests. The sending itself (encryption, VAPID) is in
// webpush.js.
//
// Needs the VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY Worker secrets (tools/make-vapid-keys.mjs
// makes a pair; both are secrets so a deploy never drops them), and optionally VAPID_SUBJECT (a
// contact address for push services: an https:// or mailto: URL; the repository's address by
// default). Without the keys nothing is sent, and the admin page says so.
//
// A subscription belongs to one signed-in device (push_subscriptions.session_id), so signing
// that device out removes it. Push services answer 404/410 for a subscription that's gone (app
// uninstalled, permission withdrawn); those are deleted.

import { sendWebPush } from './webpush.js';
import { adminIds } from './admin.js';

const DEFAULT_SUBJECT = 'https://github.com/EasyBuster200/Watchlog-Movie-and-Show-tracker';

export function pushConfigured(env) {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

function vapidFor(env) {
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || DEFAULT_SUBJECT };
}

// Sends `message` ({ title, body, url, tag }) to every device of these accounts that turned
// notifications on. Resolves { sent, removed }.
export async function notifyAccounts(env, accountIds, message) {
  if (!pushConfigured(env) || !accountIds.length) return { sent: 0, removed: 0 };
  const placeholders = accountIds.map(() => '?').join(', ');
  const { results } = await env.DB.prepare(
    `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE account_id IN (${placeholders})`
  ).bind(...accountIds).all();
  let sent = 0;
  let removed = 0;
  const payload = JSON.stringify(message);
  for (const sub of results) {
    try {
      const result = await sendWebPush({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload, vapidFor(env), { topic: message.tag ? message.tag.slice(0, 32) : undefined });
      if (result.gone) {
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run();
        removed++;
      } else if (result.ok) {
        sent++;
      } else {
        console.error('Push refused', result.status, new URL(sub.endpoint).host);
      }
    } catch (error) {
      console.error('Push failed', error && error.message ? error.message : error);
    }
  }
  return { sent, removed };
}

export function notifyAdmins(env, message) {
  return notifyAccounts(env, adminIds(env), message);
}
