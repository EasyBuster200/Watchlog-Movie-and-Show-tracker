const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./harness');

// Nothing you've watched stays on the Watchlist: a movie leaves it when marked watched, a show
// when any episode is, and a watched title can't be added back. Custom lists are unaffected.

const plain = value => JSON.parse(JSON.stringify(value));

async function listIds(app) {
  const lists = (await app.api('GET', '/api/lists')).body;
  const custom = (await app.api('POST', '/api/lists', { name: 'Faves' })).body.id;
  return { watchlist: lists.find(l => l.is_default).id, custom };
}

async function itemsOf(app, listId) {
  const rows = plain(await app.getAll('list_items'));
  return rows.filter(r => r.listId === listId).map(r => `${r.mediaType}:${r.tmdbId}`).sort();
}

test('marking a movie watched takes it off the Watchlist but not off custom lists', async () => {
  const app = createApp();
  const { watchlist, custom } = await listIds(app);
  for (const id of [watchlist, custom]) {
    await app.api('POST', `/api/lists/${id}/items`, { tmdbId: 1, mediaType: 'movie' });
    await app.api('POST', `/api/lists/${id}/items`, { tmdbId: 2, mediaType: 'movie' });
  }
  await app.api('POST', '/api/watched/movies/1', { title: 'One' });
  assert.deepEqual(await itemsOf(app, watchlist), ['movie:2']);
  assert.deepEqual(await itemsOf(app, custom), ['movie:1', 'movie:2']);
});

test('watching any episode of a show takes it off the Watchlist', async () => {
  const app = createApp();
  const { watchlist } = await listIds(app);
  await app.api('POST', `/api/lists/${watchlist}/items`, { tmdbId: 10, mediaType: 'tv' });
  await app.api('POST', `/api/lists/${watchlist}/items`, { tmdbId: 1, mediaType: 'movie' });
  await app.api('POST', '/api/watched/shows/10/season/2/episode/3');
  assert.deepEqual(await itemsOf(app, watchlist), ['movie:1']);
});

test('a watched title cannot be added to the Watchlist, but can go on a custom list', async () => {
  const app = createApp();
  const { watchlist, custom } = await listIds(app);
  await app.api('POST', '/api/watched/movies/1');
  await app.api('POST', '/api/watched/shows/10/season/1/episode/1');

  assert.equal((await app.api('POST', `/api/lists/${watchlist}/items`, { tmdbId: 1, mediaType: 'movie' })).status, 409);
  assert.equal((await app.api('POST', `/api/lists/${watchlist}/items`, { tmdbId: 10, mediaType: 'tv' })).status, 409);
  // A show and a movie can share an id; only the watched one is refused.
  assert.equal((await app.api('POST', `/api/lists/${watchlist}/items`, { tmdbId: 10, mediaType: 'movie' })).status, 201);
  assert.equal((await app.api('POST', `/api/lists/${custom}/items`, { tmdbId: 1, mediaType: 'movie' })).status, 201);
  assert.deepEqual(await itemsOf(app, watchlist), ['movie:10']);

  const membership = (await app.api('GET', '/api/lists/membership/movie/1')).body;
  assert.deepEqual(membership, { listIds: [custom], watched: true });
  assert.equal((await app.api('GET', '/api/lists/membership/movie/10')).body.watched, false);

  // Unwatching makes it addable again.
  await app.api('DELETE', '/api/watched/movies/1');
  assert.equal((await app.api('POST', `/api/lists/${watchlist}/items`, { tmdbId: 1, mediaType: 'movie' })).status, 201);
});

test('watched titles already on the Watchlist are cleared when an older database opens', async () => {
  const { context, run } = createApp({ withProfile: false });
  // A v3 database with a watched movie and a started show still on the Watchlist.
  await new Promise((resolve, reject) => {
    const request = context.indexedDB.open('tvtc-profile-old', 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      const lists = db.createObjectStore('lists', { keyPath: 'id', autoIncrement: true });
      lists.createIndex('name', 'name', { unique: true });
      const items = db.createObjectStore('list_items', { keyPath: 'id', autoIncrement: true });
      items.createIndex('listId', 'listId');
      items.createIndex('unique_item', ['listId', 'tmdbId', 'mediaType'], { unique: true });
      db.createObjectStore('watched_movies', { keyPath: 'tmdbId' });
      db.createObjectStore('watched_episodes', { keyPath: 'key' }).createIndex('showId', 'showId');
      db.createObjectStore('favorites', { keyPath: 'key' }).createIndex('mediaType', 'mediaType');
      db.createObjectStore('tmdb_cache', { keyPath: 'key' });

      lists.add({ id: 1, name: 'Bookmarks', isDefault: true, createdAt: new Date(0).toISOString() });
      lists.add({ id: 2, name: 'Faves', isDefault: false, createdAt: new Date().toISOString() });
      [[1, 1, 'movie'], [1, 2, 'movie'], [1, 10, 'tv'], [1, 20, 'tv'], [2, 1, 'movie']]
        .forEach(([listId, tmdbId, mediaType]) => items.add({ listId, tmdbId, mediaType, addedAt: new Date().toISOString() }));
      request.transaction.objectStore('watched_movies').add({ tmdbId: 1, watchedAt: new Date().toISOString() });
      request.transaction.objectStore('watched_episodes').add({ key: '10:1:1', showId: 10, seasonNumber: 1, episodeNumber: 1, watchedAt: new Date().toISOString() });
    };
    request.onsuccess = () => { request.result.close(); resolve(); };
    request.onerror = () => reject(request.error);
  });

  const rows = await run(`openProfileDb('old').then(async db => { const rows = await dbGetAll(db, 'list_items'); db.close(); return rows; })`);
  assert.deepEqual(plain(rows).map(r => `${r.listId}:${r.mediaType}:${r.tmdbId}`).sort(), ['1:movie:2', '1:tv:20', '2:movie:1']);
});

test('restoring an old backup drops watched titles from its Watchlist', async () => {
  const app = createApp();
  const now = new Date().toISOString();
  const data = {
    lists: [{ id: 1, name: 'Bookmarks', isDefault: true, createdAt: new Date(0).toISOString() }],
    list_items: [
      { id: 1, listId: 1, tmdbId: 5, mediaType: 'movie', addedAt: now },
      { id: 2, listId: 1, tmdbId: 6, mediaType: 'movie', addedAt: now },
    ],
    watched_movies: [{ tmdbId: 5, watchedAt: now }],
    watched_episodes: [],
    favorites: [],
  };
  const payload = app.run(`parseBackupText(${JSON.stringify(JSON.stringify({ app: 'tvtimeclone', backupVersion: 2, profile: { displayName: 'Old' }, data }))})`);
  const restored = await app.call('restoreBackup', payload, { displayName: 'Old', tmdbApiKey: 'k' });
  app.run(`setActiveProfileId(${JSON.stringify(restored.id)}); dbPromise = null;`);
  assert.deepEqual(await itemsOf(app, 1), ['movie:6']);
});
