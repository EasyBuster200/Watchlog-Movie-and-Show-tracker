// The profile picker and sign-in screens (profile-picker.html), drawn into #auth one screen at a
// time:
//   home      Who's watching? - the profiles on this device (Edit / Delete), Sign in, Offline
//             profile, Import backup
//   offline   New offline profile (display name + TMDB token); also Edit profile, and the last
//             step of restoring a backup (backups never contain the token - see backup.js)
//   import    Import a backup: choose the .json file
//   restore   Ready to restore: what's in the file, then restore it as an offline profile
//   signin / create / recover / inbox
//             Online accounts (roadmap Phase 3: an account key, with an optional recovery email).
//             The server side isn't built yet, so these are hidden behind ONLINE_ACCOUNTS
//             (decided with the user): no button leads to them while it's off.
//
// The screens are plain DOM built from media.js's helpers (ttIcon, buildTextField, el).

// Online accounts: off until the server has accounts. For checking the screens during
// development, set localStorage 'watchlog_preview_online_accounts' to '1'.
const ONLINE_ACCOUNTS = (() => {
  try { return localStorage.getItem('watchlog_preview_online_accounts') === '1'; } catch (error) { return false; }
})();

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
  // Online accounts (Phase 3) will carry an `account` on the profile; everything today is local.
  if (profile.account) {
    meta.innerHTML = ttIcon('cloud', { size: 14 });
    meta.appendChild(document.createTextNode(`Synced${profile.account.email ? ` · ${profile.account.email}` : ''}`));
  } else {
    meta.innerHTML = ttIcon('lock', { size: 14 });
    meta.appendChild(document.createTextNode('Offline · this device only'));
  }
  return meta;
}

async function deleteWithConfirm(profile) {
  const ok = await confirmDialog({
    title: `Delete ${profile.displayName}?`,
    message: 'This deletes the profile and everything it has tracked on this device. It can\'t be undone.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
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
      open.addEventListener('click', () => {
        setActiveProfileId(profile.id);
        window.location.href = 'main.html';
      });
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

function renderOfflineForm({ profile = null, restore = null } = {}) {
  authEl.appendChild(backButton(() => show(restore ? 'restore' : 'home')));
  const title = restore ? 'Finish restoring' : profile ? 'Edit profile' : 'New offline profile';
  const text = restore
    ? "Backups don't include a TMDB token, so enter one to finish."
    : profile ? 'Change the name or the TMDB token this profile uses.'
      : 'No account, no email. Just a name and your own TMDB token.';
  authEl.appendChild(authHead({ title, text }));

  const form = el('form', 'auth__form');
  form.noValidate = true;
  const nameField = buildTextField({
    label: 'Display name', icon: 'user', placeholder: 'e.g. Sam', autocomplete: 'nickname', maxLength: 40,
    value: restore ? restore.payload.profile.displayName : profile ? profile.displayName : '',
  });
  const tokenField = buildTextField({
    label: 'TMDB API Read Access Token', type: 'password', icon: 'lock', placeholder: 'Paste your token',
    autocomplete: 'off', helper: 'The long token on themoviedb.org → Settings → API',
    value: restore ? (legacyBackupApiKey(restore.payload) || '') : profile ? profile.tmdbApiKey : '',
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
    tokenField.setError(tmdbApiKey ? null : 'Paste your TMDB token.');
    error.show('');
    if (!displayName || !tmdbApiKey) return;

    const keyChanged = !profile || profile.tmdbApiKey !== tmdbApiKey;
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
      if (profile) updateProfile(profile.id, { displayName, tmdbApiKey });
      else createProfile({ displayName, tmdbApiKey });
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
  if (ONLINE_ACCOUNTS) actions.appendChild(button('Sign in and restore to my account', 'secondary', () => show('signin')));
  authEl.appendChild(actions);
  authEl.appendChild(el('p', 'auth__fine', legacyBackupApiKey(payload)
    ? 'This backup has a TMDB token; you can check it on the next step.'
    : "The backup has no TMDB token, so we'll ask for one next."));
}

// ---------- Online accounts (hidden until the server has them) ----------

const ACCOUNTS_NOT_READY = "Online accounts aren't available yet. Use an offline profile for now.";

function renderSignIn() {
  authEl.appendChild(backButton(() => show('home')));
  authEl.appendChild(authHead({ title: 'Welcome back', text: 'Sign in to sync your shows, movies and lists.', centred: true }));
  const form = el('form', 'auth__form');
  form.noValidate = true;
  const keyField = buildTextField({
    label: 'Account key', type: 'password', icon: 'lock', placeholder: 'WLG4-7KQ2-…', autocomplete: 'off',
    aside: linkButton('Lost your key?', () => show('recover')),
  });
  keyField.input.spellcheck = false;
  keyField.input.autocapitalize = 'characters';
  form.appendChild(keyField);
  const error = errorLine();
  form.appendChild(error);
  form.appendChild(button('Sign in', 'primary', null, { type: 'submit' }));
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!keyField.input.value.trim()) { keyField.setError('Enter your account key.'); return; }
    keyField.setError(null);
    error.show(ACCOUNTS_NOT_READY);
  });
  authEl.appendChild(form);
  const or = el('div', 'auth__or');
  or.appendChild(el('span', null, 'or'));
  authEl.appendChild(or);
  authEl.appendChild(secondaryPair());
  authEl.appendChild(promptLine('New to Watchlog?', 'Create an account', () => show('create')));
}

function renderCreate() {
  authEl.appendChild(backButton(() => show('home')));
  authEl.appendChild(authHead({ title: 'Create your account', text: 'Track what you watch and pick up where you left off on any device.', centred: true }));
  const form = el('form', 'auth__form');
  form.noValidate = true;
  const nameField = buildTextField({ label: 'Name', icon: 'user', placeholder: 'Your name', autocomplete: 'nickname', maxLength: 40 });
  const emailField = buildTextField({
    label: 'Recovery email', type: 'email', icon: 'mail', placeholder: 'you@example.com', autocomplete: 'email',
    helper: 'Optional. Only used if you lose your account key.', inputMode: 'email',
  });
  form.appendChild(nameField);
  form.appendChild(emailField);
  const error = errorLine();
  form.appendChild(error);
  form.appendChild(button('Create account', 'primary', null, { type: 'submit' }));
  form.appendChild(el('p', 'auth__fine', "Next, you'll get an account key: a long code that signs you in on any device. Keep it somewhere safe."));
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!nameField.input.value.trim()) { nameField.setError('Enter a name.'); return; }
    nameField.setError(null);
    error.show(ACCOUNTS_NOT_READY);
  });
  authEl.appendChild(form);
  authEl.appendChild(promptLine('Already have an account?', 'Sign in', () => show('signin')));
}

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
    error.show(ACCOUNTS_NOT_READY);
  });
  authEl.appendChild(form);
  authEl.appendChild(promptLine('Found it?', 'Back to sign in', () => show('signin')));
}

// Shown once the server has sent a recovery code (not reachable until accounts exist).
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
  create: renderCreate,
  recover: renderRecover,
  inbox: renderInbox,
};

show('home');
