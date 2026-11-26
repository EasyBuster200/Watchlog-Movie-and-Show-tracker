import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { generateVapidKeys, base64UrlEncode } from '../src/webpush.js';
import { runNotifications, localClock, NOTIFY_LIMITS, regionalRelease } from '../src/notifications.js';
import { createEnv, createCtx, ORIGIN } from './helpers.js';

async function api(env, method, path, { body, token, ip = '203.0.113.7' } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctx = createCtx();
  const response = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await Promise.all(ctx.waits);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function browserSubscription(endpoint) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const p256dh = base64UrlEncode(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { endpoint, keys: { p256dh, auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))) } };
}

let ipCount = 20;
async function setup() {
  const vapid = await generateVapidKeys();
  const env = createEnv({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, TMDB_TOKEN: 'tmdb-token' });
  return env;
}

async function person(env, name) {
  const made = await api(env, 'POST', '/v1/accounts', { body: { displayName: name, deviceName: 'Phone' }, ip: `203.0.113.${ipCount++}` });
  return { id: made.body.account.id, token: made.body.token };
}

async function subscribe(env, who, endpoint, { kinds, timeZone = 'Europe/Lisbon', region = 'PT' } = {}) {
  return api(env, 'PUT', '/v1/push/subscription', { token: who.token, body: { ...(await browserSubscription(endpoint)), kinds, timeZone, region } });
}

let seq = 1;
function record(env, who, kind, key, data, updatedAt = '2026-11-30T12:00:00.000Z') {
  env.DB.sqlite.prepare('INSERT INTO sync_records (account_id, kind, record_key, data, deleted, updated_at, seq) VALUES (?, ?, ?, ?, 0, ?, ?)')
    .run(who.id, kind, key, JSON.stringify(data), updatedAt, seq++);
}
const watchedEpisode = (env, who, showId, s, e, watchedAt = '2026-11-30T12:00:00.000Z') =>
  record(env, who, 'watched_episode', `${showId}:${s}:${e}`, { showId, seasonNumber: s, episodeNumber: e, watchedAt }, watchedAt);
const onWatchlist = (env, who, movieId) =>
  record(env, who, 'list_item', `watchlist:movie:${movieId}`, { list: 'watchlist', mediaType: 'movie', tmdbId: movieId, addedAt: '2026-11-01T00:00:00.000Z' });

// A fake TMDB plus push services: TMDB answers from `tmdb` by path; push endpoints answer 201,
// or 410 when they end in /gone. Everything asked is recorded.
function fakeNetwork(tmdb) {
  const calls = { tmdb: [], push: [] };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.host === 'api.themoviedb.org') {
      const path = u.pathname.replace(/^\/3/, '') + u.search;
      calls.tmdb.push(path);
      assert.equal(init.headers.Authorization, 'Bearer tmdb-token');
      const body = tmdb[path];
      return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response('{}', { status: 404 });
    }
    calls.push.push(String(url));
    return new Response(null, { status: u.pathname.endsWith('/gone') ? 410 : 201 });
  };
  return { calls, fetchImpl };
}

const show = (id, name, next, extra = {}) => ({ id, name, status: 'Returning Series', episode_run_time: [50], next_episode_to_air: next, ...extra });
const nextEp = (date, season, episode, name = `Episode ${episode}`) => ({ air_date: date, season_number: season, episode_number: episode, name });

test('local time in a device time zone', () => {
  assert.deepEqual(localClock('Europe/Lisbon', new Date('2026-12-03T18:30:00Z')), { date: '2026-12-03', hour: 18, weekday: 'Thu' });
  assert.deepEqual(localClock('America/New_York', new Date('2026-12-03T03:30:00Z')), { date: '2026-12-02', hour: 22, weekday: 'Wed' });
  assert.deepEqual(localClock('Asia/Kolkata', new Date('2026-12-03T12:30:00Z')), { date: '2026-12-03', hour: 18, weekday: 'Thu' });
  assert.equal(localClock('Not/AZone', new Date('2026-12-03T18:30:00Z')).hour, 18, 'unknown zones count as UTC');
});

test('subscriptions keep what the device asked for; old ones only hear about sign-up requests', async () => {
  const env = await setup();
  const ana = await person(env, 'Ana');
  const answer = await subscribe(env, ana, 'https://push.example/a', { kinds: { episodes: true, recap: true }, timeZone: 'Bad/Zone', region: 'pt' });
  assert.deepEqual(answer.body.kinds, { requests: false, episodes: true, releases: false, recap: true });
  let row = env.DB.sqlite.prepare('SELECT * FROM push_subscriptions').get();
  assert.equal(row.time_zone, null);
  assert.equal(row.region, null);
  await api(env, 'PUT', '/v1/push/subscription', { token: ana.token, body: await browserSubscription('https://push.example/old') });
  row = env.DB.sqlite.prepare("SELECT * FROM push_subscriptions WHERE endpoint = 'https://push.example/old'").get();
  assert.deepEqual([row.notify_requests, row.notify_episodes, row.notify_releases, row.notify_recap], [1, 0, 0, 0]);
});

test("a new episode is sent from 18:00 in the device's own time zone, once", async () => {
  const env = await setup();
  const ana = await person(env, 'Ana');
  await subscribe(env, ana, 'https://push.example/lisbon', { kinds: { episodes: true } });
  await subscribe(env, ana, 'https://push.example/newyork', { kinds: { episodes: true }, timeZone: 'America/New_York' });
  watchedEpisode(env, ana, 1399, 1, 1);
  watchedEpisode(env, ana, 1399, 1, 2);
  watchedEpisode(env, ana, 2000, 1, 1);
  const net = fakeNetwork({
    '/tv/1399': show(1399, 'Dragons', nextEp('2026-12-03', 2, 3, 'The Return')),
    '/tv/2000': show(2000, 'Later Show', nextEp('2026-12-10', 1, 2)),
  });

  // 17:00 in Lisbon: titles are fetched, nothing is due yet.
  let result = await runNotifications(env, { now: new Date('2026-12-03T17:00:00Z'), fetchImpl: net.fetchImpl });
  assert.deepEqual(net.calls.tmdb.sort(), ['/tv/1399', '/tv/2000']);
  assert.equal(result.sent, 0);

  // 18:00 in Lisbon (13:00 in New York): only Lisbon gets it. Nothing is fetched again.
  result = await runNotifications(env, { now: new Date('2026-12-03T18:00:00Z'), fetchImpl: net.fetchImpl });
  assert.equal(net.calls.tmdb.length, 2);
  assert.deepEqual(net.calls.push, ['https://push.example/lisbon']);

  // Later the same evening: Lisbon isn't sent it again; New York gets it at its own 18:00.
  await runNotifications(env, { now: new Date('2026-12-03T23:00:00Z'), fetchImpl: net.fetchImpl });
  assert.deepEqual(net.calls.push, ['https://push.example/lisbon', 'https://push.example/newyork']);
  const log = env.DB.sqlite.prepare('SELECT tag FROM push_log').all().map(r => r.tag);
  assert.deepEqual(log, ['ep:1399:2:3', 'ep:1399:2:3']);

  // Once it has aired, the show is asked about again for the following episode.
  await runNotifications(env, { now: new Date('2026-12-05T10:00:00Z'), fetchImpl: net.fetchImpl });
  assert.ok(net.calls.tmdb.filter(p => p === '/tv/1399').length >= 2);
});

test('the episode message, and devices that only want other kinds get nothing', async () => {
  const env = await setup();
  const ana = await person(env, 'Ana');
  await subscribe(env, ana, 'https://push.example/eps', { kinds: { episodes: true } });
  await subscribe(env, ana, 'https://push.example/requests-only', { kinds: { requests: true } });
  watchedEpisode(env, ana, 1399, 1, 1);
  const net = fakeNetwork({ '/tv/1399': show(1399, 'Dragons', nextEp('2026-12-03', 2, 3, 'The Return')) });
  const sent = [];
  const original = net.fetchImpl;
  // Capture what was sent (encrypted on the wire, so check the run's due list via the log and count).
  const result = await runNotifications(env, { now: new Date('2026-12-03T19:00:00Z'), fetchImpl: async (url, init) => { sent.push(String(url)); return original(url, init); } });
  assert.equal(result.sent, 1);
  assert.ok(!sent.includes('https://push.example/requests-only'));
  const { episodeMessage } = await import('../src/notifications.js');
  assert.deepEqual(episodeMessage(1399, { name: 'Dragons', next: { season: 2, episode: 3, name: 'The Return' } }),
    { title: 'Dragons', body: 'New episode today: S2E3 · The Return', url: 'detail.html?type=tv&id=1399', tag: 'ep-1399' });
  assert.equal(episodeMessage(1, { name: 'X', next: { season: 1, episode: 4, name: 'Episode 4' } }).body, 'New episode today: S1E4');
});

test("release reminders follow the device's region: cinemas first, else streaming", async () => {
  const env = await setup();
  const ana = await person(env, 'Ana');
  const rui = await person(env, 'Rui');
  await subscribe(env, ana, 'https://push.example/pt', { kinds: { releases: true }, region: 'PT' });
  await subscribe(env, rui, 'https://push.example/us', { kinds: { releases: true }, region: 'US' });
  onWatchlist(env, ana, 550);
  onWatchlist(env, rui, 550);
  const releaseDates = { results: [
    { iso_3166_1: 'PT', release_dates: [{ type: 3, release_date: '2026-12-03T00:00:00.000Z' }, { type: 4, release_date: '2026-11-01T00:00:00.000Z' }] },
    { iso_3166_1: 'US', release_dates: [{ type: 4, release_date: '2026-12-04T00:00:00.000Z' }] },
  ] };
  assert.deepEqual(regionalRelease(releaseDates, 'PT'), { date: '2026-12-03', kind: 'theatrical' });
  assert.deepEqual(regionalRelease(releaseDates, 'US'), { date: '2026-12-04', kind: 'digital' });
  const net = fakeNetwork({ '/movie/550?append_to_response=release_dates': { id: 550, title: 'Fight Club', runtime: 139, release_dates: releaseDates } });

  await runNotifications(env, { now: new Date('2026-12-03T18:00:00Z'), fetchImpl: net.fetchImpl });
  assert.deepEqual(net.calls.push, ['https://push.example/pt']);
  // The US device (in Lisbon's time zone here) hears the next evening, when it's out to stream there.
  await runNotifications(env, { now: new Date('2026-12-04T18:30:00Z'), fetchImpl: net.fetchImpl });
  assert.deepEqual(net.calls.push, ['https://push.example/pt', 'https://push.example/us']);
  const stored = JSON.parse(env.DB.sqlite.prepare("SELECT data FROM tmdb_titles WHERE media_type = 'movie'").get().data);
  assert.deepEqual(Object.keys(stored.releases).sort(), ['PT', 'US'], 'only the regions devices are in are kept');
});

test('the weekly recap on Sunday evening counts the week from synced data', async () => {
  const env = await setup();
  const ana = await person(env, 'Ana');
  await subscribe(env, ana, 'https://push.example/recap', { kinds: { recap: true } });
  // Sunday 6 Dec 2026, 19:00 in Lisbon. The week is 29 Nov 19:00 to now.
  watchedEpisode(env, ana, 1399, 1, 1, '2026-12-01T21:00:00.000Z');
  watchedEpisode(env, ana, 1399, 1, 2, '2026-12-02T21:00:00.000Z');
  watchedEpisode(env, ana, 3000, 1, 1, '2026-11-20T21:00:00.000Z'); // the week before
  record(env, ana, 'watched_movie', '550', { tmdbId: 550, watchedAt: '2026-12-05T21:00:00.000Z' }, '2026-12-05T21:00:00.000Z');
  const net = fakeNetwork({
    '/tv/1399': show(1399, 'Dragons', nextEp('2026-12-09', 2, 1)),
    '/tv/3000': show(3000, 'Old', null, { status: 'Ended' }),
    '/movie/550?append_to_response=release_dates': { id: 550, title: 'Fight Club', runtime: 139, release_dates: { results: [] } },
  });
  const { recapMessage } = await import('../src/notifications.js');
  const original = recapMessage({ episodes: 2, movies: 1, minutes: 239, upcomingEpisodes: 1 });
  assert.equal(original.body, 'This week: 2 episodes, 1 movie (3h 59m). Coming up: 1 new episode.');
  assert.equal(recapMessage({ episodes: 0, movies: 0, minutes: 0, upcomingEpisodes: 0 }).body, 'Nothing watched this week.');

  // Saturday evening: nothing. Sunday 18:00: not yet (the recap is at 19:00). Sunday 19:00: sent once.
  await runNotifications(env, { now: new Date('2026-12-05T20:00:00Z'), fetchImpl: net.fetchImpl });
  await runNotifications(env, { now: new Date('2026-12-06T18:00:00Z'), fetchImpl: net.fetchImpl });
  assert.equal(net.calls.push.length, 0);
  const result = await runNotifications(env, { now: new Date('2026-12-06T19:00:00Z'), fetchImpl: net.fetchImpl });
  assert.equal(result.sent, 1);
  await runNotifications(env, { now: new Date('2026-12-06T20:00:00Z'), fetchImpl: net.fetchImpl });
  assert.equal(net.calls.push.length, 1);
  assert.deepEqual(env.DB.sqlite.prepare('SELECT tag FROM push_log').all().map(r => r.tag), ['recap:2026-12-06']);
});

test('each run asks TMDB about a limited number of titles, oldest first', async () => {
  const env = await setup();
  const ana = await person(env, 'Ana');
  await subscribe(env, ana, 'https://push.example/a', { kinds: { episodes: true } });
  const tmdb = {};
  for (let id = 1; id <= 20; id++) {
    watchedEpisode(env, ana, id, 1, 1);
    tmdb[`/tv/${id}`] = show(id, `Show ${id}`, nextEp('2026-12-20', 1, 2));
  }
  const net = fakeNetwork(tmdb);
  let result = await runNotifications(env, { now: new Date('2026-12-03T10:00:00Z'), fetchImpl: net.fetchImpl });
  assert.equal(result.refreshed, NOTIFY_LIMITS.tmdbPerRun);
  result = await runNotifications(env, { now: new Date('2026-12-03T11:00:00Z'), fetchImpl: net.fetchImpl });
  assert.equal(result.refreshed, 20 - NOTIFY_LIMITS.tmdbPerRun);
  result = await runNotifications(env, { now: new Date('2026-12-03T12:00:00Z'), fetchImpl: net.fetchImpl });
  assert.equal(result.refreshed, 0, 'nothing is due again for a while');
  assert.equal(new Set(net.calls.tmdb).size, 20);
});

test('a paused TMDB switch stops refreshing but not sending; gone devices are removed', async () => {
  const env = await setup();
  const ana = await person(env, 'Ana');
  await subscribe(env, ana, 'https://push.example/gone', { kinds: { episodes: true } });
  watchedEpisode(env, ana, 1399, 1, 1);
  const net = fakeNetwork({ '/tv/1399': show(1399, 'Dragons', nextEp('2026-12-03', 2, 3)) });
  await runNotifications(env, { now: new Date('2026-12-03T10:00:00Z'), fetchImpl: net.fetchImpl });
  env.DB.sqlite.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('tmdb_proxy', 'off', '2026-01-01T00:00:00.000Z')").run();
  const result = await runNotifications(env, { now: new Date('2026-12-03T18:00:00Z'), fetchImpl: net.fetchImpl });
  assert.equal(result.skipped, undefined);
  assert.equal(result.removed, 1);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n, 0);
});

test('the hourly Cron Trigger runs notifications, not the backup', async () => {
  const env = await setup();
  const ctx = createCtx();
  await worker.scheduled({ scheduledTime: Date.parse('2026-12-03T18:00:00Z'), cron: '0 * * * *' }, env, ctx);
  await Promise.all(ctx.waits);
  assert.equal(env.BACKUPS.objects.size, 0);
});
