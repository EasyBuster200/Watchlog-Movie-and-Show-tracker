// The web app (PWA) files: the service worker's offline list, the manifest, the tags every
// page needs, and the backup-export record behind the web app's backup reminder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createApp } = require('./harness');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DAY_MS = 24 * 60 * 60 * 1000;

function publicFiles(dir = PUBLIC_DIR) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return publicFiles(full);
    return [path.relative(PUBLIC_DIR, full).split(path.sep).join('/')];
  });
}

// Runs sw.js just far enough to read its PRECACHE list and cacheKey().
function loadServiceWorker() {
  const context = { self: { addEventListener() {}, location: { href: 'https://watchlog.example/sw.js', origin: 'https://watchlog.example' } }, URL };
  vm.createContext(context);
  vm.runInContext(`${fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8')}\nthis.PRECACHE = PRECACHE; this.cacheKey = cacheKey;`, context);
  return context;
}

test('the service worker caches every file the app needs offline, and only files that exist', () => {
  const { PRECACHE } = loadServiceWorker();
  // Not cached: the worker itself, and the generated version.json (always asked fresh).
  const expected = publicFiles().filter(f => f !== 'sw.js' && f !== 'version.json').sort();
  // JSON round trip: arrays made inside the vm context don't deepEqual outer ones.
  const listed = JSON.parse(JSON.stringify(PRECACHE)).filter(entry => entry !== './').sort();
  assert.deepEqual(listed, expected, 'sw.js PRECACHE must list exactly the files in public/');
});

test('cached pages are found with or without .html, and whatever the query string', () => {
  const { cacheKey } = loadServiceWorker();
  assert.equal(cacheKey('https://watchlog.example/detail.html?type=tv&id=1'), 'https://watchlog.example/detail');
  assert.equal(cacheKey('https://watchlog.example/detail?type=tv&id=1'), 'https://watchlog.example/detail');
  assert.equal(cacheKey('https://watchlog.example/index.html'), 'https://watchlog.example/');
  assert.equal(cacheKey('https://watchlog.example/'), 'https://watchlog.example/');
  assert.equal(cacheKey('https://watchlog.example/scripts/media.js'), 'https://watchlog.example/scripts/media.js');
});

test('the service worker never answers the server API (/v1/) or version.json', () => {
  const listeners = {};
  const context = {
    self: { addEventListener: (type, fn) => { listeners[type] = fn; }, location: { href: 'https://watchlog.example/sw.js', origin: 'https://watchlog.example' } },
    caches: { open: async () => ({ match: async () => undefined, put: async () => {} }) },
    fetch: async () => new Response('network'),
    URL, Response, setTimeout,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8'), context);
  const handled = url => {
    let answered = false;
    listeners.fetch({ request: { method: 'GET', url }, respondWith: () => { answered = true; } });
    return answered;
  };
  assert.equal(handled('https://watchlog.example/v1/health'), false);
  assert.equal(handled('https://watchlog.example/v1'), false);
  assert.equal(handled('https://watchlog.example/version.json'), false);
  assert.equal(handled('https://api.themoviedb.org/3/movie/1'), false, 'other sites');
  assert.equal(handled('https://watchlog.example/main.html'), true, 'the app\'s own files');
});

test('the manifest names the app and its icons exist', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.name, 'Watchlog');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'), 'a maskable icon for Android home screens');
  for (const icon of manifest.icons) {
    assert.ok(fs.existsSync(path.join(PUBLIC_DIR, icon.src)), `${icon.src} exists`);
  }
});

test('every page links the manifest and iPhone icon, and every app page loads pwa.js', () => {
  const pages = fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'));
  for (const page of pages) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, page), 'utf8');
    assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/, `${page}: manifest`);
    assert.match(html, /<link rel="apple-touch-icon" href="images\/apple-touch-icon\.png">/, `${page}: apple-touch-icon`);
    assert.match(html, /viewport-fit=cover/, `${page}: viewport-fit=cover`);
    // index.html only redirects; every other page registers the service worker.
    if (page !== 'index.html') assert.match(html, /src="scripts\/pwa\.js"/, `${page}: pwa.js`);
  }
});

test('the last backup export is remembered per profile, for the web backup reminder', async () => {
  const app = createApp();
  const now = new Date('2026-11-24T12:00:00Z');
  assert.equal(await app.call('getLastBackupExport', 'a'), null);
  assert.equal(await app.call('daysSinceBackupExport', 'a', now), null, 'never exported');

  await app.call('recordBackupExport', 'a', new Date(now - 9 * DAY_MS));
  await app.call('recordBackupExport', 'b', new Date(now - 2 * DAY_MS));
  assert.equal(await app.call('daysSinceBackupExport', 'a', now), 9);
  assert.equal(await app.call('daysSinceBackupExport', 'b', now), 2);
  assert.ok((await app.call('daysSinceBackupExport', 'a', now)) >= app.run('BACKUP_REMINDER_AFTER_DAYS'), 'a is due a reminder');
  assert.ok((await app.call('daysSinceBackupExport', 'b', now)) < app.run('BACKUP_REMINDER_AFTER_DAYS'), 'b is not');
});
