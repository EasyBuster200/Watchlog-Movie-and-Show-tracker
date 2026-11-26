// The profile picker and sign-in screens (profile-picker.html), drawn into #auth one screen at a
// time:
//   home      Who's watching? - the profiles on this device (Edit / Delete), Sign in, Offline
//             profile, Import backup
//   offline   New offline profile (display name + TMDB token); also Edit profile (an online
//             profile's token is optional: it uses the server's), the last step of restoring a
//             backup (backups never contain the token - see backup.js), and adding a token to a
//             signed-out online profile kept as an offline copy
//   import    Import a backup: choose the .json file
//   restore   Ready to restore: what's in the file, then restore it as an offline profile
//   Online accounts (roadmap Phase 3; calls in serverApi.js):
//   signin    Sign in with the account key
//   pair      Sign in with a one-time code from a signed-in device
//   create    Create an account: just a name, then save-key
//   Online profiles need no TMDB token: they use the server's TMDB proxy, which has the owner's
//   (localApi.js's tmdbAccess). Only offline profiles bring their own.
//   save-key  The account key, with Copy / Save as file and a "type the last 4" check. Also
//             opened from Settings: profile-picker.html?screen=save-key&profile=<id>&next=<page>
//   recover / inbox
//             The recovery email (roadmap Phase 3c); not built yet, so they say so.
//   Hidden behind onlineAccountsEnabled() (serverApi.js) until syncing exists (decided with the
//   user): no button leads to them while it's off.
//
// The screens are plain DOM built from media.js's helpers (ttIcon, buildTextField, el).

const ONLINE_ACCOUNTS = onlineAccountsEnabled();

const authEl = document.getElementById('auth');
const importInput = document.getElementById('import-backup-input');

// The backup being restored: { payload, fileName } between Import and the final form.
let pendingRestore = null;

function initials(displayName) {
  return displayName.trim().split(/\s+/).map(word => word[0]).slice(0, 2).join('').toUpperCase();
}

// ---------- Small pieces ----------

function authMark() {
  const mark = el('div', 'auth__mark');
  mark.innerHTML = ttIcon('play', { size: 28, filled: true });
  return mark;
}

function authHead({ title, text = null, centred = false, mark = centred }) {
  const head = el('div', `auth__head${centred ? ' auth__head--centred' : ''}`);
  if (mark) head.appendChild(authMark());
  head.appendChild(el('h1', 'auth__title', title));
  if (text) head.appendChild(el('p', 'auth__text', text));
  return head;
}

function backButton(onClick) {
  const back = el('button', 'tt-back auth__back');
  back.type = 'button';
  back.setAttribute('aria-label', 'Back');
  back.innerHTML = ttIcon('back', { size: 20, strokeWidth: 2 });
  back.addEventListener('click', onClick);
  return back;
}

function button(label, variant, onClick, { type = 'button', icon = null } = {}) {
  const b = el('button', `tt-btn tt-btn--${variant}`);
  b.type = type;
  if (icon) b.insertAdjacentHTML('beforeend', ttIcon(icon, { size: 18, strokeWidth: 2 }));
  b.appendChild(document.createTextNode(label));
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

function linkButton(label, onClick) {
  const b = el('button', 'tt-link', label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

// "New to Watchlog? Create an account" - a line of muted text ending in a link.
function promptLine(text, linkLabel, onClick) {
  const p = el('p', 'auth__prompt', `${text} `);
  p.appendChild(linkButton(linkLabel, onClick));
  return p;
}

function errorLine() {
  const p = el('p', 'auth-error');
  p.hidden = true;
  p.setAttribute('role', 'alert');
  p.show = message => { p.textContent = message; p.hidden = !message; };
  return p;
}

// Offline profile + Import backup, side by side.
function secondaryPair() {
  const row = el('div', 'auth__pair');
  row.appendChild(button('Offline profile', 'secondary', () => show('offline'), { icon: ONLINE_ACCOUNTS ? null : 'plus' }));
  row.appendChild(button('Import backup', 'secondary', () => show('import')));
  return row;
}

function show(screen, opts = {}) {
  authEl.innerHTML = '';
  window.scrollTo(0, 0);
  SCREENS[screen](opts);
  const first = authEl.querySelector('input');
  if (first && opts.focus !== false && screen !== 'home') first.focus();
}

// ---------- Who's watching? ----------

function profileMeta(profile) {
  const meta = el('span', 'auth-profile__meta');
  // An online profile carries its `account` (serverApi.js). Syncing comes with roadmap Phase 4,
  // so it says "Online account", not "Synced", until then.
  if (profile.account) {
    meta.innerHTML = ttIcon('cloud', { size: 14 });
    meta.appendChild(document.createTextNode(isSignedIn(profile) ? 'Online account' : 'Online account · signed out'));
  } else {
    meta.innerHTML = ttIcon('lock', { size: 14 });
    meta.appendChild(document.createTextNode('Offline · this device only'));
  }
  return meta;
}

// A signed-out online profile signs in again; a profile with neither a session nor its own
// token (an offline copy kept at sign-out) gets a token first. Everything else just opens.
function openProfileFromList(profile) {
  if (profile.account && !isSignedIn(profile) && !profile.tmdbApiKey) {
    setActiveProfileId(profile.id);
    show('signin');
    return;
  }
  if (!profile.account && !profile.tmdbApiKey) {
    show('offline', { profile, notice: 'To use this profile offline, add your own TMDB token.' });
    return;
  }
  setActiveProfileId(profile.id);
  window.location.href = 'main.html';
}

async function deleteWithConfirm(profile) {
  const ok = await confirmDialog({
    title: `Delete ${profile.displayName}?`,
    message: profile.account
      ? 'This deletes the profile and everything it has tracked on this device, and signs this device out of the online account. The account itself isn\'t deleted.'
      : 'This deletes the profile and everything it has tracked on this device. It can\'t be undone.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  if (profile.account) await signOutOnlineAccount(profile).catch(() => {});
  deleteProfile(profile.id);
  show('home');
}

function renderHome() {
  authEl.appendChild(authHead({ title: "Who's watching?", centred: true }));

  const profiles = getProfiles();
  if (profiles.length) {
    const list = el('div', 'auth-profiles');
    profiles.forEach(profile => {
      const row = el('div', 'auth-profile');
      const open = el('button', 'auth-profile__open');
      open.type = 'button';
      open.setAttribute('aria-label', `Open ${profile.displayName}`);
      open.addEventListener('click', () => openProfileFromList(profile));
      open.appendChild(el('span', 'auth-profile__avatar', initials(profile.displayName)));
      const text = el('span', 'auth-profile__text');
      text.appendChild(el('span', 'auth-profile__name', profile.displayName));
      text.appendChild(profileMeta(profile));
      open.appendChild(text);
      row.appendChild(open);

      const edit = el('button', 'auth-profile__action', 'Edit');
      edit.type = 'button';
      edit.setAttribute('aria-label', `Edit ${profile.displayName}`);
      edit.addEventListener('click', () => show('offline', { profile }));
      const del = el('button', 'auth-profile__action auth-profile__action--danger', 'Delete');
      del.type = 'button';
      del.setAttribute('aria-label', `Delete ${profile.displayName}`);
      del.addEventListener('click', () => deleteWithConfirm(profile));
      row.appendChild(edit);
      row.appendChild(del);
      list.appendChild(row);
    });
    authEl.appendChild(list);
  }

  const actions = el('div', 'auth__actions');
  if (ONLINE_ACCOUNTS) actions.appendChild(button('Sign in', 'primary', () => show('signin')));
  actions.appendChild(secondaryPair());
  authEl.appendChild(actions);
  if (ONLINE_ACCOUNTS) authEl.appendChild(promptLine('New to Watchlog?', 'Create an account', () => show('create')));
}

// ---------- New offline profile / Edit / last step of a restore ----------

function renderOfflineForm({ profile = null, restore = null, notice = null } = {}) {
  // A signed-in online profile reaches TMDB through the server, so its own token is optional.
  const tokenOptional = Boolean(profile && isSignedIn(profile));
  authEl.appendChild(backButton(() => show(restore ? 'restore' : 'home')));
  const title = restore ? 'Finish restoring' : profile ? 'Edit profile' : 'New offline profile';
  const text = restore
    ? "Backups don't include a TMDB token, so enter one to finish."
    : profile ? 'Change the name or the TMDB token this profile uses.'
      : 'No account, no email. Just a name and your own TMDB token.';
  authEl.appendChild(authHead({ title, text }));
  if (notice) {
    const note = el('div', 'auth__note');
    note.innerHTML = ttIcon('lock', { size: 18 });
    note.appendChild(el('span', null, notice));
    authEl.appendChild(note);
  }

  const form = el('form', 'auth__form');
  form.noValidate = true;
  const nameField = buildTextField({
    label: 'Display name', icon: 'user', placeholder: 'e.g. Sam', autocomplete: 'nickname', maxLength: 40,
    value: restore ? restore.payload.profile.displayName : profile ? profile.displayName : '',
  });
  const tokenField = buildTextField({
    label: 'TMDB API Read Access Token', type: 'password', icon: 'lock', placeholder: 'Paste your token',
    autocomplete: 'off',
    helper: tokenOptional ? 'Optional: this online profile uses Watchlog\'s. Only needed to use it offline.' : 'The long token on themoviedb.org → Settings → API',
    value: restore ? (legacyBackupApiKey(restore.payload) || '') : profile ? (profile.tmdbApiKey || '') : '',
  });
  tokenField.input.spellcheck = false;
  form.appendChild(nameField);
  form.appendChild(tokenField);

  if (!profile) {
    const note = el('div', 'auth__note');
    note.innerHTML = ttIcon('cloud', { size: 18 });
    note.appendChild(el('span', null, 'Everything stays on this device and nothing syncs. Export a backup from Settings to move it to another device.'));
    form.appendChild(note);
  }

  const error = errorLine();
  form.appendChild(error);
  const row = el('div', 'auth__pair');
  row.appendChild(button('Cancel', 'secondary', () => show(restore ? 'restore' : 'home')));
  const submit = button(restore ? 'Restore backup' : profile ? 'Save changes' : 'Create profile', 'primary', null, { type: 'submit' });
  row.appendChild(submit);
  form.appendChild(row);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const displayName = nameField.input.value.trim();
    const tmdbApiKey = tokenField.input.value.trim();
    nameField.setError(displayName ? null : 'Enter a name.');
    tokenField.setError(tmdbApiKey || tokenOptional ? null : 'Paste your TMDB token.');
    error.show('');
    if (!displayName || (!tmdbApiKey && !tokenOptional)) return;

    const keyChanged = Boolean(tmdbApiKey) && (!profile || profile.tmdbApiKey !== tmdbApiKey);
    const label = submit.textContent;
    submit.disabled = true;
    try {
      if (keyChanged) {
        submit.textContent = 'Checking token…';
        const check = await validateTmdbApiKey(tmdbApiKey);
        if (!check.ok) {
          tokenField.setError(check.message);
          return;
        }
      }
      if (restore) {
        submit.textContent = 'Restoring…';
        const restored = await restoreBackup(restore.payload, { displayName, tmdbApiKey });
        pendingRestore = null;
        setActiveProfileId(restored.id);
        window.location.href = 'main.html';
        return;
      }
      if (profile) updateProfile(profile.id, { displayName, tmdbApiKey: tmdbApiKey || null });
      else createProfile({ displayName, tmdbApiKey });
      if (notice && profile) { openProfileFromList(getProfiles().find(p => p.id === profile.id)); return; }
      show('home');
    } catch (err) {
      console.error('Saving profile failed:', err);
      error.show(err.message || 'Something went wrong saving that profile.');
    } finally {
      submit.disabled = false;
      submit.textContent = label;
    }
  });
  authEl.appendChild(form);
}

// ---------- Import a backup / Ready to restore ----------

function renderImport({ error: message = '' } = {}) {
  authEl.appendChild(backButton(() => show('home')));
  authEl.appendChild(authHead({
    title: 'Import a backup',
    text: 'Restore a profile from a Watchlog backup file. Your shows, movies, lists and watch history come back as they were.',
  }));
  const drop = el('button', 'auth-drop');
  drop.type = 'button';
  const icon = el('span', 'auth-drop__icon');
  icon.innerHTML = ttIcon('folder', { size: 22 });
  drop.appendChild(icon);
  drop.appendChild(el('span', 'auth-drop__title', 'Choose a backup file'));
  drop.appendChild(el('span', 'auth-drop__text', 'The .json file from Settings → Export data or Auto-backup'));
  drop.addEventListener('click', () => importInput.click());
  authEl.appendChild(drop);
  const error = errorLine();
  error.show(message);
  authEl.appendChild(error);
  authEl.appendChild(promptLine('Starting fresh?', 'Back to profiles', () => show('home')));
}

importInput.addEventListener('change', async () => {
  const file = importInput.files[0];
  importInput.value = '';
  if (!file) return;
  try {
    pendingRestore = { payload: await readBackupFile(file), fileName: file.name };
    show('restore');
  } catch (err) {
    console.error('Backup import failed:', err);
    show('import', { error: err.message || "Couldn't read that backup file." });
  }
});

// What a backup holds, for the summary: shows = distinct shows with a watched episode, movies =
// watched movies, lists = the person's own lists (not the Watchlist).
function backupCounts(payload) {
  const data = payload.data;
  return {
    shows: new Set(data.watched_episodes.map(e => e.showId)).size,
    movies: data.watched_movies.length,
    lists: data.lists.filter(l => !l.isDefault).length,
  };
}

function renderRestore() {
  if (!pendingRestore) { show('import'); return; }
  const { payload, fileName } = pendingRestore;
  authEl.appendChild(backButton(() => show('import')));
  authEl.appendChild(authHead({ title: 'Ready to restore', text: "Check what's in the file, then pick how to bring it in." }));

  const card = el('div', 'auth-summary');
  const fileRow = el('div', 'auth-summary__file');
  const check = el('span', 'auth-summary__check');
  check.innerHTML = ttIcon('check', { size: 16, strokeWidth: 2.2 });
  fileRow.appendChild(check);
  fileRow.appendChild(el('span', 'auth-summary__name', fileName));
  fileRow.appendChild(linkButton('Change', () => importInput.click()));
  card.appendChild(fileRow);
  const counts = backupCounts(payload);
  const saved = payload.exportedAt ? new Date(payload.exportedAt) : null;
  [
    ['Profile', payload.profile.displayName],
    ['Shows', counts.shows],
    ['Movies', counts.movies],
    ['Lists', counts.lists],
    ['Saved', saved && !Number.isNaN(saved.getTime()) ? saved.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'Unknown'],
  ].forEach(([label, value]) => {
    const row = el('div', 'auth-summary__row');
    row.appendChild(el('span', null, label));
    row.appendChild(el('span', 'auth-summary__value', String(value)));
    card.appendChild(row);
  });
  authEl.appendChild(card);

  const actions = el('div', 'auth__actions');
  actions.appendChild(button('Restore as offline profile', 'primary', () => show('offline', { restore: pendingRestore })));
  if (ONLINE_ACCOUNTS) actions.appendChild(button('Sign in and restore to my account', 'secondary', () => show('signin', { restore: pendingRestore })));
  authEl.appendChild(actions);
  authEl.appendChild(el('p', 'auth__fine', legacyBackupApiKey(payload)
    ? 'This backup has a TMDB token; you can check it on the next step.'
    : "The backup has no TMDB token, so we'll ask for one next."));
}

// ---------- Online accounts (serverApi.js; hidden until syncing exists) ----------

// Opens a profile, or the page that sent us here (Settings, after saving a new key).
function openProfile(profileId, next = 'main.html') {
  setActiveProfileId(profileId);
  window.location.href = next;
}

// After a sign-in (key or code): the account's profile on this device, if it has one (signed out
// by the server), just gets the new session; otherwise a new profile is made for it (named after
// the account, no TMDB token needed), or the backup being restored becomes that profile. A copy
// kept at sign-out stays a separate offline profile.
async function afterSignIn(signIn, { accountKey = null, restore = null } = {}) {
  const existing = profileForAccount(signIn.account.id);
  if (existing && !restore) {
    linkProfileToAccount(existing.id, signIn, { accountKey, keySaved: Boolean(accountKey) });
    openProfile(existing.id);
    return;
  }
  let profile;
  if (restore) {
    profile = await restoreBackup(restore.payload, { displayName: restore.payload.profile.displayName, tmdbApiKey: null });
    pendingRestore = null;
  } else {
    profile = createProfile({ displayName: signIn.account.displayName, tmdbApiKey: null });
  }
  // Typing the key to sign in shows it was saved.
  linkProfileToAccount(profile.id, signIn, { accountKey, keySaved: Boolean(accountKey) });
  openProfile(profile.id);
}

function renderSignIn({ restore = null } = {}) {
  authEl.appendChild(backButton(() => show(restore ? 'restore' : 'home')));
  authEl.appendChild(authHead({
    title: 'Welcome back',
    text: restore ? 'Sign in, and the backup is restored into your account on this device.' : 'Sign in with your account key.',
    centred: true,
  }));
  const form = el('form', 'auth__form');
  form.noValidate = true;
  const keyField = buildTextField({
    label: 'Account key', type: 'password', icon: 'lock', placeholder: 'XXXX-XXXX-…', autocomplete: 'off',
    aside: linkButton('Lost your key?', () => show('recover')),
  });
  keyField.input.spellcheck = false;
  keyField.input.autocapitalize = 'characters';
  form.appendChild(keyField);
  const error = errorLine();
  form.appendChild(error);
  const submit = button('Sign in', 'primary', null, { type: 'submit' });
  form.appendChild(submit);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const accountKey = keyField.input.value.trim();
    if (!accountKey) { keyField.setError('Enter your account key.'); return; }
    keyField.setError(null);
    error.show('');
    submit.disabled = true;
    try {
      await afterSignIn(await signInWithAccountKey(accountKey), { accountKey, restore });
    } catch (err) {
      if (err.code === 'invalid_key_format' || err.code === 'wrong_key') keyField.setError(err.message);
      else error.show(err.message || 'Something went wrong. Try again.');
    } finally {
      submit.disabled = false;
    }
  });
  authEl.appendChild(form);
  authEl.appendChild(promptLine('Signed in on another device?', 'Use a code from it', () => show('pair', { restore })));
  if (!restore) {
    const or = el('div', 'auth__or');
    or.appendChild(el('span', null, 'or'));
    authEl.appendChild(or);
    authEl.appendChild(secondaryPair());
    authEl.appendChild(promptLine('New to Watchlog?', 'Create an account', () => show('create')));
  }
}

function renderPair({ restore = null } = {}) {
  authEl.appendChild(backButton(() => show('signin', { restore })));
  authEl.appendChild(authHead({
    title: 'Use a code',
    text: 'On a device that is already signed in, open Settings → Add a device. Enter the code it shows.',
  }));
  const form = el('form', 'auth__form');
  form.noValidate = true;
  const codeField = buildTextField({ label: 'Device code', icon: 'lock', placeholder: 'XXXX-XXXX', autocomplete: 'one-time-code', maxLength: 12 });
  codeField.input.spellcheck = false;
  codeField.input.autocapitalize = 'characters';
  form.appendChild(codeField);
  const error = errorLine();
  form.appendChild(error);
  const submit = button('Sign in', 'primary', null, { type: 'submit' });
  form.appendChild(submit);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const code = codeField.input.value.trim();
    if (!code) { codeField.setError('Enter the code from your other device.'); return; }
    codeField.setError(null);
    error.show('');
    submit.disabled = true;
    try {
      await afterSignIn(await signInWithPairingCode(code), { restore });
    } catch (err) {
      if (err.code === 'invalid_code_format' || err.code === 'wrong_code') codeField.setError(err.message);
      else error.show(err.message || 'Something went wrong. Try again.');
    } finally {
      submit.disabled = false;
    }
  });
  authEl.appendChild(form);
  authEl.appendChild(el('p', 'auth__fine', 'Codes work once and expire after 10 minutes.'));
}

function renderCreate() {
  authEl.appendChild(backButton(() => show('home')));
  authEl.appendChild(authHead({ title: 'Create your account', text: 'Track what you watch and pick up where you left off on any device.', centred: true }));
  const form = el('form', 'auth__form');
  form.noValidate = true;
  const nameField = buildTextField({ label: 'Name', icon: 'user', placeholder: 'Your name', autocomplete: 'nickname', maxLength: 40 });
  form.appendChild(nameField);
  const error = errorLine();
  form.appendChild(error);
  const submit = button('Create account', 'primary', null, { type: 'submit' });
  form.appendChild(submit);
  form.appendChild(el('p', 'auth__fine', "Next, you'll get an account key: a long code that signs you in on any device. Keep it somewhere safe. A recovery email is coming in an update."));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const displayName = nameField.input.value.trim();
    nameField.setError(displayName ? null : 'Enter a name.');
    if (!displayName) return;
    error.show('');
    submit.disabled = true;
    try {
      const created = await createOnlineAccount(displayName);
      const profile = createProfile({ displayName: created.account.displayName, tmdbApiKey: null });
      linkProfileToAccount(profile.id, created, { accountKey: created.accountKey });
      show('save-key', { profileId: profile.id });
    } catch (err) {
      console.error('Creating an account failed:', err);
      error.show(err.message || 'Something went wrong. Try again.');
    } finally {
      submit.disabled = false;
    }
  });
  authEl.appendChild(form);
  authEl.appendChild(promptLine('Already have an account?', 'Sign in', () => show('signin')));
}

function keyFileText(profile) {
  return [
    'Watchlog account key',
    '',
    profile.account.accountKey,
    '',
    `Account: ${profile.account.displayName}`,
    `Saved: ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })}`,
    '',
    'This key signs in to your Watchlog account on any device.',
    'Keep it private, like a password: anyone who has it can sign in.',
    '',
  ].join('\n');
}

// The new account key: shown once here, saved, and checked by typing its last 4 characters.
function renderSaveKey({ profileId, next = 'main.html' }) {
  const profile = getProfiles().find(p => p.id === profileId);
  if (!profile || !profile.account || !profile.account.accountKey) { show('home'); return; }
  const key = profile.account.accountKey;

  const head = el('div', 'auth__head auth__head--centred');
  const badge = el('div', 'auth__badge');
  badge.innerHTML = ttIcon('lock', { size: 24 });
  head.appendChild(badge);
  head.appendChild(el('h1', 'auth__title', 'Save your account key'));
  head.appendChild(el('p', 'auth__text', 'It signs you in on any device. Watchlog can\'t show it to you again on another device, so keep it somewhere safe: a password manager, your files, or on paper.'));
  authEl.appendChild(head);

  const keyBox = el('div', 'auth-key');
  keyBox.setAttribute('aria-label', 'Account key');
  key.split('-').forEach(group => keyBox.appendChild(el('span', 'auth-key__group', group)));
  authEl.appendChild(keyBox);

  const status = el('p', 'auth__fine');
  const actions = el('div', 'auth__pair');
  actions.appendChild(button('Copy', 'secondary', async () => {
    try {
      await navigator.clipboard.writeText(key);
      status.textContent = 'Copied.';
    } catch (err) {
      status.textContent = "Couldn't copy. Select the key and copy it, or save it as a file.";
    }
  }, { icon: 'copy' }));
  actions.appendChild(button('Save as file', 'secondary', async () => {
    try {
      if (await saveTextFile(keyFileText(profile), 'watchlog-account-key.txt', { title: 'Watchlog account key' })) status.textContent = 'Saved.';
    } catch (err) {
      console.error('Saving the key failed:', err);
      status.textContent = "Couldn't save the file. Copy the key instead.";
    }
  }, { icon: 'folder' }));
  authEl.appendChild(actions);
  authEl.appendChild(status);

  const form = el('form', 'auth__form');
  form.noValidate = true;
  const confirmField = buildTextField({
    label: `Type the last ${KEY_CONFIRM_LENGTH} characters of your key`, icon: 'check', placeholder: '····', autocomplete: 'off', maxLength: 8,
    helper: 'To make sure it was saved correctly.',
  });
  confirmField.input.spellcheck = false;
  confirmField.input.autocapitalize = 'characters';
  form.appendChild(confirmField);
  form.appendChild(button("I've saved it", 'primary', null, { type: 'submit' }));
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!accountKeyConfirmMatches(key, confirmField.input.value)) {
      confirmField.setError("That doesn't match the end of the key. Check what you saved.");
      return;
    }
    markAccountKeySaved(profileId);
    openProfile(profileId, next);
  });
  authEl.appendChild(form);
  authEl.appendChild(promptLine('Not now?', 'Remind me later in Settings', () => openProfile(profileId, next)));
}

// The recovery email is roadmap Phase 3c (it needs a domain to send from).
const RECOVERY_NOT_READY = "Recovery emails aren't available yet. If you're signed in on another device, use Settings → Add a device there.";

function renderRecover() {
  authEl.appendChild(backButton(() => show('signin')));
  authEl.appendChild(authHead({ title: 'Lost your key?', text: "Enter the recovery email on your account and we'll send you a code to set up a new key." }));
  const form = el('form', 'auth__form');
  form.noValidate = true;
  const emailField = buildTextField({ label: 'Recovery email', type: 'email', icon: 'mail', placeholder: 'you@example.com', autocomplete: 'email', inputMode: 'email' });
  form.appendChild(emailField);
  const error = errorLine();
  form.appendChild(error);
  form.appendChild(button('Send code', 'primary', null, { type: 'submit' }));
  form.addEventListener('submit', event => {
    event.preventDefault();
    const email = emailField.input.value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) { emailField.setError('Enter the email address on your account.'); return; }
    emailField.setError(null);
    error.show(RECOVERY_NOT_READY);
  });
  authEl.appendChild(form);
  authEl.appendChild(promptLine('Signed in on another device?', 'Use a code from it', () => show('pair')));
}

// Shown once the server has sent a recovery code (not reachable until Phase 3c).
function renderInbox({ email = '' } = {}) {
  authEl.appendChild(backButton(() => show('recover')));
  const head = el('div', 'auth__head auth__head--centred');
  const icon = el('div', 'auth__badge');
  icon.innerHTML = ttIcon('mail', { size: 24 });
  head.appendChild(icon);
  head.appendChild(el('h1', 'auth__title', 'Check your inbox'));
  const text = el('p', 'auth__text', 'We sent a code to ');
  text.appendChild(el('strong', null, email || 'your recovery email'));
  text.appendChild(document.createTextNode('. It expires in 30 minutes.'));
  head.appendChild(text);
  authEl.appendChild(head);
  authEl.appendChild(button('Back to sign in', 'primary', () => show('signin')));
  authEl.appendChild(promptLine("Didn't get it? Check spam, or", 'send it again', () => show('recover')));
}

const SCREENS = {
  home: renderHome,
  offline: renderOfflineForm,
  import: renderImport,
  restore: renderRestore,
  signin: renderSignIn,
  pair: renderPair,
  create: renderCreate,
  'save-key': renderSaveKey,
  recover: renderRecover,
  inbox: renderInbox,
};

// Other pages can open a screen directly: ?screen=save-key&profile=<id>&next=settings.html
// (Settings, after a new key), ?screen=offline&profile=<id>&notice=token (a signed-out copy
// that needs its own token), or ?screen=signin (a signed-out profile).
(function start() {
  const params = new URLSearchParams(window.location.search);
  const screen = params.get('screen');
  const profileParam = params.get('profile') && getProfiles().find(p => p.id === params.get('profile'));
  if (screen === 'offline' && profileParam) {
    show('offline', { profile: profileParam, notice: params.get('notice') === 'token' ? "You're signed out, so this copy needs your own TMDB token to keep working offline." : null });
  } else if (screen === 'save-key' && params.get('profile')) {
    show('save-key', { profileId: params.get('profile'), next: params.get('next') || 'main.html' });
  } else if (ONLINE_ACCOUNTS && (screen === 'signin' || screen === 'create')) {
    show(screen);
  } else {
    show('home');
  }
})();
