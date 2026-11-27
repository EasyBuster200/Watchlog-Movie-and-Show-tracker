// Turning push notifications on and off for a device (push.js sends them).
//
//   GET    /v1/push/key            -> { publicKey }   (404 push_unavailable when not set up)
//   PUT    /v1/push/subscription   { endpoint, keys: { p256dh, auth }, kinds, timeZone, region }
//          this device's subscription. kinds: { requests, episodes, releases, recap, friends } booleans
//          (without it: sign-up requests only, as the first admin page sent). timeZone is an IANA
//          name, region an ISO 3166-1 code; the hourly job (notifications.js) uses both.
//   DELETE /v1/push/subscription   { endpoint }
//   POST   /v1/push/test           admin only: a test notification to the owner's own devices

import { route, json, noContent, readJson, ApiError } from '../router.js';
import { requireAuth, sha256, nowIso } from '../auth.js';
import { requireAdmin } from '../admin.js';
import { pushConfigured, notifyAccounts, PUSH_KINDS } from '../push.js';
import { validTimeZone } from '../notifications.js';

const MAX_ENDPOINT = 1000;
const MAX_KEY = 200;

function unavailable() {
  return new ApiError(404, 'push_unavailable', "Notifications aren't set up on this server.");
}

function cleanSubscription(body) {
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  let url;
  try { url = new URL(endpoint); } catch (error) { url = null; }
  if (!url || url.protocol !== 'https:' || endpoint.length > MAX_ENDPOINT) throw new ApiError(400, 'invalid_subscription', 'That push subscription is not valid.');
  const keys = body.keys || {};
  const ok = k => typeof k === 'string' && /^[A-Za-z0-9_-]+={0,2}$/.test(k) && k.length <= MAX_KEY;
  if (!ok(keys.p256dh) || !ok(keys.auth)) throw new ApiError(400, 'invalid_subscription', 'That push subscription is not valid.');
  const kinds = body.kinds && typeof body.kinds === 'object' ? body.kinds : { requests: true };
  const flags = {};
  Object.keys(PUSH_KINDS).forEach(kind => { flags[kind] = kinds[kind] === true ? 1 : 0; });
  const timeZone = validTimeZone(body.timeZone) ? body.timeZone : null;
  const region = typeof body.region === 'string' && /^[A-Z]{2}$/.test(body.region) ? body.region : null;
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth, flags, timeZone, region };
}

route('GET', '/push/key', async ({ env }) => {
  if (!pushConfigured(env)) throw unavailable();
  return json({ publicKey: env.VAPID_PUBLIC_KEY });
});

route('PUT', '/push/subscription', async ({ request, env }) => {
  if (!pushConfigured(env)) throw unavailable();
  const { account, session } = await requireAuth(request, env);
  const sub = cleanSubscription(await readJson(request));
  const id = await sha256(`push:${sub.endpoint}`);
  const f = sub.flags;
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (id, account_id, session_id, endpoint, p256dh, auth, created_at,
       notify_requests, notify_episodes, notify_releases, notify_recap, notify_friends, time_zone, region)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET account_id = excluded.account_id, session_id = excluded.session_id, p256dh = excluded.p256dh, auth = excluded.auth,
       notify_requests = excluded.notify_requests, notify_episodes = excluded.notify_episodes, notify_releases = excluded.notify_releases,
       notify_recap = excluded.notify_recap, notify_friends = excluded.notify_friends, time_zone = excluded.time_zone, region = excluded.region`
  ).bind(id, account.id, session.id, sub.endpoint, sub.p256dh, sub.auth, nowIso(), f.requests, f.episodes, f.releases, f.recap, f.friends, sub.timeZone, sub.region).run();
  return json({ ok: true, kinds: { requests: !!f.requests, episodes: !!f.episodes, releases: !!f.releases, recap: !!f.recap, friends: !!f.friends } });
});

route('DELETE', '/push/subscription', async ({ request, env }) => {
  const { account } = await requireAuth(request, env);
  const body = await readJson(request);
  if (typeof body.endpoint !== 'string') throw new ApiError(400, 'invalid_subscription', 'Which subscription?');
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ? AND account_id = ?')
    .bind(await sha256(`push:${body.endpoint}`), account.id).run();
  return noContent();
});

route('POST', '/push/test', async ({ request, env }) => {
  if (!pushConfigured(env)) throw unavailable();
  const { account } = await requireAdmin(request, env);
  const result = await notifyAccounts(env, [account.id], {
    title: 'Watchlog', body: 'Notifications work on this device.', url: '/admin.html', tag: 'test',
  });
  return json(result);
});
