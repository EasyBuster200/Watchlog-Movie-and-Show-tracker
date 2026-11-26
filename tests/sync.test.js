// Sync (sync.js, roadmap Phase 4b): two "devices" (two createApp() pages, each with its own
// IndexedDB and localStorage) signed in to one account, against an in-memory stand-in for the
// server's POST /v1/sync (server/src/routes/sync.js, tested on its own in server/test/).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./harness');

const plain = value => JSON.parse(JSON.stringify(value));

// Same rules as the real server: newest updatedAt wins (ties keep what's stored), every stored
// change gets the next seq, at most 200 changes in and 500 out, 2 KB per record.
function createSyncServer({ clockAheadMs = 0 } = {}) {
  const records = new Map();
  let seq = 0;
  const state = { offline: false, requests: [] };
  function handler(method, path, { body, headers }) {
    if (state.offline) throw new TypeError('Failed to fetch');
    if (method !== 'POST' || path !== '/v1/sync') return { status: 404, body: { error: 'not_found', message: 'Not found.' } };
    if (headers.Authorization !== 'Bearer tok') return { status: 401, body: { error: 'signed_out', message: 'Signed out.' } };
    state.requests.push(body);
    const changes = body.changes || [];
    if (changes.length > 200) return { status: 400, body: { error: 'invalid_changes', message: 'Too many.' } };
    for (const c of changes) {
      if (!c.deleted && JSON.stringify(c.data).length > 2048) return { status: 400, body: { error: 'invalid_changes', message: 'Too large.' } };
    }
    for (const c of changes) {
      const id = `${c.kind}|${c.key}`;
      const stored = records.get(id);
      seq++;
      if (!stored || c.updatedAt > stored.updatedAt) {
        records.set(id, { kind: c.kind, key: c.key, data: c.deleted ? null : c.data, deleted: Boolean(c.deleted), updatedAt: c.updatedAt, seq });
      }
    }
    const newer = [...records.values()].filter(r => r.seq > body.since).sort((a, b) => a.seq - b.seq);
    const page = newer.slice(0, 500);
    return {
      body: {
        cursor: page.length ? page[page.length - 1].seq : body.since,
        changes: page.map(({ seq: _seq, ...change }) => change),
        more: newer.length > 500,
        accepted: changes.length,
        serverTime: new Date(Date.now() + clockAheadMs).toISOString(),
      },
    };
  }
  return { handler, state, records };
}

let sessionCount = 0;

function device(server, { online = true } = {}) {
  const app = createApp({ server: server.handler });
  app.profileId = app.run('getActiveProfileId()');
  if (online) signIn(app);
  return app;
}

function signIn(app) {
  sessionCount++;
  app.run(`linkProfileToAccount('${app.profileId}', { account: { id: 'acc-1', displayName: 'Ana' }, session: { id: 's-${sessionCount}' }, token: 'tok' })`);
}

const sync = app => app.call('syncNow');

async function library(app) {
  // One store at a time: the harness's getAll passes the store name through a shared global.
  const rows = [];
  for (const store of ['lists', 'list_items', 'watched_movies', 'watched_episodes', 'favorites']) rows.push(plain(await app.getAll(store)));
  return describeLibrary(...rows);
}

function describeLibrary(lists, items, movies, episodes, favorites) {
  const listName = new Map(lists.map(l => [l.id, l.isDefault ? 'Watchlist' : l.name]));
  return {
    lists: lists.filter(l => !l.isDefault).map(l => l.name).sort(),
    items: items.map(i => `${listName.get(i.listId)}:${i.mediaType}:${i.tmdbId}`).sort(),
    movies: movies.map(m => m.tmdbId).sort(),
    episodes: episodes.map(e => e.key).sort(),
    favorites: favorites.map(f => f.key).sort(),
  };
}

async function createList(app, name) {
  return (await app.api('POST', '/api/lists', { name })).body.id;
}

async function watchlistId(app) {
  return (await app.api('GET', '/api/lists')).body.find(l => l.is_default).id;
}

const outboxCount = app => app.getAll('sync_outbox').then(rows => rows.length);

test("one device's changes reach the other, deletions included", async () => {
  const server = createSyncServer();
  const laptop = device(server);
  const phone = device(server);

  await laptop.api('POST', '/api/watched/movies/550', { title: 'Fight Club', posterPath: '/p.jpg' });
  await laptop.api('POST', '/api/watched/shows/1399/season/1/episode/1');
  await laptop.api('POST', '/api/favorites/tv/1399', { title: 'GoT' });
  const horror = await createList(laptop, 'Horror');
  await laptop.api('POST', `/api/lists/${horror}/items`, { tmdbId: 694, mediaType: 'movie' });
  await laptop.api('POST', `/api/lists/${await watchlistId(laptop)}/items`, { tmdbId: 100, mediaType: 'tv' });
  assert.equal((await sync(laptop)).status, 'synced');
  assert.equal(await outboxCount(laptop), 0, 'sent changes leave the outbox');

  const result = await sync(phone);
  assert.equal(result.status, 'synced');
  assert.deepEqual(await library(phone), {
    lists: ['Horror'],
    items: ['Horror:movie:694', 'Watchlist:tv:100'],
    movies: [550],
    episodes: ['1399:1:1'],
    favorites: ['tv:1399'],
  });
  const movie = plain(await phone.getAll('watched_movies'))[0];
  assert.equal(movie.title, 'Fight Club', 'display fields travel too, so lists render without TMDB');

  await laptop.api('DELETE', '/api/watched/movies/550');
  await laptop.api('DELETE', '/api/watched/shows/1399/season/1/episode/1');
  await laptop.api('DELETE', '/api/favorites/tv/1399');
  await laptop.api('DELETE', `/api/lists/${horror}`);
  await laptop.api('DELETE', `/api/lists/${await watchlistId(laptop)}/items/100/tv`);
  await sync(laptop);
  await sync(phone);
  assert.deepEqual(await library(phone), { lists: [], items: [], movies: [], episodes: [], favorites: [] });
});

test("changes are stamped with the server's clock, so a device whose clock is behind still wins", async () => {
  const HOUR = 60 * 60 * 1000;
  // The phone's clock is an hour behind the server's (the server is an hour "ahead" of it).
  const server = createSyncServer({ clockAheadMs: HOUR });
  const laptop = device(server);
  const phone = device(server);
  // The laptop's change, stamped by a correct clock: the server's time now.
  await sync(phone);
  await laptop.api('POST', '/api/watched/movies/550');
  const laptopRow = plain(await laptop.getAll('sync_outbox')).find(r => r.key === '550');
  laptopRow.updatedAt = new Date(Date.now() + HOUR).toISOString();
  await laptop.put('sync_outbox', laptopRow);
  await sync(laptop);

  // A minute later the phone un-watches it. Its own clock would say an hour earlier.
  await sync(phone);
  await phone.api('DELETE', '/api/watched/movies/550');
  const stamped = Date.parse(plain(await phone.getAll('sync_outbox')).find(r => r.key === '550').updatedAt);
  assert.ok(Math.abs(stamped - (Date.now() + HOUR)) < 5000, 'stamped on the server clock');
  await sync(phone);
  await sync(laptop);
  assert.deepEqual((await library(laptop)).movies, [], "the phone's later change wins");
});

test('offline profiles record nothing and never talk to the server', async () => {
  const server = createSyncServer();
  const app = device(server, { online: false });
  await app.api('POST', '/api/watched/movies/550');
  assert.equal(await outboxCount(app), 0);
  assert.equal((await sync(app)).status, 'off');
  assert.equal(server.state.requests.length, 0);
});

test('changes made without a connection wait in the outbox and go on the next sync', async () => {
  const server = createSyncServer();
  const laptop = device(server);
  const phone = device(server);
  await sync(laptop);
  server.state.offline = true;
  await laptop.api('POST', '/api/watched/movies/550');
  await laptop.api('POST', '/api/watched/movies/550'); // the same record twice is one change
  const failed = await sync(laptop);
  assert.equal(failed.status, 'error');
  assert.equal(await outboxCount(laptop), 1);
  const status = await laptop.call('getSyncStatus');
  assert.equal(status.status, 'error');
  assert.equal(status.pending, 1);

  server.state.offline = false;
  assert.equal((await sync(laptop)).status, 'synced');
  await sync(phone);
  assert.deepEqual((await library(phone)).movies, [550]);
  assert.equal((await laptop.call('getSyncStatus')).status, 'ok');
});

test("an offline profile that goes online uploads its library; the account's newer changes still win", async () => {
  const server = createSyncServer();
  const laptop = device(server);
  // On the account: the movie was un-watched just now.
  await laptop.api('POST', '/api/watched/movies/550');
  await laptop.api('DELETE', '/api/watched/movies/550');
  await sync(laptop);

  // The phone watched it a year ago, and lots more, as an offline profile.
  const phone = device(server, { online: false });
  await phone.put('watched_movies', { tmdbId: 550, watchedAt: '2025-11-01T20:00:00.000Z' });
  await phone.api('POST', '/api/watched/movies/13');
  await phone.api('POST', '/api/watched/shows/1399/season/1/episode/2');
  await createList(phone, 'Comfort');
  assert.equal(await outboxCount(phone), 0);

  signIn(phone);
  await sync(phone);
  assert.deepEqual((await library(phone)).movies, [13], "the account's later deletion wins over the old watch");

  await sync(laptop);
  assert.deepEqual(await library(laptop), { lists: ['Comfort'], items: [], movies: [13], episodes: ['1399:1:2'], favorites: [] });
});

test('lists with the same name from two devices are kept apart, the newer one renamed everywhere', async () => {
  const server = createSyncServer();
  const laptop = device(server);
  const phone = device(server);
  const laptopHorror = await createList(laptop, 'Horror');
  await laptop.api('POST', `/api/lists/${laptopHorror}/items`, { tmdbId: 1, mediaType: 'movie' });
  await new Promise(resolve => setTimeout(resolve, 5)); // the phone's list is the newer one
  const phoneHorror = await createList(phone, 'Horror');
  await phone.api('POST', `/api/lists/${phoneHorror}/items`, { tmdbId: 2, mediaType: 'movie' });

  await sync(laptop);
  await sync(phone);
  await sync(laptop);
  await sync(phone);

  const expected = { lists: ['Horror', 'Horror (2)'], items: ['Horror (2):movie:2', 'Horror:movie:1'], movies: [], episodes: [], favorites: [] };
  assert.deepEqual(await library(laptop), expected);
  assert.deepEqual(await library(phone), expected);
});

test('Reset all data on an online profile empties the library on every device', async () => {
  const server = createSyncServer();
  const laptop = device(server);
  const phone = device(server);
  await laptop.api('POST', '/api/watched/movies/550');
  await laptop.api('POST', '/api/favorites/movie/550');
  const list = await createList(laptop, 'Horror');
  await laptop.api('POST', `/api/lists/${list}/items`, { tmdbId: 694, mediaType: 'movie' });
  await laptop.api('POST', `/api/lists/${await watchlistId(laptop)}/items`, { tmdbId: 100, mediaType: 'tv' });
  await sync(laptop);
  await sync(phone);
  assert.deepEqual((await library(phone)).movies, [550]);

  await phone.api('POST', '/api/reset');
  await sync(phone);
  await sync(laptop);
  const empty = { lists: [], items: [], movies: [], episodes: [], favorites: [] };
  assert.deepEqual(await library(laptop), empty);
  assert.deepEqual(await library(phone), empty);
  assert.equal(plain(await phone.getAll('lists')).filter(l => l.isDefault && l.syncId === 'watchlist').length, 1, 'the Watchlist is back, with its shared id');
});

test('theme, accent, region and language sync; the notification and backup switches stay per device', async () => {
  const server = createSyncServer();
  const laptop = device(server);
  const phone = device(server);
  await sync(laptop);
  await sync(phone);

  laptop.run(`setProfilePrefs('${laptop.profileId}', { theme: 'light', accent: 'teal', region: 'PT', notifyEpisodes: false, autoBackup: false })`);
  await laptop.call('recordPrefsChange', { theme: 'light', accent: 'teal', region: 'PT', notifyEpisodes: false, autoBackup: false });
  await sync(laptop);
  await sync(phone);
  const prefs = plain(phone.run('getProfilePrefs()'));
  assert.equal(prefs.theme, 'light');
  assert.equal(prefs.accent, 'teal');
  assert.equal(prefs.region, 'PT');
  assert.equal(prefs.notifyEpisodes, true);
  assert.equal(prefs.autoBackup, true);
});

test('a big library goes up in batches the server accepts, and comes down in pages', async () => {
  const server = createSyncServer();
  const laptop = device(server, { online: false });
  for (let i = 1; i <= 650; i++) {
    await laptop.put('watched_episodes', { key: `1399:1:${i}`, showId: 1399, seasonNumber: 1, episodeNumber: i, watchedAt: '2026-01-01T00:00:00.000Z' });
  }
  signIn(laptop);
  const up = await sync(laptop);
  assert.equal(up.status, 'synced');
  assert.ok(server.state.requests.every(r => r.changes.length <= 200));
  assert.equal(await outboxCount(laptop), 0);

  const phone = device(server);
  await sync(phone);
  assert.equal((await library(phone)).episodes.length, 650);
});

test('a copy kept at sign-out records nothing, so nothing done in it reaches the account', async () => {
  const server = createSyncServer();
  const laptop = device(server);
  await sync(laptop);
  laptop.run(`unlinkProfileAccount('${laptop.profileId}')`);
  await laptop.api('POST', '/api/watched/movies/550');
  assert.equal(await outboxCount(laptop), 0);
  assert.equal((await sync(laptop)).status, 'off');
  assert.ok(![...server.records.keys()].includes('watched_movie|550'));
});

test('a signed-out device keeps its changes until it signs in again', async () => {
  const server = createSyncServer();
  const laptop = device(server);
  laptop.run(`updateProfile('${laptop.profileId}', { account: { ...getActiveProfile().account, sessionToken: null } })`);
  await laptop.api('POST', '/api/watched/movies/550');
  assert.equal((await sync(laptop)).status, 'signed_out');
  assert.equal(await outboxCount(laptop), 1);
  assert.equal(server.state.requests.length, 0);
});

test('lists get a sync id when the database upgrades, the Watchlist the shared one', async () => {
  const { context, run } = createApp({ withProfile: false });
  await new Promise((resolve, reject) => {
    const request = context.indexedDB.open('tvtc-profile-old', 4);
    request.onupgradeneeded = () => {
      const lists = request.result.createObjectStore('lists', { keyPath: 'id', autoIncrement: true });
      lists.createIndex('name', 'name', { unique: true });
      lists.add({ name: 'Bookmarks', isDefault: true, createdAt: new Date(0).toISOString() });
      lists.add({ name: 'Horror', isDefault: false, createdAt: '2026-01-01T00:00:00.000Z' });
      const items = request.result.createObjectStore('list_items', { keyPath: 'id', autoIncrement: true });
      items.createIndex('listId', 'listId');
      request.result.createObjectStore('watched_movies', { keyPath: 'tmdbId' });
      request.result.createObjectStore('watched_episodes', { keyPath: 'key' }).createIndex('showId', 'showId');
      request.result.createObjectStore('favorites', { keyPath: 'key' });
      request.result.createObjectStore('tmdb_cache', { keyPath: 'key' });
    };
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });
  const lists = plain(await run("openProfileDb('old').then(async db => { const rows = await dbGetAll(db, 'lists'); db.close(); return rows; })"));
  assert.equal(lists.find(l => l.isDefault).syncId, 'watchlist');
  assert.match(lists.find(l => !l.isDefault).syncId, /^[0-9a-f-]{32,36}$/);
});

test("restoring a backup from before sync ids gives its lists one, and keeps a single Watchlist", async () => {
  const app = createApp();
  const payload = {
    app: 'tvtimeclone',
    backupVersion: 2,
    profile: { displayName: 'Old' },
    data: {
      lists: [{ id: 3, name: 'Bookmarks', isDefault: true, createdAt: new Date(0).toISOString() }, { id: 4, name: 'Horror', isDefault: false, createdAt: '2026-01-01T00:00:00.000Z' }],
      list_items: [{ id: 1, listId: 3, tmdbId: 5, mediaType: 'movie', addedAt: '2026-01-01T00:00:00.000Z' }],
      watched_movies: [], watched_episodes: [], favorites: [],
    },
  };
  const profile = await app.call('restoreBackup', payload, { displayName: 'Old', tmdbApiKey: 'k' });
  app.context.__restoredId = profile.id;
  const lists = plain(await app.run("openProfileDb(__restoredId).then(async db => { const rows = await dbGetAll(db, 'lists'); db.close(); return rows; })"));
  assert.equal(lists.filter(l => l.isDefault).length, 1);
  assert.equal(lists.find(l => l.isDefault).id, 3);
  assert.ok(lists.every(l => l.syncId));
});
