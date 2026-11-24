// Service worker for the web app (registered by scripts/pwa.js; never used in the Android app).
//
// Strategy: network first, cache as fallback. Online, every page and script comes fresh from
// the server, so a deploy shows up on the next load and old and new files never mix. Offline,
// or when the network takes longer than NETWORK_TIMEOUT_MS, the last cached copy is used, so
// the app still opens and the library (IndexedDB) is usable. Only this site's own files are
// handled; TMDB requests and posters go straight to the network as before.
//
// Some hosts (Cloudflare Pages) redirect `page.html` to `/page`. Cache keys drop the `.html`
// and the query string, so both spellings find the same cached page, and redirected responses
// are re-wrapped before caching (Safari refuses to show a cached redirect for a navigation).
//
// PRECACHE lists the app's files so they're available offline right after install, not only
// once visited. tests/pwa.test.js checks it against what's in public/, so a new page or script
// that isn't added here fails the tests.

const CACHE_NAME = 'watchlog-app';
const NETWORK_TIMEOUT_MS = 4000;

const PRECACHE = [
  './',
  'index.html',
  'main.html',
  'bookmarks.html',
  'lists.html',
  'movies.html',
  'shows.html',
  'profile.html',
  'profile-picker.html',
  'settings.html',
  'licences.html',
  'detail.html',
  'episodes.html',
  'person.html',
  'search.html',
  'media-list.html',
  'airing-soon.html',
  'stats.html',
  'manifest.webmanifest',
  'styles/tokens.css',
  'styles/style.css',
  'scripts/theme.js',
  'scripts/pwa.js',
  'scripts/standardItem.js',
  'scripts/localDb.js',
  'scripts/localApi.js',
  'scripts/profiles.js',
  'scripts/backup.js',
  'scripts/autoBackup.js',
  'scripts/notifications.js',
  'scripts/auth.js',
  'scripts/media.js',
  'scripts/search.js',
  'scripts/browse.js',
  'scripts/app.js',
  'scripts/bookmarks.js',
  'scripts/lists.js',
  'scripts/movies.js',
  'scripts/shows.js',
  'scripts/profile.js',
  'scripts/profile-picker.js',
  'scripts/settings.js',
  'scripts/detail.js',
  'scripts/episodes.js',
  'scripts/person.js',
  'scripts/search-results.js',
  'scripts/media-list.js',
  'scripts/airing-soon.js',
  'scripts/stats.js',
  'scripts/vendor/capacitor.js',
  'scripts/vendor/capacitor-filesystem.js',
  'scripts/vendor/capacitor-local-notifications.js',
  'scripts/vendor/capacitor-share.js',
  'images/tmdb-logo.svg',
  'images/icon.svg',
  'images/icon-192.png',
  'images/icon-512.png',
  'images/icon-maskable-512.png',
  'images/apple-touch-icon.png',
];

// `/detail.html?id=1` and `/detail?id=1` share the key `/detail`; `/index.html` and `/` share `/`.
function cacheKey(url) {
  const { origin, pathname } = new URL(url, self.location.href);
  let path = pathname.replace(/\.html$/, '');
  if (path.endsWith('/index')) path = path.slice(0, -'index'.length);
  return origin + path;
}

// A response that went through a redirect can't be served for a navigation later, so copy it
// into a plain response first.
async function cacheable(response) {
  if (!response.redirected) return response;
  const body = await response.blob();
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function store(cache, url, response) {
  if (!response.ok || response.type !== 'basic') return;
  await cache.put(cacheKey(url), await cacheable(response));
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // One file failing (e.g. a missing icon) mustn't stop the rest from being cached.
    await Promise.all(PRECACHE.map(async path => {
      try {
        const url = new URL(path, self.location.href).href;
        await store(cache, url, await fetch(url, { cache: 'no-cache' }));
      } catch (error) {
        // Offline during install, or the file is missing: it's cached when first fetched.
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name !== CACHE_NAME).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

function timeout(ms) {
  return new Promise((resolve, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const network = fetch(request).then(async response => {
    await store(cache, request.url, response.clone());
    return response;
  });
  network.catch(() => {}); // handled below; stops an "unhandled rejection" once we've answered from cache

  try {
    return await Promise.race([network, timeout(NETWORK_TIMEOUT_MS)]);
  } catch (error) {
    const cached = await cache.match(cacheKey(request.url));
    if (cached) return cached;
    return network; // nothing cached: keep waiting for the network (or fail with its error)
  }
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // version.json says which build is deployed; always ask the server.
  if (url.pathname.endsWith('/version.json')) return;
  event.respondWith(networkFirst(request));
});
