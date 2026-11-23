// A minimal promisified IndexedDB wrapper. No bundler in this project, so this is hand-rolled
// rather than pulling in a library (e.g. `idb`) that would need vendoring.
//
// Each profile gets its OWN database (name: `tvtc-profile-{profileId}`), not a shared database
// with a profile-id column — see CLAUDE.md for why (privacy blast-radius + trivial export/delete).
// Object stores mirror the old server/schema.sql tables, minus the user_id column (the whole
// database *is* one profile's data), with JS-camelCase field names matching the rest of the app's
// existing "standard item shape" conventions.

const DB_VERSION = 4;

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openProfileDb(profileId) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`tvtc-profile-${profileId}`, DB_VERSION);

    request.onupgradeneeded = event => {
      const db = request.result;

      if (event.oldVersion < 1) {
        const lists = db.createObjectStore('lists', { keyPath: 'id', autoIncrement: true });
        lists.createIndex('name', 'name', { unique: true });
        // Every profile gets a default "Bookmarks" list, mirroring the old signup-time behavior.
        lists.add({ name: 'Bookmarks', isDefault: true, createdAt: new Date(0).toISOString() });

        const listItems = db.createObjectStore('list_items', { keyPath: 'id', autoIncrement: true });
        listItems.createIndex('listId', 'listId');
        listItems.createIndex('unique_item', ['listId', 'tmdbId', 'mediaType'], { unique: true });

        db.createObjectStore('watched_movies', { keyPath: 'tmdbId' });

        const watchedEpisodes = db.createObjectStore('watched_episodes', { keyPath: 'key' });
        watchedEpisodes.createIndex('showId', 'showId');

        const favorites = db.createObjectStore('favorites', { keyPath: 'key' });
        favorites.createIndex('mediaType', 'mediaType');

      }

      // v2: a persistent cache of raw TMDB /movie/{id} and /tv/{id} responses (key:
      // `${mediaType}:${tmdbId}`), so data that barely ever changes (runtime, episode count,
      // poster) doesn't get re-fetched from TMDB on every single page load that needs it - see
      // the TMDB_DETAIL_CACHE_* comment in localApi.js for why this exists.
      if (event.oldVersion < 2) {
        db.createObjectStore('tmdb_cache', { keyPath: 'key' });
      }

      // v3: ratings were removed from the app, and the ratings people had given deleted with
      // them (decided with the user).
      if (db.objectStoreNames.contains('ratings')) {
        db.deleteObjectStore('ratings');
      }

      // v4: watched titles leave the Watchlist (see pruneWatchedFromWatchlist). Titles watched
      // before this version are cleared out once the database is open.
      if (event.oldVersion >= 1 && event.oldVersion < 4) pruneAfterOpen = true;
    };

    let pruneAfterOpen = false;
    request.onsuccess = () => {
      const db = request.result;
      if (!pruneAfterOpen) return resolve(db);
      pruneWatchedFromWatchlist(db).then(() => resolve(db), reject);
    };
    request.onerror = () => reject(request.error);
  });
}

function dbGetAll(db, storeName) {
  const tx = db.transaction(storeName, 'readonly');
  return promisifyRequest(tx.objectStore(storeName).getAll());
}

function dbGet(db, storeName, key) {
  const tx = db.transaction(storeName, 'readonly');
  return promisifyRequest(tx.objectStore(storeName).get(key));
}

function dbCount(db, storeName) {
  const tx = db.transaction(storeName, 'readonly');
  return promisifyRequest(tx.objectStore(storeName).count());
}

function dbGetAllByIndex(db, storeName, indexName, value) {
  const tx = db.transaction(storeName, 'readonly');
  return promisifyRequest(tx.objectStore(storeName).index(indexName).getAll(value));
}

// Insert-only — rejects (ConstraintError) if the key or a unique index would collide.
function dbAdd(db, storeName, value) {
  const tx = db.transaction(storeName, 'readwrite');
  return promisifyRequest(tx.objectStore(storeName).add(value));
}

// Insert-or-replace by primary key.
function dbPut(db, storeName, value) {
  const tx = db.transaction(storeName, 'readwrite');
  return promisifyRequest(tx.objectStore(storeName).put(value));
}

function dbDelete(db, storeName, key) {
  const tx = db.transaction(storeName, 'readwrite');
  return promisifyRequest(tx.objectStore(storeName).delete(key));
}

// Nothing you've watched stays on the Watchlist (decided with the user): a movie once it's
// marked watched, a show once any episode is. localApi.js removes each title as it's marked;
// this sweeps the whole Watchlist, for databases from before that rule and restored backups.
async function pruneWatchedFromWatchlist(db) {
  if (!db.objectStoreNames.contains('list_items')) return;
  const [lists, items, movies, episodes] = await Promise.all([
    dbGetAll(db, 'lists'),
    dbGetAll(db, 'list_items'),
    dbGetAll(db, 'watched_movies'),
    dbGetAll(db, 'watched_episodes'),
  ]);
  const watchlist = lists.find(l => l.isDefault);
  if (!watchlist) return;
  const watchedMovies = new Set(movies.map(m => m.tmdbId));
  const watchedShows = new Set(episodes.map(e => e.showId));
  const stale = items.filter(i => i.listId === watchlist.id
    && (i.mediaType === 'movie' ? watchedMovies : watchedShows).has(i.tmdbId));
  for (const item of stale) await dbDelete(db, 'list_items', item.id);
}
