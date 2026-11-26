// Export/import a profile's full local data as a single JSON file, so it can be moved to a new
// phone (or restored after an uninstall) without re-marking everything as watched/favorited.
// Ordinary app updates already preserve IndexedDB/localStorage automatically (Android keeps app
// data across `adb install -r`/Play Store updates) - this is for device-to-device migration,
// reinstalls, and autoBackup.js's weekly files.
//
// Backups deliberately do NOT contain the profile's TMDB API key. They end up in shared places
// (public Documents, Drive, email), and a key in plain text there is readable by anything that
// can read the file. A TMDB key is free and re-obtainable, so restoring asks for one instead
// (profile-picker.js) or reuses the current profile's (profile.js). Version 1 backups, made
// before this change, did include it - restoring still accepts those (legacyBackupApiKey).

// Ratings were removed from the app: new backups don't have them, and old backups' `ratings`
// are ignored when restoring.
const BACKUP_STORE_NAMES = ['lists', 'list_items', 'watched_movies', 'watched_episodes', 'favorites'];
const BACKUP_FORMAT_VERSION = 2;

async function buildBackupPayload(profile) {
  const db = await openProfileDb(profile.id);
  const data = {};
  for (const storeName of BACKUP_STORE_NAMES) {
    data[storeName] = await dbGetAll(db, storeName);
  }
  db.close();
  return {
    // Format id, not the display name - kept from when the app was called TVTimeClone so every
    // existing backup file stays importable. Don't change it.
    app: 'tvtimeclone',
    backupVersion: BACKUP_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    profile: { displayName: profile.displayName },
    data,
  };
}

function profileSlug(profile) {
  return profile.displayName.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') || 'profile';
}

function backupFilename(profile) {
  return `watchlog-backup-${profileSlug(profile)}.json`;
}

function downloadBackupInBrowser(json, filename, type = 'application/json') {
  const blob = new Blob([json], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function isNativeApp() {
  return Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

// Packaged Android WebViews don't wire up blob `<a download>` links (no DownloadListener
// registered), so the native build writes the file to the app's cache dir and hands it to the
// system Share sheet instead - which also solves "get it onto a new phone" (Drive, email,
// Nearby Share, a Files app, whatever the user picks).
async function shareBackupNatively(json, filename) {
  const { Filesystem, Directory, Encoding } = window.capacitorFilesystem;
  const { Share } = window.capacitorShare;

  const written = await Filesystem.writeFile({
    path: filename,
    data: json,
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
  });

  await Share.share({
    title: 'Watchlog Backup',
    dialogTitle: 'Save or send your backup file',
    url: written.uri,
  });
}

// On a phone's browser (the web app on iPhone especially) the system share sheet is the way to
// keep a file: "Save to Files", iCloud Drive, email... Returns 'shared', 'cancelled', or
// 'unsupported' (no file sharing, a file type the browser won't share, or the share needs a
// tap that's no longer fresh) - the caller then downloads instead. Desktop browsers download.
async function shareBackupOnWeb(json, filename) {
  const touchDevice = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (!touchDevice || !navigator.canShare || typeof File === 'undefined') return 'unsupported';
  const file = new File([json], filename, { type: 'application/json' });
  if (!navigator.canShare({ files: [file] })) return 'unsupported';
  try {
    await navigator.share({ files: [file], title: 'Watchlog backup' });
    return 'shared';
  } catch (error) {
    return error && error.name === 'AbortError' ? 'cancelled' : 'unsupported';
  }
}

// When each profile last exported a backup (localStorage `tvtc_backup_exports`:
// { [profileId]: ISO date }). The web app has no automatic backup, so Profile and Settings use
// this to remind people to export one.
const BACKUP_EXPORTS_KEY = 'tvtc_backup_exports';
const BACKUP_REMINDER_AFTER_DAYS = 7;

function readBackupExports() {
  try {
    return JSON.parse(localStorage.getItem(BACKUP_EXPORTS_KEY)) || {};
  } catch (error) {
    return {};
  }
}

function getLastBackupExport(profileId) {
  return readBackupExports()[profileId] || null;
}

function recordBackupExport(profileId, at = new Date()) {
  const exports = readBackupExports();
  exports[profileId] = at.toISOString();
  localStorage.setItem(BACKUP_EXPORTS_KEY, JSON.stringify(exports));
}

// Days since the last export (rounded down), or null when there has never been one.
function daysSinceBackupExport(profileId, now = new Date()) {
  const last = getLastBackupExport(profileId);
  if (!last) return null;
  return Math.max(0, Math.floor((now - new Date(last)) / (24 * 60 * 60 * 1000)));
}

// Saves a small text file the way backups are saved: the share sheet on Android and on phones'
// browsers ("Save to Files" on iPhone), a download on a computer. Used for the account key
// (profile-picker.js). Returns false when the person cancelled the share sheet.
async function saveTextFile(text, filename, { title = 'Watchlog' } = {}) {
  if (isNativeApp()) {
    const { Filesystem, Directory, Encoding } = window.capacitorFilesystem;
    const { Share } = window.capacitorShare;
    const written = await Filesystem.writeFile({ path: filename, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
    await Share.share({ title, dialogTitle: 'Save or send the file', url: written.uri });
    return true;
  }
  const touchDevice = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (touchDevice && navigator.canShare && typeof File !== 'undefined') {
    const file = new File([text], filename, { type: 'text/plain' });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title });
        return true;
      } catch (error) {
        if (error && error.name === 'AbortError') return false;
      }
    }
  }
  downloadBackupInBrowser(text, filename, 'text/plain');
  return true;
}

// Returns false when the person cancelled the share sheet (nothing was saved).
async function exportBackup(profile) {
  const payload = await buildBackupPayload(profile);
  const json = JSON.stringify(payload, null, 2);
  const filename = backupFilename(profile);

  if (isNativeApp()) {
    await shareBackupNatively(json, filename);
  } else {
    const shared = await shareBackupOnWeb(json, filename);
    if (shared === 'cancelled') return false;
    if (shared === 'unsupported') downloadBackupInBrowser(json, filename);
  }
  recordBackupExport(profile.id);
  return true;
}

function isValidBackupPayload(payload) {
  return Boolean(
    payload &&
    payload.app === 'tvtimeclone' &&
    payload.profile &&
    typeof payload.profile.displayName === 'string' &&
    payload.data &&
    BACKUP_STORE_NAMES.every(name => Array.isArray(payload.data[name]))
  );
}

// Parses and validates a backup file's text, throwing a user-facing message if it isn't one.
function parseBackupText(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error("That file isn't valid JSON.");
  }
  if (!isValidBackupPayload(payload)) {
    throw new Error("That file doesn't look like a Watchlog backup.");
  }
  return payload;
}

async function readBackupFile(file) {
  return parseBackupText(await file.text());
}

// Version 1 backups carried the key in plain text. Offered as a prefill when restoring one, so
// an old file still restores in one step - new backups never have it.
function legacyBackupApiKey(payload) {
  const key = payload.profile && payload.profile.tmdbApiKey;
  return typeof key === 'string' && key.trim() ? key.trim() : null;
}

// Always creates a brand-new profile rather than overwriting an existing one, so a bad import
// never clobbers data already on the device.
async function restoreBackup(payload, { displayName, tmdbApiKey }) {
  const profile = createProfile({
    displayName: (displayName || payload.profile.displayName).trim(),
    tmdbApiKey,
  });

  const db = await openProfileDb(profile.id);
  // The backup's own Watchlist replaces the new profile's empty one (they share a sync id).
  if (payload.data.lists.some(l => l.isDefault)) {
    for (const list of (await dbGetAll(db, 'lists')).filter(l => l.isDefault)) await dbDelete(db, 'lists', list.id);
  }
  for (const storeName of BACKUP_STORE_NAMES) {
    for (const record of payload.data[storeName]) {
      await dbPut(db, storeName, record);
    }
  }
  // Older backups can have watched titles on the Watchlist, and lists without a sync id.
  await ensureListSyncIds(db);
  await pruneWatchedFromWatchlist(db);
  db.close();

  return profile;
}
