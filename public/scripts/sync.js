// Sync (roadmap Phase 4b): keeps an online profile's library the same on every device signed in
// to its account, through the server's POST /v1/sync (server/src/routes/sync.js; the protocol is
// in docs/DEVELOPMENT.md, "Sync API"). Local first: the app reads and writes IndexedDB exactly as
// before, and this runs alongside it.
//
// - Every record is { kind, key, data } (syncRecordFor*): a watched movie ('550'), a watched
//   episode ('1399:1:1'), a favourite ('movie:550'), a list (its sync id), a list item
//   ('<list sync id>:movie:550'), and the profile's synced preferences ('prefs': theme, accent,
//   region, language; notification and auto-backup switches stay per device).
// - localApi.js's routes call recordSyncChanges after each write. Changes wait in the profile's
//   sync_outbox store (one row per record, so the newest version is the one sent) until the
//   server has them. Offline profiles record nothing.
// - A sync sends up to SYNC_BATCH_MAX changes and gets back everything changed since the cursor,
//   in rounds until both sides are through. Incoming changes are applied to IndexedDB, except
//   where this device has a newer change still waiting (newest wins, as on the server).
// - The first sync of a profile on an account (or after signing in again) queues the whole
//   library (queueFullUpload), each record with its own time, so newer changes on the account
//   still win.
// - Lists with the same name from two devices are kept apart and the newer one is renamed
//   "Name (2)" (decided with the user), on every device alike.
// - Changes are stamped with the server's clock, not the device's: each sync reply carries the
//   server's time, and the difference is kept (sync_state.clockOffsetMs). So a phone whose clock
//   is behind still has its newest change win (syncTime).
// - It runs a moment after each page loads, a few seconds after a change, when the device comes
//   back online, and when the app comes back to the screen; Settings has "Sync now".
//
// - For the owner, each sync reply also says how many people are waiting to join
//   (reply.admin.pendingRequests). It's kept on the profile (account.isAdmin, pendingRequests)
//   and shown as a banner linking to the admin page.
//
// Load after serverApi.js, on pages that load localApi.js.

const SYNC_BATCH_MAX = 200; // the server's MAX_CHANGES_IN
const SYNC_BATCH_BYTES = 100 * 1024; // the server takes 128 KB
const SYNC_RECORD_MAX_BYTES = 2000; // the server takes 2 KB per record
const SYNC_MAX_ROUNDS = 60;
const SYNC_AFTER_CHANGE_MS = 2000;
const SYNC_RECENT_MS = 10 * 1000; // a page load or return skips syncing if one finished this recently
const SYNCED_PREF_KEYS = ['theme', 'accent', 'region', 'language'];
const SYNC_EVENT = 'watchlog-synced';
const SYNC_KIND_ORDER = ['list', 'list_item', 'watched_movie', 'watched_episode', 'favorite', 'prefs'];

// ---------- Records ----------

function syncRecordForMovie(row) {
  return { kind: 'watched_movie', key: String(row.tmdbId), data: { tmdbId: row.tmdbId, watchedAt: row.watchedAt, ...pickSummaryFields(row) } };
}

function syncRecordForEpisode(row) {
  return {
    kind: 'watched_episode',
    key: row.key,
    data: { showId: row.showId, seasonNumber: row.seasonNumber, episodeNumber: row.episodeNumber, watchedAt: row.watchedAt },
  };
}

function syncRecordForFavorite(row) {
  return {
    kind: 'favorite',
    key: row.key,
    data: { mediaType: row.mediaType, tmdbId: row.tmdbId, favoritedAt: row.favoritedAt, ...pickSummaryFields(row) },
  };
}

// The Watchlist itself isn't a record: every device has it, under the same sync id.
function syncRecordForList(list) {
  if (list.isDefault) return null;
  return { kind: 'list', key: list.syncId, data: { name: list.name, createdAt: list.createdAt } };
}

function listItemSyncKey(listSyncId, mediaType, tmdbId) {
  return `${listSyncId}:${mediaType}:${tmdbId}`;
}

function syncRecordForListItem(item, list) {
  return {
    kind: 'list_item',
    key: listItemSyncKey(list.syncId, item.mediaType, item.tmdbId),
    data: { list: list.syncId, mediaType: item.mediaType, tmdbId: item.tmdbId, addedAt: item.addedAt },
  };
}

function syncRecordForPrefs(prefs) {
  const data = {};
  SYNCED_PREF_KEYS.forEach(key => { data[key] = prefs[key] === undefined ? null : prefs[key]; });
  return { kind: 'prefs', key: 'prefs', data };
}

function syncTombstone(kind, key) {
  return { kind, key: String(key), deleted: true };
}

function outboxId(kind, key) {
  return `${kind}|${key}`;
}

// ---------- Recording this device's changes ----------

function syncedProfile(profile = getActiveProfile()) {
  return profile && profile.account ? profile : null;
}

// Which account (and which time it was linked) a database's sync state belongs to. Signing in
// again after signing out links anew, so the library is uploaded again.
function syncAccountTag(profile) {
  return `${profile.account.id}@${profile.account.linkedAt || ''}`;
}

function idbTransactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function outboxRow(record, updatedAt) {
  return {
    id: outboxId(record.kind, record.key),
    kind: record.kind,
    key: record.key,
    data: record.deleted ? null : record.data,
    deleted: Boolean(record.deleted),
    updatedAt,
  };
}

function fitsSyncRecord(row) {
  return row.deleted || JSON.stringify(row.data).length <= SYNC_RECORD_MAX_BYTES;
}

// Now, on the server's clock as last measured (the device's own clock until the first sync).
async function syncTime(db) {
  const state = await dbGet(db, 'sync_state', 'state');
  const offset = (state && Number(state.clockOffsetMs)) || 0;
  return new Date(Date.now() + offset).toISOString();
}

// How far the server's clock is from this device's: its time, against the middle of the request.
function measureClockOffset(serverTime, sentAt, receivedAt) {
  const server = Date.parse(serverTime);
  if (!Number.isFinite(server)) return null;
  return Math.round(server - (sentAt + receivedAt) / 2);
}

// Queues changes to the active profile's records, if it's an online profile. `records` are
// syncRecordFor*/syncTombstone results (nulls are skipped).
async function recordSyncChanges(db, records, { updatedAt = null } = {}) {
  if (!syncedProfile()) return;
  if (!updatedAt) updatedAt = await syncTime(db);
  const rows = records.filter(Boolean).map(r => outboxRow(r, updatedAt)).filter(fitsSyncRecord);
  if (!rows.length) return;
  const tx = db.transaction('sync_outbox', 'readwrite');
  const store = tx.objectStore('sync_outbox');
  rows.forEach(row => store.put(row));
  await idbTransactionDone(tx);
  scheduleSync();
}

// Settings calls this after changing preferences; only the synced ones are recorded.
async function recordPrefsChange(updates) {
  if (!syncedProfile() || !Object.keys(updates || {}).some(key => SYNCED_PREF_KEYS.includes(key))) return;
  const db = await getDb();
  await recordSyncChanges(db, [syncRecordForPrefs(getProfilePrefs())]);
}

// The whole library, for a profile's first sync on an account. Each record carries its own time
// (when it was watched, added, favourited), so anything changed on the account since then wins.
// A change already waiting is kept if it's newer.
async function queueFullUpload(db, profile) {
  const [lists, items, movies, episodes, favorites, outbox] = await Promise.all(
    ['lists', 'list_items', 'watched_movies', 'watched_episodes', 'favorites', 'sync_outbox'].map(store => dbGetAll(db, store))
  );
  const listById = new Map(lists.map(l => [l.id, l]));
  const epoch = new Date(0).toISOString();
  const rows = [];
  const add = (record, at) => { if (record) rows.push(outboxRow(record, at || epoch)); };
  lists.forEach(list => add(syncRecordForList(list), list.createdAt));
  items.forEach(item => { const list = listById.get(item.listId); if (list) add(syncRecordForListItem(item, list), item.addedAt); });
  movies.forEach(row => add(syncRecordForMovie(row), row.watchedAt));
  episodes.forEach(row => add(syncRecordForEpisode(row), row.watchedAt));
  favorites.forEach(row => add(syncRecordForFavorite(row), row.favoritedAt));
  // The oldest possible time: an account that already has preferences keeps them.
  add(syncRecordForPrefs(getProfilePrefs(profile)), epoch);

  const waiting = new Map(outbox.map(row => [row.id, row]));
  const tx = db.transaction('sync_outbox', 'readwrite');
  const store = tx.objectStore('sync_outbox');
  rows.filter(fitsSyncRecord).forEach(row => {
    const existing = waiting.get(row.id);
    if (!existing || existing.updatedAt < row.updatedAt) store.put(row);
  });
  await idbTransactionDone(tx);
}

// ---------- Applying the account's changes ----------

function laterList(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? a : b;
  return a.syncId > b.syncId ? a : b;
}

function freeListName(lists, base) {
  const taken = new Set(lists.map(l => l.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    if (!taken.has(`${base} (${n})`)) return `${base} (${n})`;
  }
}

async function findListBySyncId(db, syncId) {
  const matches = await dbGetAllByIndex(db, 'lists', 'syncId', syncId);
  return matches[0] || null;
}

async function deleteListAndItems(db, list) {
  const items = await dbGetAllByIndex(db, 'list_items', 'listId', list.id);
  for (const item of items) await dbDelete(db, 'list_items', item.id);
  await dbDelete(db, 'lists', list.id);
}

// Adds or updates a list from the account. Two different lists with the same name are kept
// apart: the newer one is renamed ("Horror (2)") and the rename synced, so every device agrees.
async function applyListRecord(db, syncId, data) {
  const lists = await dbGetAll(db, 'lists');
  const existing = lists.find(l => l.syncId === syncId);
  const incoming = { ...(existing || {}), syncId, isDefault: false, name: String(data.name || 'List'), createdAt: data.createdAt || new Date().toISOString() };
  const clash = lists.find(l => l.name === incoming.name && l.syncId !== syncId);
  if (clash) {
    const others = lists.filter(l => l.syncId !== syncId);
    if (laterList(incoming, clash) === incoming) {
      incoming.name = freeListName(others, incoming.name);
      await recordSyncChanges(db, [syncRecordForList(incoming)]);
    } else {
      const renamed = { ...clash, name: freeListName(others, clash.name) };
      await dbPut(db, 'lists', renamed);
      await recordSyncChanges(db, [syncRecordForList(renamed)]);
    }
  }
  if (existing) {
    await dbPut(db, 'lists', incoming);
    return incoming;
  }
  const id = await dbAdd(db, 'lists', incoming);
  return { ...incoming, id };
}

async function applyListItemRecord(db, change) {
  const [listSyncId, mediaType, tmdbIdText] = change.key.split(':');
  const tmdbId = Number(tmdbIdText);
  let list = await findListBySyncId(db, listSyncId);
  if (change.deleted) {
    if (!list) return;
    const match = (await dbGetAllByIndex(db, 'list_items', 'listId', list.id)).find(i => i.tmdbId === tmdbId && i.mediaType === mediaType);
    if (match) await dbDelete(db, 'list_items', match.id);
    return;
  }
  // The list's own record can come later (its newest version has a later place in the account's
  // order); until then the item goes on a stand-in that the list's record then updates.
  if (!list) list = await applyListRecord(db, listSyncId, { name: 'List', createdAt: change.data.addedAt });
  const items = await dbGetAllByIndex(db, 'list_items', 'listId', list.id);
  const match = items.find(i => i.tmdbId === tmdbId && i.mediaType === mediaType);
  const row = { listId: list.id, tmdbId, mediaType, addedAt: change.data.addedAt || new Date().toISOString() };
  if (match) await dbPut(db, 'list_items', { ...match, ...row });
  else await dbAdd(db, 'list_items', row);
}

async function applySyncChange(db, change, profile) {
  const { kind, key, data, deleted } = change;
  // Pages sort by these times, so a record without one (another device's older app) gets the
  // change's own time.
  const at = change.updatedAt || new Date().toISOString();
  switch (kind) {
    case 'watched_movie':
      if (deleted) return dbDelete(db, 'watched_movies', Number(key));
      return dbPut(db, 'watched_movies', { ...data, tmdbId: Number(key), watchedAt: data.watchedAt || at });
    case 'watched_episode':
      if (deleted) return dbDelete(db, 'watched_episodes', key);
      return dbPut(db, 'watched_episodes', {
        key, showId: Number(data.showId), seasonNumber: Number(data.seasonNumber), episodeNumber: Number(data.episodeNumber), watchedAt: data.watchedAt || at,
      });
    case 'favorite':
      if (deleted) return dbDelete(db, 'favorites', key);
      return dbPut(db, 'favorites', { ...data, key, tmdbId: Number(data.tmdbId), favoritedAt: data.favoritedAt || at });
    case 'list': {
      if (key === WATCHLIST_SYNC_ID) return undefined;
      if (deleted) {
        const list = await findListBySyncId(db, key);
        return list ? deleteListAndItems(db, list) : undefined;
      }
      return applyListRecord(db, key, data);
    }
    case 'list_item':
      return applyListItemRecord(db, change);
    case 'prefs': {
      if (deleted || !data) return undefined;
      const updates = {};
      SYNCED_PREF_KEYS.forEach(k => { if (data[k] !== undefined) updates[k] = data[k]; });
      setProfilePrefs(profile.id, updates);
      if (typeof window.applyProfileTheme === 'function') window.applyProfileTheme();
      return undefined;
    }
    default:
      return undefined; // a kind from a newer version of the app
  }
}

function sameChange(a, b) {
  return Boolean(a.deleted) === Boolean(b.deleted) && JSON.stringify(a.data || null) === JSON.stringify(b.data || null);
}

// Applies the account's changes, lists first. A change this device still has waiting wins if
// it's newer (the server will keep it too); the same time with other data loses, like on the
// server, where a tie keeps what's stored. Returns how many changed something here.
async function applyIncomingChanges(db, changes, profile) {
  if (!changes.length) return 0;
  const waiting = new Map((await dbGetAll(db, 'sync_outbox')).map(row => [row.id, row]));
  const ordered = changes.slice().sort((a, b) => SYNC_KIND_ORDER.indexOf(a.kind) - SYNC_KIND_ORDER.indexOf(b.kind));
  let applied = 0;
  for (const change of ordered) {
    const id = outboxId(change.kind, change.key);
    const mine = waiting.get(id);
    if (mine) {
      if (mine.updatedAt > change.updatedAt || (mine.updatedAt === change.updatedAt && sameChange(mine, change))) continue;
      await dbDelete(db, 'sync_outbox', id);
      waiting.delete(id);
    }
    await applySyncChange(db, change, profile);
    applied++;
  }
  return applied;
}

// Removes sent changes from the outbox, unless they changed again while being sent.
async function clearSentChanges(db, sent) {
  if (!sent.length) return;
  const current = new Map((await dbGetAll(db, 'sync_outbox')).map(row => [row.id, row]));
  const tx = db.transaction('sync_outbox', 'readwrite');
  const store = tx.objectStore('sync_outbox');
  sent.forEach(row => {
    const now = current.get(row.id);
    if (now && now.updatedAt === row.updatedAt && sameChange(now, row)) store.delete(row.id);
  });
  await idbTransactionDone(tx);
}

// ---------- Syncing ----------

async function readSyncState(db) {
  return (await dbGet(db, 'sync_state', 'state')) || { key: 'state', account: null, cursor: 0, lastSyncAt: null, lastError: null };
}

function takeSyncBatch(outbox) {
  const sorted = outbox.slice().sort((a, b) => SYNC_KIND_ORDER.indexOf(a.kind) - SYNC_KIND_ORDER.indexOf(b.kind));
  const batch = [];
  let bytes = 0;
  for (const row of sorted) {
    const size = JSON.stringify(row).length;
    if (batch.length >= SYNC_BATCH_MAX || (batch.length && bytes + size > SYNC_BATCH_BYTES)) break;
    batch.push(row);
    bytes += size;
  }
  return batch;
}

function wireChange(row) {
  return row.deleted
    ? { kind: row.kind, key: row.key, deleted: true, updatedAt: row.updatedAt }
    : { kind: row.kind, key: row.key, data: row.data, updatedAt: row.updatedAt };
}

async function runSync() {
  const profile = syncedProfile();
  if (!profile) return { status: 'off' };
  if (!isSignedIn(profile)) return { status: 'signed_out' };
  const db = await getDb();
  let state = await readSyncState(db);
  const tag = syncAccountTag(profile);
  if (state.account !== tag) {
    await queueFullUpload(db, profile);
    state = { key: 'state', account: tag, cursor: 0, lastSyncAt: null, lastError: null, clockOffsetMs: state.clockOffsetMs || 0 };
    await dbPut(db, 'sync_state', state);
  }

  let sent = 0;
  let received = 0;
  try {
    for (let round = 0; round < SYNC_MAX_ROUNDS; round++) {
      const outbox = await dbGetAll(db, 'sync_outbox');
      const batch = takeSyncBatch(outbox);
      const sentAt = Date.now();
      const reply = await accountRequest(getActiveProfile() || profile, 'POST', '/v1/sync', { since: state.cursor, changes: batch.map(wireChange) });
      const offset = measureClockOffset(reply.serverTime, sentAt, Date.now());
      if (offset !== null) state = { ...state, clockOffsetMs: offset };
      if (round === 0) noteAdminNews(profile, reply.admin);
      if (round === 0) noteRecovery(profile, reply.recovery);
      if (round === 0) noteFriendRequests(profile, reply.friends);
      received += await applyIncomingChanges(db, reply.changes || [], profile);
      await clearSentChanges(db, batch);
      sent += batch.length;
      state = { ...state, cursor: reply.cursor };
      await dbPut(db, 'sync_state', state);
      if (!reply.more && outbox.length <= batch.length) break;
    }
    state = { ...state, lastSyncAt: new Date().toISOString(), lastError: null };
    await dbPut(db, 'sync_state', state);
  } catch (error) {
    state = { ...state, lastError: { message: error.message || 'Sync failed.', code: error.code || null, at: new Date().toISOString() } };
    await dbPut(db, 'sync_state', state);
    announceSync({ status: 'error', sent, received });
    return { status: 'error', sent, received, error: state.lastError };
  }
  const result = { status: 'synced', sent, received };
  announceSync(result);
  return result;
}

// The owner's sign-up requests, from the sync reply (absent for everyone else).
function noteAdminNews(profile, admin) {
  const current = getProfiles().find(p => p.id === profile.id);
  if (!current || !current.account) return;
  if (admin) updateAccountFields(profile.id, { isAdmin: true, pendingRequests: Number(admin.pendingRequests) || 0 });
  else if (current.account.isAdmin) updateAccountFields(profile.id, { isAdmin: false, pendingRequests: 0 });
}

// Someone recovering this account with its email (recovery.js on the server): every signed-in
// device hears about it on each sync, and shows "Not you? Cancel" until it's over.
function noteRecovery(profile, recovery) {
  const current = getProfiles().find(p => p.id === profile.id);
  if (!current || !current.account) return;
  const next = recovery && recovery.completesAt ? { completesAt: recovery.completesAt } : null;
  const before = current.account.recovery || null;
  if ((before && before.completesAt) !== (next && next.completesAt)) updateAccountFields(profile.id, { recovery: next });
  if (next) showRecoveryWarning();
}

function showRecoveryWarning() {
  if (typeof document === 'undefined' || !document.body || document.querySelector('.recovery-toast')) return;
  document.querySelectorAll('.sync-toast').forEach(t => t.remove());
  const toast = document.createElement('div');
  toast.className = 'sync-toast recovery-toast';
  toast.setAttribute('role', 'alert');
  const text = document.createElement('span');
  text.textContent = 'Someone is recovering your account';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Not you? Cancel';
  cancel.addEventListener('click', async () => {
    const profile = getActiveProfile();
    if (!profile) return;
    const ok = typeof confirmDialog === 'function' ? await confirmDialog({
      title: 'Cancel the recovery?',
      message: "A device asked to recover your account with a code sent to your email. If it wasn't you, cancel it and check that your email account is safe. Your account key stays the same.",
      confirmLabel: 'Cancel the recovery',
      cancelLabel: 'It was me',
      danger: true,
    }) : true;
    if (!ok) return;
    try {
      await cancelAccountRecovery(profile);
      toast.remove();
    } catch (error) {
      if (typeof confirmDialog === 'function') await confirmDialog({ title: "Couldn't cancel", message: error.message || 'Try again.', confirmLabel: 'OK', cancelLabel: 'Close' });
    }
  });
  toast.append(text, cancel);
  document.body.appendChild(toast);
}

// Friend requests waiting for this account (routes/friends.js): the count is kept on the
// account, and a "1 friend request · View" banner shows once per count per browser session.
const FRIEND_BANNER_KEY = 'watchlog_friend_banner_seen';

function noteFriendRequests(profile, friends) {
  const current = getProfiles().find(p => p.id === profile.id);
  if (!current || !current.account) return;
  const count = friends ? Number(friends.incoming) || 0 : 0;
  if ((current.account.friendRequests || 0) !== count) updateAccountFields(profile.id, { friendRequests: count });
  if (count) showFriendRequests(count);
}

function showFriendRequests(count) {
  if (typeof document === 'undefined' || !document.body || document.querySelector('.sync-toast')) return;
  if (/\/friends(\.html)?$/.test(window.location.pathname)) return;
  try {
    if (sessionStorage.getItem(FRIEND_BANNER_KEY) === String(count)) return;
  } catch (error) { /* no storage: just show it */ }
  const toast = document.createElement('div');
  toast.className = 'sync-toast';
  toast.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = count === 1 ? '1 friend request' : `${count} friend requests`;
  const view = document.createElement('a');
  view.className = 'sync-toast__action';
  view.href = 'friends.html';
  view.textContent = 'View';
  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  const seen = () => { try { sessionStorage.setItem(FRIEND_BANNER_KEY, String(count)); } catch (error) { /* fine */ } };
  view.addEventListener('click', seen);
  close.addEventListener('click', () => { seen(); toast.remove(); });
  toast.append(text, view, close);
  document.body.appendChild(toast);
}

function announceSync(detail) {
  if (typeof window.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
  window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail }));
}

let syncInFlight = null;

// Syncs the active profile now (one at a time per page). Resolves { status: 'synced' | 'error'
// | 'off' | 'signed_out', sent, received }.
function syncNow() {
  if (!syncInFlight) syncInFlight = runSync().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

// For Settings: { status: 'off' | 'signed_out' | 'ok' | 'error', pending, lastSyncAt, lastError }.
async function getSyncStatus() {
  const profile = syncedProfile();
  if (!profile) return { status: 'off', pending: 0, lastSyncAt: null, lastError: null };
  const db = await getDb();
  const [state, pending] = await Promise.all([readSyncState(db), dbCount(db, 'sync_outbox')]);
  const current = state.account === syncAccountTag(profile);
  return {
    status: !isSignedIn(profile) ? 'signed_out' : current && state.lastError ? 'error' : 'ok',
    pending,
    lastSyncAt: current ? state.lastSyncAt : null,
    lastError: current ? state.lastError : null,
    syncing: Boolean(syncInFlight),
  };
}

// ---------- When to sync ----------
// Only in a real page (the tests drive syncNow themselves).

let syncAutoEnabled = false;
let syncTimer = null;

function scheduleSync(delay = SYNC_AFTER_CHANGE_MS) {
  if (!syncAutoEnabled) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => autoSync(true), delay);
}

// Another tab of the app may be syncing the same profile; let that one finish.
function withSyncLock(profile, run) {
  if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
    return navigator.locks.request(`watchlog-sync-${profile.id}`, { ifAvailable: true }, lock => (lock ? run() : null));
  }
  return run();
}

async function autoSync(force = false) {
  const profile = syncedProfile();
  if (!profile || !isSignedIn(profile)) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  try {
    if (!force) {
      const status = await getSyncStatus();
      const recent = status.lastSyncAt && Date.now() - Date.parse(status.lastSyncAt) < SYNC_RECENT_MS;
      if (recent && !status.pending) return;
    }
    const result = await withSyncLock(profile, syncNow);
    if (result && result.received > 0) showSyncedChanges();
    else showJoinRequests();
  } catch (error) {
    console.warn('Sync failed:', error);
  }
}

// Changes from other devices are in IndexedDB now, but the page was drawn before them. If the
// person hasn't touched the page yet, it reloads itself; otherwise a notice offers to, so the
// page never jumps under their finger (decided with the user). At most one automatic reload
// every AUTO_RELOAD_GAP_MS, in case changes keep arriving.
const AUTO_RELOAD_GAP_MS = 15 * 1000;
const AUTO_RELOAD_KEY = 'watchlog_sync_reloaded_at';
let pageTouched = false;

function autoReloadAllowed() {
  try {
    const last = Number(sessionStorage.getItem(AUTO_RELOAD_KEY)) || 0;
    if (Date.now() - last < AUTO_RELOAD_GAP_MS) return false;
    sessionStorage.setItem(AUTO_RELOAD_KEY, String(Date.now()));
    return true;
  } catch (error) {
    return false;
  }
}

function showSyncedChanges() {
  if (typeof document === 'undefined') return;
  if (!pageTouched && document.visibilityState !== 'hidden' && autoReloadAllowed()) {
    window.location.reload();
    return;
  }
  offerRefreshAfterSync();
}

// "2 people want to join · Review", for the owner, until they look (per browser session and count).
const JOIN_BANNER_KEY = 'watchlog_join_banner_seen';

function showJoinRequests() {
  if (typeof document === 'undefined' || document.querySelector('.sync-toast')) return;
  if (/\/admin(\.html)?$/.test(window.location.pathname)) return;
  const profile = getActiveProfile();
  const count = profile && profile.account && profile.account.isAdmin ? Number(profile.account.pendingRequests) || 0 : 0;
  if (!count) return;
  try {
    if (sessionStorage.getItem(JOIN_BANNER_KEY) === String(count)) return;
  } catch (error) { /* no storage: just show it */ }
  const toast = document.createElement('div');
  toast.className = 'sync-toast';
  toast.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = count === 1 ? '1 person wants to join' : `${count} people want to join`;
  const review = document.createElement('a');
  review.className = 'sync-toast__action';
  review.href = 'admin.html#requests';
  review.textContent = 'Review';
  const dismiss = () => {
    try { sessionStorage.setItem(JOIN_BANNER_KEY, String(count)); } catch (error) { /* fine */ }
  };
  review.addEventListener('click', dismiss);
  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  close.addEventListener('click', () => { dismiss(); toast.remove(); });
  toast.append(text, review, close);
  document.body.appendChild(toast);
}

function offerRefreshAfterSync() {
  if (typeof document === 'undefined' || document.querySelector('.sync-toast') || /\/settings(\.html)?$/.test(window.location.pathname)) return;
  const toast = document.createElement('div');
  toast.className = 'sync-toast';
  toast.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = 'Updated from your other devices';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Refresh';
  button.addEventListener('click', () => window.location.reload());
  toast.append(text, button);
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 10000);
}

if (typeof window.addEventListener === 'function' && typeof document !== 'undefined') {
  syncAutoEnabled = true;
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(type => window.addEventListener(type, () => { pageTouched = true; }, { passive: true, capture: true }));
  window.addEventListener('load', () => setTimeout(() => autoSync(), 800));
  window.addEventListener('online', () => autoSync(true));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') autoSync();
  });
}
