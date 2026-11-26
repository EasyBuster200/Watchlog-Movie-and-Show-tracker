// Settings (opened from the ⋯ on Profile). Everything here is per profile (profiles.js's
// getProfilePrefs/setProfilePrefs) except the account actions:
//   - the profile card: edit the name and TMDB token
//   - Appearance: theme (dark / light / match device) and accent colour (theme.js applies them)
//   - Notifications: new episodes, release reminders, weekly recap (notifications.js)
//   - Library: region and language (used for TMDB requests - localApi.js, profiles.js)
//   - Data & backup: auto-backup on/off, back up now, export, import (autoBackup.js, backup.js)
//   - Online account (serverApi.js, hidden until syncing exists): sync status and Sync now
//     (sync.js), the account key, a new key,
//     add a device (a one-time code), the device list, sign out, delete the account; or, for an
//     offline profile, "Make this an online account"
//   - Account: TMDB token, switch profile, delete profile, reset all data
//   - About: licences, and the installed version

const THEME_OPTIONS = [['dark', 'Dark'], ['light', 'Light'], ['system', 'Match device']];
const ACCENT_NAMES = { burgundy: 'Burgundy', indigo: 'Indigo', ocean: 'Ocean', teal: 'Teal', coral: 'Coral', magenta: 'Magenta', amber: 'Amber' };

let user = null;

function prefs() {
  return getProfilePrefs(user.id);
}

function savePrefs(updates) {
  setProfilePrefs(user.id, updates);
  user = getActiveProfile();
  // Theme, accent, region and language go to the account's other devices (sync.js).
  recordPrefsChange(updates).catch(error => console.warn('Could not record the change for sync:', error));
}

// ---------- Profile card / token ----------

function renderProfileCard() {
  document.getElementById('settings-name').textContent = user.displayName;
  document.getElementById('settings-avatar').textContent = user.displayName.trim().charAt(0).toUpperCase();
}

// Name and TMDB token, as on the profile picker's Edit. A changed token is checked with TMDB
// before it's saved.
function openProfileDialog({ focusToken = false } = {}) {
  const { overlay, modal } = openDialog();
  const form = el('form', 'dialog-form');
  form.appendChild(el('h2', null, 'Edit profile'));

  const nameField = buildTextField({ label: 'Display name', icon: 'user', value: user.displayName, required: true, maxLength: 40 });
  const nameInput = nameField.input;
  const tokenOptional = isSignedIn(user);
  const tokenField = buildTextField({
    label: 'TMDB API Read Access Token', type: 'password', icon: 'lock', value: user.tmdbApiKey || '', required: !tokenOptional,
    autocomplete: 'off',
    helper: tokenOptional ? "Optional: this online profile uses Watchlog's. Only needed to use it offline." : 'The long token on themoviedb.org → Settings → API',
  });
  const tokenInput = tokenField.input;
  tokenInput.spellcheck = false;

  const error = el('p', 'auth-error');
  error.hidden = true;
  const actions = el('div', 'confirm-actions');
  const cancel = dialogButton('Cancel', 'secondary');
  cancel.addEventListener('click', () => overlay.remove());
  const save = dialogButton('Save', 'primary');
  save.type = 'submit';
  actions.appendChild(cancel);
  actions.appendChild(save);

  [nameField, tokenField, error, actions].forEach(node => form.appendChild(node));
  modal.appendChild(form);
  (focusToken ? tokenInput : nameInput).focus();

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const displayName = nameInput.value.trim();
    const tmdbApiKey = tokenInput.value.trim();
    if (!displayName || (!tmdbApiKey && !tokenOptional)) return;
    error.hidden = true;
    save.disabled = true;
    if (tmdbApiKey && tmdbApiKey !== user.tmdbApiKey) {
      save.textContent = 'Checking token…';
      const check = await validateTmdbApiKey(tmdbApiKey);
      if (!check.ok) {
        error.textContent = check.message;
        error.hidden = false;
        save.disabled = false;
        save.textContent = 'Save';
        return;
      }
    }
    updateProfile(user.id, { displayName, tmdbApiKey: tmdbApiKey || null });
    user = getActiveProfile();
    renderProfileCard();
    renderSections();
    overlay.remove();
  });
}

// ---------- Appearance ----------

function renderAppearance() {
  const current = prefs();
  const chips = document.getElementById('theme-chips');
  chips.innerHTML = '';
  THEME_OPTIONS.forEach(([id, label]) => chips.appendChild(buildChip(label, {
    selected: current.theme === id,
    onClick: () => {
      savePrefs({ theme: id });
      window.applyProfileTheme();
      renderAppearance();
    },
  })));

  document.getElementById('accent-name').textContent = ACCENT_NAMES[current.accent] || '';
  const swatches = document.getElementById('accent-swatches');
  swatches.innerHTML = '';
  ACCENT_COLOURS.forEach(id => {
    const on = current.accent === id;
    const btn = el('button', 'swatch');
    btn.type = 'button';
    btn.setAttribute('aria-label', `${ACCENT_NAMES[id]} accent`);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    const dot = el('span', 'swatch__dot');
    dot.style.background = `var(--${id}-mark)`;
    if (on) dot.innerHTML = ttIcon('check', { size: 16, strokeWidth: 2.6 });
    btn.appendChild(dot);
    btn.addEventListener('click', () => {
      savePrefs({ accent: id });
      window.applyProfileTheme();
      renderAppearance();
    });
    swatches.appendChild(btn);
  });
}

// ---------- Rows ----------

function settingsRow({ label, sub = null, value = null, switchOn = null, onSwitch, onClick, danger = false, disabled = false }) {
  const isButton = Boolean(onClick);
  const row = el(isButton ? 'button' : 'div', `settings-row${danger ? ' settings-row--danger' : ''}`);
  if (isButton) {
    row.type = 'button';
    row.disabled = disabled;
    row.addEventListener('click', onClick);
  }
  const text = el('span', 'settings-row__text');
  text.appendChild(el('span', 'settings-row__label', label));
  if (sub) text.appendChild(el('span', 'settings-row__sub', sub));
  row.appendChild(text);

  if (switchOn !== null) {
    const sw = buildSwitch(label, switchOn, onSwitch);
    sw.disabled = disabled;
    row.appendChild(sw);
  } else if (value !== null || (isButton && !danger)) {
    const valueEl = el('span', 'settings-row__value', value || '');
    valueEl.insertAdjacentHTML('beforeend', ttIcon('chevron', { size: 18 }));
    row.appendChild(valueEl);
  }
  return row;
}

function settingsSection(title, rows) {
  const section = el('section', 'settings-section');
  section.appendChild(el('span', 'tt-filter-label', title));
  const card = el('div', 'settings-card');
  rows.filter(Boolean).forEach(row => card.appendChild(row));
  section.appendChild(card);
  return section;
}

// Notifications only exist in the Android app; changing one reschedules everything.
function notificationRows(current) {
  const supported = notificationsSupported();
  const note = text => (supported ? text : 'Available in the Android app');
  const toggle = key => async on => {
    savePrefs({ [key]: on });
    const result = await refreshEpisodeNotifications({ force: true });
    if (result.status === 'denied') {
      await confirmDialog({
        title: 'Notifications are blocked',
        message: 'Allow them in Android Settings > Apps > Watchlog > Notifications.',
        confirmLabel: 'OK',
        cancelLabel: 'Close',
      });
    }
  };
  return [
    settingsRow({ label: 'New episodes', sub: note('When a show you track airs a new episode'), switchOn: current.notifyEpisodes, onSwitch: toggle('notifyEpisodes'), disabled: !supported }),
    settingsRow({ label: 'Release reminders', sub: note('Movies on your Watchlist, on release day'), switchOn: current.releaseReminders, onSwitch: toggle('releaseReminders'), disabled: !supported }),
    settingsRow({ label: 'Weekly recap', sub: note('What you watched and what is coming up, Sundays at 19:00'), switchOn: current.weeklyRecap, onSwitch: toggle('weeklyRecap'), disabled: !supported }),
  ];
}

// ---------- Region and language pickers ----------

function displayName(type, code) {
  try {
    return new Intl.DisplayNames(['en'], { type, languageDisplay: 'standard' }).of(code) || code;
  } catch (error) {
    return code;
  }
}

function languageName(tag) {
  return displayName('language', tag);
}

let countriesPromise = null;
function loadCountries() {
  if (!countriesPromise) {
    countriesPromise = fetchJson('/api/tmdb/configuration/countries')
      .then(list => list.map(c => ({ value: c.iso_3166_1, label: c.english_name })).sort((a, b) => a.label.localeCompare(b.label)))
      .catch(error => { countriesPromise = null; throw error; });
  }
  return countriesPromise;
}

let languagesPromise = null;
function loadLanguages() {
  if (!languagesPromise) {
    languagesPromise = fetchJson('/api/tmdb/configuration/primary_translations')
      .then(tags => tags.map(tag => ({ value: tag, label: languageName(tag) })).sort((a, b) => a.label.localeCompare(b.label)))
      .catch(error => { languagesPromise = null; throw error; });
  }
  return languagesPromise;
}

// A searchable single-choice list. Resolves to the picked value, or undefined when closed.
function pickFromList({ title, placeholder, load, current, extra = [] }) {
  return new Promise(resolve => {
    const { overlay, modal } = openDialog();
    const close = value => { overlay.remove(); resolve(value); };
    modal.appendChild(el('h2', null, title));
    const search = el('label', 'tt-search');
    search.innerHTML = ttIcon('search', { size: 20 });
    const input = el('input');
    input.type = 'search';
    input.placeholder = placeholder;
    search.appendChild(input);
    modal.appendChild(search);
    const list = el('div', 'select-list');
    list.setAttribute('role', 'listbox');
    list.appendChild(el('p', 'muted-note', 'Loading…'));
    modal.appendChild(list);
    const cancel = dialogButton('Cancel', 'secondary');
    cancel.addEventListener('click', () => close(undefined));
    modal.appendChild(cancel);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(undefined); });

    let options = [];
    const render = () => {
      const q = input.value.trim().toLowerCase();
      list.innerHTML = '';
      const shown = [...extra, ...options].filter(o => !q || o.label.toLowerCase().includes(q) || String(o.value || '').toLowerCase().includes(q));
      if (!shown.length) list.appendChild(el('p', 'muted-note', 'No matches.'));
      shown.forEach(o => {
        const item = el('button', 'select-list__item');
        item.type = 'button';
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', o.value === current ? 'true' : 'false');
        item.appendChild(el('span', null, o.label));
        if (o.value === current) item.insertAdjacentHTML('beforeend', ttIcon('check', { size: 18, strokeWidth: 2.2 }));
        item.addEventListener('click', () => close(o.value));
        list.appendChild(item);
      });
    };
    input.addEventListener('input', render);
    load()
      .then(loaded => { options = loaded; render(); })
      .catch(() => { list.innerHTML = ''; list.appendChild(el('p', 'muted-note', "Couldn't load the list. Check your connection.")); });
  });
}

async function chooseRegion() {
  const auto = profileRegion({ ...user, prefs: { ...(user.prefs || {}), region: null } });
  const value = await pickFromList({
    title: 'Region',
    placeholder: 'Search countries…',
    load: loadCountries,
    current: prefs().region,
    extra: [{ value: null, label: `Automatic (${displayName('region', auto)})` }],
  });
  if (value === undefined) return;
  savePrefs({ region: value });
  renderSections();
  refreshEpisodeNotifications({ force: true }).catch(() => {});
}

async function chooseLanguage() {
  const value = await pickFromList({ title: 'Language', placeholder: 'Search languages…', load: loadLanguages, current: prefs().language });
  if (value === undefined) return;
  savePrefs({ language: value });
  renderSections();
}

// ---------- Data & backup ----------

function formatBackupDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function autoBackupSub(current) {
  if (user.account) return 'Not needed: your library is saved to your online account';
  if (!isNativeApp()) return 'Available in the Android app';
  if (!current.autoBackup) return 'Off';
  const info = getAutoBackupInfo(user.id);
  if (info && info.lastError) return `Last attempt failed: ${info.lastError}`;
  if (info && info.savedAt) return `Last saved ${formatBackupDate(info.savedAt)} · Documents/Watchlog`;
  return 'Weekly, to Documents/Watchlog';
}

async function backUpNow(row) {
  row.disabled = true;
  await runAutoBackups({ force: true, profileIds: [user.id] });
  renderSections();
}

// The web app has no automatic backup, so the row says when this profile last exported one.
function exportSub() {
  const last = getLastBackupExport(user.id);
  if (isNativeApp() || !last) return 'Save your library as a JSON file';
  return `Last exported ${formatBackupDate(last)}`;
}

async function exportData(row) {
  row.disabled = true;
  try {
    if (await exportBackup(user)) renderSections();
  } catch (error) {
    console.error('Backup export failed:', error);
    await confirmDialog({ title: 'Export failed', message: 'Something went wrong creating the backup file.', confirmLabel: 'OK', cancelLabel: 'Close' });
  }
  row.disabled = false;
}

// Restores a backup as a new profile. Backups never carry a TMDB token (backup.js), so the new
// profile uses this one's.
function initImport() {
  const input = document.getElementById('import-app-input');
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    try {
      const payload = await readBackupFile(file);
      const profile = await restoreBackup(payload, {
        displayName: payload.profile.displayName,
        tmdbApiKey: legacyBackupApiKey(payload) || user.tmdbApiKey,
      });
      const switchNow = await confirmDialog({
        title: 'Backup imported',
        message: `Imported as a new profile, "${profile.displayName}". It uses the same TMDB token as this profile.`,
        confirmLabel: 'Switch to it',
        cancelLabel: 'Stay here',
      });
      if (switchNow) {
        setActiveProfileId(profile.id);
        window.location.href = 'main.html';
      }
    } catch (error) {
      console.error('Backup import failed:', error);
      await confirmDialog({ title: "Couldn't import", message: error.message || 'Could not import that backup file.', confirmLabel: 'OK', cancelLabel: 'Close' });
    }
  });
}

// ---------- Online account (serverApi.js) ----------

function showServerError(err, title = 'Something went wrong') {
  console.error(title, err);
  return confirmDialog({ title, message: (err && err.message) || 'Try again in a moment.', confirmLabel: 'OK', cancelLabel: 'Close' });
}

// Runs an account action; a "signed out" reply re-renders the section (the profile keeps its
// account, minus the session) instead of only showing an error.
async function accountAction(action, title) {
  try {
    return await action();
  } catch (err) {
    user = getActiveProfile();
    renderSections();
    await showServerError(err, err && err.code === 'signed_out' ? 'Signed out' : title);
    return undefined;
  }
}

function saveKeyUrl() {
  return `profile-picker.html?screen=save-key&profile=${encodeURIComponent(user.id)}&next=settings.html`;
}

// The picker's create screen does it (it asks for whatever the sign-up mode needs: an invite
// code, or a note for the owner), keeping this profile and its library.
async function makeOnline() {
  const ok = await confirmDialog({
    title: 'Make this an online account?',
    message: `"${user.displayName}" becomes an online account you can sign in to on other devices, and everything in it is kept in sync. Everything stays on this device too.`,
    confirmLabel: 'Continue',
  });
  if (!ok) return;
  window.location.href = `profile-picker.html?screen=create&upgrade=${encodeURIComponent(user.id)}`;
}

async function showAccountKey() {
  if (user.account.accountKey) {
    window.location.href = saveKeyUrl();
    return;
  }
  const ok = await confirmDialog({
    title: 'Account key',
    message: "This device was signed in with a code, so it doesn't have the key. If you've lost it, make a new one: the old key stops working, and your signed-in devices stay signed in.",
    confirmLabel: 'Make a new key',
  });
  if (ok) await newAccountKey({ confirmed: true });
}

async function newAccountKey({ confirmed = false } = {}) {
  if (!confirmed) {
    const ok = await confirmDialog({
      title: 'Make a new account key?',
      message: 'The current key stops working straight away. Devices that are signed in stay signed in.',
      confirmLabel: 'Make a new key',
    });
    if (!ok) return;
  }
  if (await accountAction(() => makeNewAccountKey(user), "Couldn't make a new key")) window.location.href = saveKeyUrl();
}

async function addDevice() {
  const pairing = await accountAction(() => createPairingCode(user), "Couldn't make a code");
  if (!pairing) return;
  const { overlay, modal } = openDialog();
  modal.appendChild(el('h2', null, 'Add a device'));
  modal.appendChild(el('p', null, 'On the other device, open Watchlog, choose Sign in → "Use a code from it", and enter:'));
  modal.appendChild(el('div', 'code-display', pairing.code));
  const minutes = Math.max(1, Math.round((Date.parse(pairing.expiresAt) - Date.now()) / 60000));
  modal.appendChild(el('p', 'settings-row__sub', `Works once, for the next ${minutes} minutes.`));
  const actions = el('div', 'confirm-actions');
  const done = dialogButton('Done', 'primary');
  done.addEventListener('click', () => overlay.remove());
  actions.appendChild(done);
  modal.appendChild(actions);
}

function formatDeviceTime(iso) {
  const date = new Date(iso);
  const days = Math.floor((Date.now() - date) / (24 * 60 * 60 * 1000));
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

async function showDevices() {
  const devices = await accountAction(() => listAccountDevices(user), "Couldn't load your devices");
  if (!devices) return;
  const { overlay, modal } = openDialog();
  modal.appendChild(el('h2', null, 'Signed-in devices'));
  const list = el('div', 'device-list');
  devices.forEach(device => {
    const row = el('div', 'device-row');
    const text = el('div', 'device-row__text');
    text.appendChild(el('span', 'device-row__name', device.current ? `${device.deviceName} (this device)` : device.deviceName));
    text.appendChild(el('span', 'device-row__meta', `Last used ${formatDeviceTime(device.lastUsedAt)} · added ${formatDeviceTime(device.createdAt)}`));
    row.appendChild(text);
    if (!device.current) {
      const out = dialogButton('Sign out', 'secondary');
      out.classList.add('device-row__action');
      out.addEventListener('click', async () => {
        out.disabled = true;
        const result = await accountAction(() => signOutAccountDevice(user, device.id).then(() => true), "Couldn't sign that device out");
        if (result) row.remove();
        else out.disabled = false;
      });
      row.appendChild(out);
    }
    list.appendChild(row);
  });
  modal.appendChild(list);
  modal.appendChild(el('p', 'settings-row__sub', 'Signing a device out ends its sign-in. What it already has stays on it as an offline profile.'));
  const actions = el('div', 'confirm-actions');
  const done = dialogButton('Done', 'primary');
  done.addEventListener('click', () => overlay.remove());
  actions.appendChild(done);
  modal.appendChild(actions);
}

// "Keep a copy" or "Remove it" when signing out (decided with the user: ask each time). Resolves
// 'keep', 'remove', or null when cancelled.
function keepOrRemoveDialog({ title, message, danger = false }) {
  return new Promise(resolve => {
    const { overlay, modal } = openDialog();
    modal.appendChild(el('h2', null, title));
    modal.appendChild(el('p', null, message));
    const actions = el('div', 'confirm-actions confirm-actions--stacked');
    const close = result => { overlay.remove(); resolve(result); };
    const keep = dialogButton(isNativeApp() ? 'Keep a copy on this device' : 'Keep a copy in this browser', danger ? 'secondary' : 'primary');
    keep.addEventListener('click', () => close('keep'));
    const remove = dialogButton(isNativeApp() ? 'Remove it from this device' : 'Remove it from this browser', danger ? 'danger' : 'secondary');
    remove.addEventListener('click', () => close('remove'));
    const cancel = dialogButton('Cancel', 'secondary');
    cancel.addEventListener('click', () => close(null));
    [keep, remove, cancel].forEach(b => actions.appendChild(b));
    modal.appendChild(actions);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(null); });
  });
}

// After signing out or deleting the account: keep the profile as an offline one (it then needs
// its own TMDB token, since the server's is for signed-in accounts), or remove it.
function afterLeavingAccount(choice) {
  if (choice === 'remove') {
    deleteProfile(user.id);
    window.location.href = 'profile-picker.html';
    return;
  }
  user = getActiveProfile();
  if (!user.tmdbApiKey) {
    window.location.href = `profile-picker.html?screen=offline&profile=${encodeURIComponent(user.id)}&notice=token`;
    return;
  }
  renderSections();
}

async function signOutThisDevice() {
  const choice = await keepOrRemoveDialog({
    title: 'Sign out of the online account?',
    message: `Keep "${user.displayName}" here as a separate offline profile, with everything in it (it then needs your own TMDB token), or remove it, for example on a shared computer. Signing in again later starts from what's on your account; a kept copy stays separate.`,
  });
  if (!choice) return;
  if ((await accountAction(() => signOutOnlineAccount(user).then(() => true), "Couldn't sign out")) === undefined) return;
  afterLeavingAccount(choice);
}

async function deleteAccount() {
  const ok = await confirmDialog({
    title: 'Delete the online account?',
    message: 'This deletes the account on the server and signs out every device. It can\'t be undone.',
    confirmLabel: 'Delete account',
    danger: true,
  });
  if (!ok) return;
  const choice = await keepOrRemoveDialog({
    title: `And "${user.displayName}" on this device?`,
    message: 'Keep it as an offline profile, with everything in it (it then needs your own TMDB token), or remove it too.',
  });
  if (!choice) return;
  if ((await accountAction(() => deleteOnlineAccount(user).then(() => true), "Couldn't delete the account")) === undefined) return;
  afterLeavingAccount(choice);
}

// ---------- Sync (sync.js) ----------

function syncTimeText(iso) {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function syncStatusText(status) {
  if (status.syncing) return 'Syncing…';
  if (status.status === 'error') return `Couldn't sync: ${status.lastError.message}`;
  const waiting = status.pending ? `${status.pending} change${status.pending === 1 ? '' : 's'} waiting to sync` : null;
  if (!status.lastSyncAt) return waiting || 'Not synced yet';
  return waiting ? `${waiting} · last synced ${syncTimeText(status.lastSyncAt)}` : `Synced ${syncTimeText(status.lastSyncAt)}`;
}

// The Sync row, kept up to date when a sync runs on its own (sync.js's SYNC_EVENT).
let currentSyncRow = null;
window.addEventListener(SYNC_EVENT, () => { if (currentSyncRow && currentSyncRow.isConnected) showSyncStatus(currentSyncRow); });

async function showSyncStatus(row) {
  const sub = row.querySelector('.settings-row__sub');
  if (!sub) return;
  try {
    sub.textContent = syncStatusText(await getSyncStatus());
  } catch (error) {
    sub.textContent = "Couldn't read the sync status";
  }
}

async function syncFromSettings(row) {
  if (row.classList.contains('is-busy')) return;
  row.classList.add('is-busy');
  const sub = row.querySelector('.settings-row__sub');
  if (sub) sub.textContent = 'Syncing…';
  await syncNow().catch(() => {});
  row.classList.remove('is-busy');
  await showSyncStatus(row);
}

// The "Online account" section: nothing while online accounts are hidden, unless this profile
// already has one.
function onlineAccountSection() {
  const account = user.account;
  if (!account) {
    return settingsSection('Online account', [
      settingsRow({ label: 'Make this an online account', sub: 'Sign in to it on your other devices', onClick: makeOnline }),
    ]);
  }
  if (!isSignedIn(user)) {
    return settingsSection('Online account', [
      settingsRow({
        label: 'Signed out',
        sub: `This device is no longer signed in to ${account.displayName}'s account. Sign in again with your key.`,
        value: 'Sign in',
        onClick: () => { window.location.href = 'profile-picker.html?screen=signin'; },
      }),
      settingsRow({ label: 'Make it an offline profile', sub: 'Keep everything on this device, without the account', onClick: () => { unlinkProfileAccount(user.id); afterLeavingAccount('keep'); } }),
    ]);
  }
  const adminRow = account.isAdmin ? settingsRow({
    label: 'Admin page',
    sub: account.pendingRequests ? `${account.pendingRequests} waiting to join` : 'Sign-ups, invites, users and limits',
    onClick: () => { window.location.href = 'admin.html'; },
  }) : null;
  const syncRow = settingsRow({ label: 'Sync', sub: 'Checking…', value: 'Sync now', onClick: () => syncFromSettings(syncRow) });
  currentSyncRow = syncRow;
  showSyncStatus(syncRow);
  return settingsSection('Online account', [
    adminRow,
    syncRow,
    settingsRow({
      label: 'Account key',
      sub: account.keySavedAt ? 'Saved' : account.accountKey ? 'Not saved yet. Save it now.' : 'Not on this device',
      value: account.accountKey ? 'Show' : null,
      onClick: showAccountKey,
    }),
    settingsRow({ label: 'Make a new key', sub: 'If yours was lost or seen by someone else', onClick: () => newAccountKey() }),
    settingsRow({ label: 'Add a device', sub: 'A one-time code to sign in on another device', onClick: addDevice }),
    settingsRow({ label: 'Signed-in devices', onClick: showDevices }),
    settingsRow({ label: 'Sign out of this device', sub: 'Keeps this profile here as an offline one', onClick: signOutThisDevice }),
    settingsRow({ label: 'Delete online account', sub: 'Deletes it on the server for every device', danger: true, onClick: deleteAccount }),
  ]);
}

// ---------- Account ----------

async function deleteThisProfile() {
  const ok = await confirmDialog({
    title: 'Delete profile?',
    message: `Delete "${user.displayName}" and all of its watched and list data from this phone? This can't be undone.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  // An online profile's sign-in ends too; the account itself stays (delete it above for that).
  if (user.account) await signOutOnlineAccount(user).catch(() => {});
  deleteProfile(user.id);
  window.location.href = 'profile-picker.html';
}

async function resetAllData() {
  const online = Boolean(user.account);
  const ok = await confirmDialog({
    title: 'Reset all data?',
    message: online
      ? `This removes everything in "${user.displayName}"'s library on every device signed in to this account: watched history, lists, Watchlist and favourites. The account, the profile and its settings stay. This can't be undone.`
      : `This removes everything in "${user.displayName}"'s library from this phone: watched history, lists, Watchlist and favourites. The profile, its token and settings stay. This can't be undone.`,
    confirmLabel: 'Reset',
    danger: true,
  });
  if (!ok) return;
  // Online: fetch what the account has first, so the reset deletes that too, and send the
  // deletions straight away. If this device is offline they go on its next sync.
  if (online) await syncNow().catch(() => {});
  await fetch('/api/reset', { method: 'POST', credentials: 'same-origin' });
  if (online) await syncNow().catch(() => {});
  refreshEpisodeNotifications({ force: true }).catch(() => {});
  window.location.href = 'profile.html';
}

// ---------- Sections ----------

function renderSections() {
  const current = prefs();
  const container = document.getElementById('settings-sections');
  container.innerHTML = '';
  container.className = 'stack';
  container.style.gap = 'var(--space-6)';

  container.appendChild(settingsSection('Notifications', notificationRows(current)));

  container.appendChild(settingsSection('Library', [
    settingsRow({
      label: 'Region',
      sub: 'For Popular, release dates and reminders',
      value: current.region ? displayName('region', current.region) : `Automatic (${displayName('region', profileRegion(user))})`,
      onClick: chooseRegion,
    }),
    settingsRow({ label: 'Language', sub: 'Titles, overviews and episode names', value: languageName(current.language), onClick: chooseLanguage }),
  ]));

  const backupNow = user.account ? null : settingsRow({ label: 'Back up now', onClick: () => backUpNow(backupNow), disabled: !isNativeApp() });
  const exportRow = settingsRow({ label: 'Export data', sub: exportSub(), onClick: () => exportData(exportRow) });
  container.appendChild(settingsSection('Data & backup', [
    settingsRow({
      label: 'Auto-backup',
      sub: autoBackupSub(current),
      switchOn: user.account ? false : current.autoBackup,
      disabled: !isNativeApp() || Boolean(user.account),
      onSwitch: on => { savePrefs({ autoBackup: on }); renderSections(); },
    }),
    backupNow,
    exportRow,
    settingsRow({ label: 'Import data', sub: 'Restores a backup as a new profile', onClick: () => document.getElementById('import-app-input').click() }),
  ].filter(Boolean)));

  const online = onlineAccountSection();
  if (online) container.appendChild(online);

  container.appendChild(settingsSection('Account', [
    isSignedIn(user)
      ? settingsRow({ label: 'TMDB token', sub: "Not needed: this online profile uses Watchlog's", value: user.tmdbApiKey ? 'Change' : 'Add', onClick: () => openProfileDialog({ focusToken: true }) })
      : settingsRow({ label: 'TMDB token', sub: 'The API Read Access Token this profile uses', value: 'Change', onClick: () => openProfileDialog({ focusToken: true }) }),
    settingsRow({ label: 'Switch profile', onClick: () => logout() }),
    settingsRow({ label: 'Reset all data', sub: user.account ? 'Empties this library on every signed-in device' : 'Empties this profile\'s library on this phone', danger: true, onClick: resetAllData }),
    settingsRow({ label: 'Delete profile', sub: 'Removes the profile and all its data from this phone', danger: true, onClick: deleteThisProfile }),
  ]));

  container.appendChild(settingsSection('About', [
    settingsRow({ label: 'Licences', onClick: () => { window.location.href = 'licences.html'; } }),
  ]));
}

// The web app's version comes from version.json, written when the site is deployed
// (tools/write-web-version.js). Serving public/ locally has none.
async function webVersionLabel() {
  try {
    const response = await fetch('version.json', { cache: 'no-store' });
    if (!response.ok) return 'Watchlog · web preview';
    const info = await response.json();
    if (info.versionName) return `Watchlog · version ${info.versionName} (web)`;
    return info.commit ? `Watchlog · web build ${info.commit}` : 'Watchlog · web';
  } catch (error) {
    return 'Watchlog · web';
  }
}

// The installed version comes from the app's own native plugin.
async function renderVersion() {
  const versionEl = document.getElementById('app-version');
  const plugin = typeof backgroundPlugin === 'function' ? backgroundPlugin() : null;
  if (!isNativeApp() || !plugin) {
    versionEl.textContent = await webVersionLabel();
    return;
  }
  try {
    const info = await plugin.getAppInfo();
    versionEl.textContent = `Watchlog · version ${info.versionName}`;
  } catch (error) {
    versionEl.textContent = 'Watchlog';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  user = await requireLogin();
  if (!user) return;
  renderProfileCard();
  document.getElementById('settings-profile').addEventListener('click', () => openProfileDialog());
  renderAppearance();
  renderSections();
  initImport();
  renderVersion();
});
