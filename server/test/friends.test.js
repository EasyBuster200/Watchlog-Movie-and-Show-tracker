import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { generateVapidKeys, base64UrlEncode } from '../src/webpush.js';
import { createEnv, createCtx, ORIGIN, signupEmail } from './helpers.js';

async function api(env, method, path, { body, token, ip = '203.0.113.80' } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctx = createCtx();
  const response = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await Promise.all(ctx.waits);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

let ipCount = 100;
async function person(env, name) {
  const made = await api(env, 'POST', '/v1/accounts', { body: { displayName: name, deviceName: 'Phone', ...(await signupEmail(env)) }, ip: `203.0.113.${ipCount++ % 250}` });
  assert.equal(made.status, 201);
  return { id: made.body.account.id, token: made.body.token, name };
}

const friends = (env, who) => api(env, 'GET', '/v1/friends', { token: who.token }).then(r => r.body);
const codeOf = async (env, who) => (await friends(env, who)).code;
const ask = async (env, from, to) => api(env, 'POST', '/v1/friends/requests', { token: from.token, body: { code: await codeOf(env, to) } });

let seq = 1;
function record(env, who, kind, key, data, deleted = 0) {
  env.DB.sqlite.prepare('INSERT INTO sync_records (account_id, kind, record_key, data, deleted, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(who.id, kind, key, deleted ? null : JSON.stringify(data), deleted, '2026-11-20T12:00:00.000Z', seq++);
}

test('friend codes: made on first look, XXXX-XXXX, and a new one replaces the old', async () => {
  const env = createEnv();
  const ana = await person(env, 'Ana');
  const first = await friends(env, ana);
  assert.match(first.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal((await friends(env, ana)).code, first.code, 'stable');
  assert.equal(first.shareLevel, 'everything', 'everything by default');
  const fresh = await api(env, 'POST', '/v1/friends/code', { token: ana.token });
  assert.notEqual(fresh.body.code, first.code);
  const rui = await person(env, 'Rui');
  assert.equal((await api(env, 'POST', '/v1/friends/requests', { token: rui.token, body: { code: first.code } })).body.error, 'no_such_code', 'the old code stops working');
});

test('requests: send, see both sides, accept; asking someone who already asked you is a yes', async () => {
  const env = createEnv();
  const ana = await person(env, 'Ana');
  const rui = await person(env, 'Rui');
  const bea = await person(env, 'Bea');

  assert.equal((await api(env, 'POST', '/v1/friends/requests', { token: ana.token, body: { code: 'nope' } })).body.error, 'invalid_code_format');
  assert.equal((await api(env, 'POST', '/v1/friends/requests', { token: ana.token, body: { code: await codeOf(env, ana) } })).body.error, 'own_code');
  const sent = await ask(env, ana, rui);
  assert.equal(sent.status, 201);
  assert.equal(sent.body.status, 'sent');
  assert.deepEqual((await friends(env, ana)).outgoing.map(r => r.displayName), ['Rui']);
  assert.deepEqual((await friends(env, rui)).incoming.map(r => r.displayName), ['Ana']);

  // Every device of Rui's hears about it in its sync reply.
  const synced = await api(env, 'POST', '/v1/sync', { token: rui.token, body: { since: 0, changes: [] } });
  assert.deepEqual(synced.body.friends, { incoming: 1, count: 0 });

  assert.equal((await api(env, 'POST', `/v1/friends/requests/${ana.id}/accept`, { token: rui.token })).status, 204);
  assert.deepEqual((await friends(env, ana)).friends.map(f => f.displayName), ['Rui']);
  assert.deepEqual((await friends(env, rui)).friends.map(f => f.displayName), ['Ana']);
  assert.equal((await friends(env, rui)).incoming.length, 0);
  assert.equal((await ask(env, ana, rui)).body.error, 'already_friends');
  const after = await api(env, 'POST', '/v1/sync', { token: rui.token, body: { since: 0, changes: [] } });
  assert.deepEqual(after.body.friends, { incoming: 0, count: 1 }, 'no banner once answered; the friend count');

  // Bea asks Ana, then Ana asks Bea back: they're friends at once.
  await ask(env, bea, ana);
  const back = await ask(env, ana, bea);
  assert.equal(back.body.status, 'friends');
  assert.deepEqual((await friends(env, ana)).friends.map(f => f.displayName), ['Bea', 'Rui']);
});

test('declining, cancelling, removing', async () => {
  const env = createEnv();
  const ana = await person(env, 'Ana');
  const rui = await person(env, 'Rui');
  await ask(env, ana, rui);
  await api(env, 'DELETE', `/v1/friends/requests/${ana.id}`, { token: rui.token });
  assert.equal((await friends(env, ana)).outgoing.length, 0, 'declined');
  await ask(env, ana, rui);
  await api(env, 'DELETE', `/v1/friends/requests/${rui.id}`, { token: ana.token });
  assert.equal((await friends(env, rui)).incoming.length, 0, 'cancelled');
  await ask(env, ana, rui);
  await api(env, 'POST', `/v1/friends/requests/${ana.id}/accept`, { token: rui.token });
  await api(env, 'DELETE', `/v1/friends/${ana.id}`, { token: rui.token });
  assert.equal((await friends(env, ana)).friends.length, 0, 'removed for both');
});

test('blocking ends the friendship, and the blocked account is told nobody has that code', async () => {
  const env = createEnv();
  const ana = await person(env, 'Ana');
  const rui = await person(env, 'Rui');
  await ask(env, ana, rui);
  await api(env, 'POST', `/v1/friends/requests/${ana.id}/accept`, { token: rui.token });
  assert.equal((await api(env, 'POST', `/v1/friends/${ana.id}/block`, { token: rui.token })).status, 204);
  assert.equal((await friends(env, ana)).friends.length, 0);
  assert.deepEqual((await friends(env, rui)).blocked.map(b => b.displayName), ['Ana']);
  assert.equal((await ask(env, ana, rui)).body.error, 'no_such_code');
  assert.equal((await ask(env, rui, ana)).body.error, 'no_such_code', 'either way');
  assert.equal((await api(env, 'GET', `/v1/friends/${rui.id}/library`, { token: ana.token })).body.error, 'not_friends');
  await api(env, 'DELETE', `/v1/friends/blocks/${ana.id}`, { token: rui.token });
  assert.equal((await ask(env, ana, rui)).status, 201, 'unblocked');
});

test('a friend library shows as much as they share, and only to friends', async () => {
  const env = createEnv();
  const ana = await person(env, 'Ana');
  const rui = await person(env, 'Rui');
  const stranger = await person(env, 'Stranger');
  record(env, ana, 'watched_movie', '550', { tmdbId: 550, watchedAt: '2026-11-01T00:00:00.000Z', title: 'Fight Club', year: '1999', posterPath: '/p.jpg' });
  record(env, ana, 'watched_movie', '13', { tmdbId: 13, watchedAt: '2026-11-02T00:00:00.000Z', title: 'Gone' }, 1);
  record(env, ana, 'watched_episode', '1399:1:1', { showId: 1399, seasonNumber: 1, episodeNumber: 1, watchedAt: '2026-11-03T00:00:00.000Z' });
  record(env, ana, 'watched_episode', '1399:1:2', { showId: 1399, seasonNumber: 1, episodeNumber: 2, watchedAt: '2026-11-04T00:00:00.000Z' });
  record(env, ana, 'favorite', 'tv:1399', { mediaType: 'tv', tmdbId: 1399, favoritedAt: '2026-11-05T00:00:00.000Z', title: 'Dragons' });
  record(env, ana, 'list', 'l-1', { name: 'Horror', createdAt: '2026-11-01T00:00:00.000Z' });
  record(env, ana, 'list_item', 'l-1:movie:694', { list: 'l-1', mediaType: 'movie', tmdbId: 694, addedAt: '2026-11-06T00:00:00.000Z' });
  record(env, ana, 'list_item', 'watchlist:movie:603', { list: 'watchlist', mediaType: 'movie', tmdbId: 603, addedAt: '2026-11-07T00:00:00.000Z' });
  record(env, ana, 'prefs', 'prefs', { theme: 'dark' });

  assert.equal((await api(env, 'GET', `/v1/friends/${ana.id}/library`, { token: stranger.token })).body.error, 'not_friends');
  await ask(env, rui, ana);
  await api(env, 'POST', `/v1/friends/requests/${rui.id}/accept`, { token: ana.token });

  const everything = (await api(env, 'GET', `/v1/friends/${ana.id}/library`, { token: rui.token })).body;
  assert.equal(everything.shareLevel, 'everything');
  assert.deepEqual(everything.movies.map(m => [m.tmdbId, m.title]), [[550, 'Fight Club']], 'deleted records stay out');
  assert.deepEqual(everything.shows, [{ tmdbId: 1399, episodes: 2, lastWatchedAt: '2026-11-04T00:00:00.000Z' }]);
  assert.deepEqual(everything.favorites.map(f => f.tmdbId), [1399]);
  assert.deepEqual(everything.lists.map(l => [l.name, l.items.map(i => i.tmdbId)]), [['Horror', [694]]]);
  assert.deepEqual(everything.watchlist.map(i => i.tmdbId), [603]);
  assert.ok(!JSON.stringify(everything).includes('theme'), 'preferences are never shared');

  await api(env, 'PUT', '/v1/friends/settings', { token: ana.token, body: { shareLevel: 'lists' } });
  const lists = (await api(env, 'GET', `/v1/friends/${ana.id}/library`, { token: rui.token })).body;
  assert.equal(lists.movies, undefined);
  assert.equal(lists.shows, undefined);
  assert.equal(lists.watchlist, undefined);
  assert.equal(lists.lists.length, 1);
  assert.equal(lists.favorites.length, 1);

  await api(env, 'PUT', '/v1/friends/settings', { token: ana.token, body: { shareLevel: 'nothing' } });
  const nothing = (await api(env, 'GET', `/v1/friends/${ana.id}/library`, { token: rui.token })).body;
  assert.deepEqual(Object.keys(nothing).sort(), ['friend', 'shareLevel']);
  assert.equal((await api(env, 'PUT', '/v1/friends/settings', { token: ana.token, body: { shareLevel: 'all' } })).body.error, 'invalid_share_level');
});

test('a friend request is pushed to devices that want them', async () => {
  const vapid = await generateVapidKeys();
  const env = createEnv({ VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey });
  const ana = await person(env, 'Ana');
  const rui = await person(env, 'Rui');
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const keys = { p256dh: base64UrlEncode(await crypto.subtle.exportKey('raw', pair.publicKey)), auth: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))) };
  await api(env, 'PUT', '/v1/push/subscription', { token: rui.token, body: { endpoint: 'https://push.example/rui', keys, kinds: { friends: true } } });
  await api(env, 'PUT', '/v1/push/subscription', { token: rui.token, body: { endpoint: 'https://push.example/rui-other', keys, kinds: { episodes: true } } });
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async url => { sent.push(String(url)); return new Response(null, { status: 201 }); };
  try {
    await ask(env, ana, rui);
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(sent, ['https://push.example/rui']);
});

test('deleting an account removes its friendships and requests', async () => {
  const env = createEnv();
  const ana = await person(env, 'Ana');
  const rui = await person(env, 'Rui');
  const bea = await person(env, 'Bea');
  await ask(env, ana, rui);
  await api(env, 'POST', `/v1/friends/requests/${ana.id}/accept`, { token: rui.token });
  await ask(env, ana, bea);
  await api(env, 'DELETE', '/v1/account', { token: ana.token });
  assert.equal((await friends(env, rui)).friends.length, 0);
  assert.equal((await friends(env, bea)).incoming.length, 0);
});

// ---------- Step 2: friends on a title, the activity feed, taste match ----------

async function befriend(env, x, y) {
  await ask(env, x, y);
  await api(env, 'POST', `/v1/friends/requests/${x.id}/accept`, { token: y.token });
}

const daysAgo = n => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();
function recent(env, who, kind, key, data, at = daysAgo(1)) {
  env.DB.sqlite.prepare('INSERT OR REPLACE INTO sync_records (account_id, kind, record_key, data, deleted, updated_at, seq) VALUES (?, ?, ?, ?, 0, ?, ?)')
    .run(who.id, kind, key, JSON.stringify(data), at, seq++);
}
const episode = (env, who, show, s, e, at) => recent(env, who, 'watched_episode', `${show}:${s}:${e}`, { showId: show, seasonNumber: s, episodeNumber: e, watchedAt: at || daysAgo(1) }, at);
const movie = (env, who, id, at, title = `Movie ${id}`) => recent(env, who, 'watched_movie', String(id), { tmdbId: id, watchedAt: at || daysAgo(1), title }, at);

test('friends on a title: who watched it, how far, favourites and Watchlist, as each shares', async () => {
  const env = createEnv();
  const me = await person(env, 'Me');
  const ana = await person(env, 'Ana');
  const rui = await person(env, 'Rui');
  const bea = await person(env, 'Bea');
  const stranger = await person(env, 'Stranger');
  await befriend(env, ana, me);
  await befriend(env, rui, me);
  await befriend(env, bea, me);

  episode(env, ana, 1399, 1, 1, daysAgo(5));
  episode(env, ana, 1399, 3, 4, daysAgo(2));
  episode(env, ana, 1399, 0, 9, daysAgo(1)); // a special: not "on S0E9"
  episode(env, ana, 13990, 1, 1); // a different show whose id starts the same
  recent(env, rui, 'favorite', 'tv:1399', { mediaType: 'tv', tmdbId: 1399, favoritedAt: daysAgo(3) });
  episode(env, rui, 1399, 1, 1); // Rui shares lists only: the favourite shows, the watching doesn't
  await api(env, 'PUT', '/v1/friends/settings', { token: rui.token, body: { shareLevel: 'lists' } });
  episode(env, bea, 1399, 1, 1);
  await api(env, 'PUT', '/v1/friends/settings', { token: bea.token, body: { shareLevel: 'nothing' } });
  episode(env, stranger, 1399, 1, 1);

  const tv = await api(env, 'GET', '/v1/friends/title/tv/1399', { token: me.token });
  assert.equal(tv.status, 200);
  assert.deepEqual(tv.body.friends.map(f => f.displayName), ['Ana', 'Rui']);
  const [anaRow, ruiRow] = tv.body.friends;
  assert.equal(anaRow.episodes, 2);
  assert.deepEqual(anaRow.latest, { season: 3, episode: 4 });
  assert.equal(ruiRow.favorite, true);
  assert.equal(ruiRow.watchedAt, undefined, 'lists-only friends never show watching');

  movie(env, ana, 550);
  recent(env, ana, 'list_item', 'watchlist:movie:27205', { list: 'watchlist', mediaType: 'movie', tmdbId: 27205, addedAt: daysAgo(1) });
  assert.deepEqual((await api(env, 'GET', '/v1/friends/title/movie/550', { token: me.token })).body.friends.map(f => [f.displayName, Boolean(f.watchedAt)]), [['Ana', true]]);
  assert.equal((await api(env, 'GET', '/v1/friends/title/movie/27205', { token: me.token })).body.friends[0].watchlist, true);
  assert.deepEqual((await api(env, 'GET', '/v1/friends/title/movie/1', { token: me.token })).body.friends, []);
  assert.equal((await api(env, 'GET', '/v1/friends/title/person/1', { token: me.token })).status, 400);
  assert.equal((await api(env, 'GET', '/v1/friends/title/tv/1399')).status, 401);
});

test('activity: recent watching grouped per show and day, favourites, lists, as each shares', async () => {
  const env = createEnv();
  const me = await person(env, 'Me');
  const ana = await person(env, 'Ana');
  const rui = await person(env, 'Rui');
  const stranger = await person(env, 'Stranger');
  await befriend(env, ana, me);
  await befriend(env, rui, me);

  const today = daysAgo(0.01);
  episode(env, ana, 1399, 2, 1, today);
  episode(env, ana, 1399, 2, 2, today);
  episode(env, ana, 1399, 2, 3, today);
  episode(env, ana, 1399, 1, 1, daysAgo(40)); // too old
  movie(env, ana, 550, daysAgo(2), 'Fight Club');
  recent(env, ana, 'watched_movie', '551', { tmdbId: 551, watchedAt: daysAgo(400) }, daysAgo(0.5)); // an old watch synced now: not news
  recent(env, ana, 'list_item', 'watchlist:movie:27205', { list: 'watchlist', mediaType: 'movie', tmdbId: 27205, addedAt: daysAgo(3) });
  recent(env, rui, 'list', 'L1', { name: 'Horror', createdAt: daysAgo(10) });
  recent(env, rui, 'list_item', 'L1:movie:694', { list: 'L1', mediaType: 'movie', tmdbId: 694, addedAt: daysAgo(4) });
  recent(env, rui, 'list_item', 'watchlist:movie:1', { list: 'watchlist', mediaType: 'movie', tmdbId: 1, addedAt: daysAgo(4) });
  recent(env, rui, 'favorite', 'movie:603', { mediaType: 'movie', tmdbId: 603, favoritedAt: daysAgo(5), title: 'The Matrix' });
  movie(env, rui, 552);
  await api(env, 'PUT', '/v1/friends/settings', { token: rui.token, body: { shareLevel: 'lists' } });
  movie(env, stranger, 553);

  const feed = await api(env, 'GET', '/v1/friends/activity', { token: me.token });
  assert.equal(feed.status, 200);
  assert.deepEqual(feed.body.items.map(i => `${i.friend.displayName} ${i.type} ${i.tmdbId}`), [
    'Ana episodes 1399',
    'Ana watched 550',
    'Ana watchlist 27205',
    'Rui list 694',
    'Rui favorite 603',
  ]);
  const [eps, watched, , list, fav] = feed.body.items;
  assert.equal(eps.episodes, 3);
  assert.deepEqual([eps.first, eps.last], [{ season: 2, episode: 1 }, { season: 2, episode: 3 }]);
  assert.equal(watched.title, 'Fight Club');
  assert.equal(list.listName, 'Horror');
  assert.equal(fav.title, 'The Matrix');

  await api(env, 'PUT', '/v1/friends/settings', { token: ana.token, body: { shareLevel: 'nothing' } });
  assert.deepEqual((await api(env, 'GET', '/v1/friends/activity', { token: me.token })).body.items.map(i => i.friend.displayName), ['Rui', 'Rui']);
});

test('taste match: shared titles over both libraries, only once both have a few', async () => {
  const env = createEnv();
  const me = await person(env, 'Me');
  const ana = await person(env, 'Ana');
  await befriend(env, ana, me);
  movie(env, me, 1);
  movie(env, ana, 1);
  let match = (await api(env, 'GET', `/v1/friends/${ana.id}/library`, { token: me.token })).body.tasteMatch;
  assert.equal(match.percent, null, 'too few titles');
  assert.equal(match.shared, 1);

  [2, 3].forEach(id => movie(env, me, id));
  episode(env, me, 1399, 1, 1);
  episode(env, me, 1399, 1, 2);
  [2, 7, 8].forEach(id => movie(env, ana, id));
  episode(env, ana, 1399, 1, 1, daysAgo(0.5));
  match = (await api(env, 'GET', `/v1/friends/${ana.id}/library`, { token: me.token })).body.tasteMatch;
  // Me: movies 1, 2, 3 and show 1399 (4). Ana: 1, 2, 7, 8 and 1399 (5). Shared: 1, 2, 1399.
  assert.deepEqual([match.mine, match.theirs, match.shared], [4, 5, 3]);
  assert.equal(match.percent, Math.round(300 / Math.sqrt(20)));
  assert.deepEqual(match.titles.map(t => `${t.mediaType}:${t.tmdbId}`).sort(), ['movie:1', 'movie:2', 'tv:1399']);
  assert.equal(match.titles[0].tmdbId, 1399, 'most recently watched by them first');
});
