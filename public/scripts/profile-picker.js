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
//   create    Create an account: a name, plus what the owner's sign-up mode asks for (an invite
//             code, or a note saying who you are), then save-key. Also turns an offline profile
//             into an online one (?screen=create&upgrade=<profile id>, from Settings).
//   waiting   Waiting for the owner's approval (sign-up mode 'approval'): check again, or
//             withdraw the request
//   Online profiles need no TMDB token: they use the server's TMDB proxy, which has the owner's
//   (localApi.js's tmdbAccess). Only offline profiles bring their own.
//   save-key  The account key, with Copy / Save as file and a "type the last 4" check. Also
//             opened from Settings: profile-picker.html?screen=save-key&profile=<id>&next=<page>
//   recover / inbox
//             The recovery email (roadmap Phase 3c); not built yet, so they say so.
// The screens are plain DOM built from media.js's helpers (ttIcon, buildTextField, el).

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
  row.appendChild(button('Offline profile', 'secondary', () => show('offline')));
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
  // An online profile carries its `account` (serverApi.js).
  if (isPendingAccount(profile) && isSignedIn(profile)) {
    meta.innerHTML = ttIcon('clock', { size: 14 });
    meta.appendChild(document.createTextNode('Waiting for approval'));
  } else if (profile.account) {
    meta.innerHTML = ttIcon('cloud', { size: 14 });
    meta.appendChild(document.createTextNode(isSignedIn(profile) ? 'Synced' : 'Online account · signed out'));
  } else {
    meta.innerHTML = ttIcon('lock', { size: 14 });
    meta.appendChild(document.createTextNode('Offline · this device only'));
  }
  return meta;
}

// A signed-out online profile signs in again; a profile with neither a session nor its own
// token (an offline copy kept at sign-out) gets a token first. Everything else just opens.
function openProfileFromList(profile) {
  if (isPendingAccount(profile) && isSignedIn(profile)) {
    show('waiting', { profileId: profile.id });
    return;
  }
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

  pendingRecoveries().forEach(entry => {
    const row = el('button', 'auth-recovery');
    row.type = 'button';
    row.appendChild(el('span', 'auth-recovery__title', `Recovering ${entry.displayName}`));
    row.appendChild(el('span', 'auth-recovery__sub', `New key ready ${readyTime(entry.completesAt)}`));
    row.addEventListener('click', () => show('recovering', { token: entry.token }));
    authEl.appendChild(row);
  });

  const actions = el('div', 'auth__actions');
  actions.appendChild(button('Sign in', 'primary', () => show('signin')));
  actions.appendChild(secondaryPair());
  authEl.appendChild(actions);
  authEl.appendChild(promptLine('New to Watchlog?', 'Create an account', () => show('create')));
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
  actions.appendChild(button('Sign in and restore to my account', 'secondary', () => show('signin', { restore: pendingRestore })));
  authEl.appendChild(actions);
  authEl.appendChild(el('p', 'auth__fine', legacyBackupApiKey(payload)
    ? 'This backup has a TMDB token; you can check it on the next step.'
    : "The backup has no TMDB token, so we'll ask for one next."));
}

// ---------- Online accounts (serverApi.js; hidden until syncing exists) ----------

// Opens a profile, or the page that sent us here (Settings, after saving a new key). A profile
// still waiting for approval goes to the waiting screen instead.
function openProfile(profileId, next = 'main.html') {
  setActiveProfileId(profileId);
  const profile = getProfiles().find(p => p.id === profileId);
  if (isPendingAccount(profile)) {
    show('waiting', { profileId });
    return;
  }
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
    text: restore ? 'Sign in, and the backup is restored into your account on this device.' : 'Sign in with your account key to sync your shows, movies and lists.',
    centred: true,
  }));
  const form = el('form', 'auth__form');
  form.noValidate = true;
  const keyField = buildTextField({
    label: 'Account key', type: 'password', icon: 'lock', placeholder: 'XXXX-XXXX-…', autocomplete: 'off',
  });
  keyField.input.spellcheck = false;
  keyField.input.autocapitalize = 'characters';
  // "Lost your key?" sits under the field, on the right (the design's SignIn).
  const keyBlock = el('div', 'auth__field-block');
  const lost = linkButton('Lost your key?', () => show('recover'));
  lost.classList.add('auth__lost');
  keyBlock.append(keyField, lost);
  form.appendChild(keyBlock);
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

// What the owner's sign-up mode asks for (serverApi.js's getSignupMode):
//   open / first account  a name
//   invite                a name and an invite code
//   approval              a name, a note for the owner, and an optional invite code (which skips
//                         the wait)
//   closed                nothing: it says so
// `upgrade` is an offline profile (from Settings) that becomes this account, keeping its library.
async function renderCreate({ upgrade = null, values = null } = {}) {
  const upgrading = upgrade ? getProfiles().find(p => p.id === upgrade && !p.account) : null;
  authEl.appendChild(backButton(() => (upgrading ? openProfile(upgrading.id, 'settings.html') : show('home'))));
  const head = authHead({
    title: upgrading ? 'Make it an online account' : 'Create your account',
    text: 'Track what you watch and pick up where you left off on any device.',
    centred: true,
  });
  authEl.appendChild(head);
  const loading = el('p', 'auth__fine', 'Checking who can join…');
  authEl.appendChild(loading);

  let mode = 'open';
  try {
    mode = (await getSignupMode()).mode;
  } catch (err) {
    // Offline or no server: show the plain form; creating the account will say what's wrong.
  }
  loading.remove();

  if (mode === 'closed') {
    authEl.appendChild(el('p', 'auth__text', "Sign-ups are closed right now. If you know the owner of this Watchlog, ask them to open them or send you an invite."));
    authEl.appendChild(promptLine('Already have an account?', 'Sign in', () => show('signin')));
    return;
  }
  if (mode === 'approval') head.appendChild(el('p', 'auth__text', "The owner lets new people in. Ask below; you can use your account once they've approved it."));

  const form = el('form', 'auth__form');
  form.noValidate = true;
  const nameField = buildTextField({ label: 'Name', icon: 'user', placeholder: 'Your name', autocomplete: 'nickname', maxLength: 40 });
  if (upgrading) nameField.input.value = upgrading.displayName;
  if (values) nameField.input.value = values.displayName;
  form.appendChild(nameField);
  const emailField = buildTextField({
    label: 'Email', type: 'email', icon: 'mail', placeholder: 'you@example.com', autocomplete: 'email', inputMode: 'email',
    helper: "To get back in if you lose your key. We'll send a code to check it.",
  });
  if (values) emailField.input.value = values.email;
  form.appendChild(emailField);
  let noteField = null;
  if (mode === 'approval') {
    noteField = buildTextField({ label: 'A note for the owner', icon: 'mail', placeholder: "e.g. Ana's brother", maxLength: 200, helper: 'So they know who you are.' });
    form.appendChild(noteField);
  }
  let inviteField = null;
  if (mode === 'invite' || mode === 'approval') {
    inviteField = buildTextField({
      label: mode === 'invite' ? 'Invite code' : 'Invite code (if you have one)',
      icon: 'lock', placeholder: 'XXXX-XXXX', autocomplete: 'off', maxLength: 12,
      helper: mode === 'invite' ? 'The owner of this Watchlog gives these out.' : "With one, you're in straight away.",
    });
    inviteField.input.spellcheck = false;
    inviteField.input.autocapitalize = 'characters';
    form.appendChild(inviteField);
  }
  const error = errorLine();
  form.appendChild(error);
  if (values && noteField) noteField.input.value = values.note || '';
  if (values && inviteField) inviteField.input.value = values.inviteCode || '';
  const submit = button('Continue', 'primary', null, { type: 'submit' });
  form.appendChild(submit);
  const botSlot = botCheckSlot();
  form.appendChild(botSlot);
  form.appendChild(el('p', 'auth__fine', "After the code, you'll get an account key: a long code that signs you in on any device. Keep it somewhere safe."));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const displayName = nameField.input.value.trim();
    const email = emailField.input.value.trim();
    const inviteCode = inviteField ? inviteField.input.value.trim() : '';
    nameField.setError(displayName ? null : 'Enter a name.');
    emailField.setError(emailLooksValid(email) ? null : 'Enter your email address.');
    if (inviteField) inviteField.setError(mode === 'invite' && !inviteCode ? 'Enter your invite code.' : null);
    if (!displayName || !emailLooksValid(email) || (mode === 'invite' && !inviteCode)) return;
    error.show('');
    submit.disabled = true;
    try {
      await requestSignupCode(email, await passBotCheck(botSlot));
      show('create-code', {
        upgrade: upgrading ? upgrading.id : null,
        form: { mode, displayName, email, inviteCode: inviteCode || null, note: noteField ? noteField.input.value.trim() : null },
      });
    } catch (err) {
      console.error('Sending the sign-up code failed:', err);
      if (err.code === 'invalid_email') emailField.setError(err.message);
      else error.show(err.message || 'Something went wrong. Try again.');
    } finally {
      submit.disabled = false;
    }
  });
  authEl.appendChild(form);
  if (!upgrading) authEl.appendChild(promptLine('Already have an account?', 'Sign in', () => show('signin')));
}

// Waiting for the owner's approval. "Check again" asks the server; once approved, the profile
// opens. If the request was declined (the account deleted), it says so.
function renderWaiting({ profileId }) {
  const profile = getProfiles().find(p => p.id === profileId);
  if (!profile || !profile.account) { show('home'); return; }
  authEl.appendChild(backButton(() => { clearActiveProfile(); show('home'); }));
  const head = el('div', 'auth__head auth__head--centred');
  const badge = el('div', 'auth__badge');
  badge.innerHTML = ttIcon('clock', { size: 24 });
  head.appendChild(badge);
  head.appendChild(el('h1', 'auth__title', 'Waiting for approval'));
  head.appendChild(el('p', 'auth__text', `The owner of this Watchlog needs to let "${profile.account.displayName}" in. Check back any time.`));
  authEl.appendChild(head);
  const status = el('p', 'auth__fine');
  status.setAttribute('role', 'status');
  const check = button('Check again', 'primary', async () => {
    check.disabled = true;
    status.textContent = 'Checking…';
    try {
      const data = await refreshOnlineAccount(profile);
      if (data.account.status === 'active') {
        openProfile(profileId);
        return;
      }
      status.textContent = 'Still waiting. You can close the app; your place is kept.';
    } catch (err) {
      status.textContent = err.code === 'signed_out'
        ? "This request was declined or removed. You can withdraw it below, or ask the owner."
        : err.message;
    } finally {
      check.disabled = false;
    }
  });
  authEl.appendChild(check);
  authEl.appendChild(status);
  authEl.appendChild(promptLine('Changed your mind?', 'Withdraw the request', async () => {
    const ok = await confirmDialog({
      title: 'Withdraw your request?',
      message: profile.tmdbApiKey
        ? 'The request is deleted. This profile stays on this device as an offline profile.'
        : 'The request and this profile on this device are deleted.',
      confirmLabel: 'Withdraw',
      danger: true,
    });
    if (!ok) return;
    if (isSignedIn(profile)) await deleteOnlineAccount(profile).catch(() => unlinkProfileAccount(profile.id));
    else unlinkProfileAccount(profile.id);
    if (!profile.tmdbApiKey) deleteProfile(profile.id);
    clearActiveProfile();
    show('home');
  }));
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

// ---------- Lost your key? (roadmap Phase 3c) ----------
// The email on the account gets a code; entering it starts a 24-hour hold, during which the
// account's signed-in devices can cancel it; after it, this device gets a new key and every
// other device is signed out. Waiting recoveries are kept on this device (serverApi.js's
// pendingRecoveries), so the app can be closed meanwhile.

function emailLooksValid(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

// Where the bot check (serverApi.js's passBotCheck) appears while an email code is being sent.
function botCheckSlot() {
  const slot = el('div', 'bot-check');
  slot.hidden = true;
  return slot;
}

function codeField(label) {
  const field = buildTextField({ label, icon: 'lock', placeholder: '123456', autocomplete: 'one-time-code', maxLength: 6, inputMode: 'numeric' });
  field.input.spellcheck = false;
  return field;
}

function readyTime(iso) {
  return new Date(iso).toLocaleString(undefined, { weekday: 'long', hour: '2-digit', minute: '2-digit' });
}

function renderRecover({ email = '' } = {}) {
  authEl.appendChild(backButton(() => show('signin')));
  authEl.appendChild(authHead({ title: 'Lost your key?', text: "Enter your account's email and we'll send you a code to set up a new key." }));
  const form = el('form', 'auth__form');
  form.noValidate = true;
  const emailField = buildTextField({ label: 'Email', type: 'email', icon: 'mail', placeholder: 'you@example.com', autocomplete: 'email', inputMode: 'email', value: email });
  form.appendChild(emailField);
  const error = errorLine();
  form.appendChild(error);
  const submit = button('Send code', 'primary', null, { type: 'submit' });
  form.appendChild(submit);
  const botSlot = botCheckSlot();
  form.appendChild(botSlot);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const value = emailField.input.value.trim();
    if (!emailLooksValid(value)) { emailField.setError('Enter the email address on your account.'); return; }
    emailField.setError(null);
    error.show('');
    submit.disabled = true;
    try {
      await requestRecoveryCode(value, await passBotCheck(botSlot));
      show('inbox', { email: value });
    } catch (err) {
      error.show(err.message || 'Something went wrong. Try again.');
    } finally {
      submit.disabled = false;
    }
  });
  authEl.appendChild(form);
  authEl.appendChild(promptLine('Signed in on another device?', 'Use a code from it', () => show('pair')));
}

// The recovery code from the email.
function renderInbox({ email = '' } = {}) {
  authEl.appendChild(backButton(() => show('recover', { email })));
  const head = el('div', 'auth__head auth__head--centred');
  const icon = el('div', 'auth__badge');
  icon.innerHTML = ttIcon('mail', { size: 24 });
  head.appendChild(icon);
  head.appendChild(el('h1', 'auth__title', 'Check your inbox'));
  const text = el('p', 'auth__text', 'If an account uses ');
  text.appendChild(el('strong', null, email));
  text.appendChild(document.createTextNode(", we sent it a code. It works for 15 minutes."));
  head.appendChild(text);
  authEl.appendChild(head);
  const form = el('form', 'auth__form');
  form.noValidate = true;
  const field = codeField('Code from the email');
  form.appendChild(field);
  const error = errorLine();
  form.appendChild(error);
  const submit = button('Continue', 'primary', null, { type: 'submit' });
  form.appendChild(submit);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const code = field.input.value.trim();
    if (!code) { field.setError('Enter the code from the email.'); return; }
    field.setError(null);
    error.show('');
    submit.disabled = true;
    try {
      const entry = await startRecovery(email, code);
      show('recovering', { token: entry.token });
    } catch (err) {
      if (err.code === 'wrong_email_code') field.setError(err.message);
      else error.show(err.message || 'Something went wrong. Try again.');
    } finally {
      submit.disabled = false;
    }
  });
  authEl.appendChild(form);
  authEl.appendChild(promptLine("Didn't get it? Check spam, or", 'send it again', () => show('recover', { email })));
}

// Waiting out the hold. "Check now" finishes it once the time has come.
function renderRecovering({ token }) {
  const entry = pendingRecoveries().find(r => r.token === token);
  if (!entry) { show('home'); return; }
  authEl.appendChild(backButton(() => show('home')));
  const head = el('div', 'auth__head auth__head--centred');
  const badge = el('div', 'auth__badge');
  badge.innerHTML = ttIcon('clock', { size: 24 });
  head.appendChild(badge);
  head.appendChild(el('h1', 'auth__title', 'Almost there'));
  head.appendChild(el('p', 'auth__text', `To keep "${entry.displayName}" safe, a new key is ready ${readyTime(entry.completesAt)}. Until then, any device still signed in can cancel this, in case it wasn't you. You can close the app and come back.`));
  authEl.appendChild(head);
  const status = el('p', 'auth__fine');
  status.setAttribute('role', 'status');
  const check = button('Check now', 'primary', async () => {
    check.disabled = true;
    status.textContent = 'Checking…';
    try {
      const signIn = await completeRecovery(entry);
      const existing = profileForAccount(signIn.account.id);
      const profile = existing || createProfile({ displayName: signIn.account.displayName, tmdbApiKey: null });
      linkProfileToAccount(profile.id, signIn, { accountKey: signIn.accountKey });
      show('save-key', { profileId: profile.id });
    } catch (err) {
      if (err.code === 'recovery_waiting') status.textContent = `Not yet: it's ready ${readyTime(entry.completesAt)}.`;
      else if (err.code === 'recovery_cancelled') status.textContent = 'This recovery was cancelled from a signed-in device, or replaced by a newer one.';
      else status.textContent = err.message || 'Something went wrong. Try again.';
    } finally {
      check.disabled = false;
    }
  });
  authEl.appendChild(check);
  authEl.appendChild(status);
  authEl.appendChild(promptLine('Changed your mind?', 'Stop waiting on this device', () => { forgetRecovery(entry.token); show('home'); }));
}

// Sign-up's second step: the code sent to the email. Creating the account needs it.
function renderCreateCode({ form: fields, upgrade = null }) {
  authEl.appendChild(backButton(() => show('create', { upgrade, values: fields })));
  const head = el('div', 'auth__head auth__head--centred');
  const icon = el('div', 'auth__badge');
  icon.innerHTML = ttIcon('mail', { size: 24 });
  head.appendChild(icon);
  head.appendChild(el('h1', 'auth__title', 'Check your inbox'));
  const text = el('p', 'auth__text', 'We sent a code to ');
  text.appendChild(el('strong', null, fields.email));
  text.appendChild(document.createTextNode('. It works for 15 minutes.'));
  head.appendChild(text);
  authEl.appendChild(head);
  const form = el('form', 'auth__form');
  form.noValidate = true;
  const field = codeField('Code from the email');
  form.appendChild(field);
  const error = errorLine();
  form.appendChild(error);
  const submit = button(fields.mode === 'approval' && !fields.inviteCode ? 'Ask to join' : 'Create account', 'primary', null, { type: 'submit' });
  form.appendChild(submit);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const emailCode = field.input.value.trim();
    if (!emailCode) { field.setError('Enter the code from the email.'); return; }
    field.setError(null);
    error.show('');
    submit.disabled = true;
    try {
      const created = await createOnlineAccount(fields.displayName, { email: fields.email, emailCode, inviteCode: fields.inviteCode, note: fields.note });
      const upgrading = upgrade ? getProfiles().find(p => p.id === upgrade && !p.account) : null;
      const profile = upgrading || createProfile({ displayName: created.account.displayName, tmdbApiKey: null });
      linkProfileToAccount(profile.id, created, { accountKey: created.accountKey });
      show('save-key', { profileId: profile.id, next: upgrading ? 'settings.html' : 'main.html' });
    } catch (err) {
      console.error('Creating an account failed:', err);
      if (err.code === 'wrong_email_code') field.setError(err.message);
      else error.show(err.message || 'Something went wrong. Try again.');
    } finally {
      submit.disabled = false;
    }
  });
  authEl.appendChild(form);
  const resendSlot = botCheckSlot();
  authEl.appendChild(promptLine("Didn't get it? Check spam, or", 'send it again', async () => {
    try {
      error.show('');
      await requestSignupCode(fields.email, await passBotCheck(resendSlot));
      error.show('Sent again.');
    } catch (err) {
      error.show(err.message || "Couldn't send it. Try again.");
    }
  }));
  authEl.appendChild(resendSlot);
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
  'create-code': renderCreateCode,
  recover: renderRecover,
  inbox: renderInbox,
  recovering: renderRecovering,
  waiting: renderWaiting,
};

// Other pages can open a screen directly: ?screen=save-key&profile=<id>&next=settings.html
// (Settings, after a new key), ?screen=offline&profile=<id>&notice=token (a signed-out copy
// that needs its own token), ?screen=signin (a signed-out profile), ?screen=create&upgrade=<id>
// (Settings' "Make this an online account") or ?screen=waiting&profile=<id> (waiting for approval).
(function start() {
  const params = new URLSearchParams(window.location.search);
  const screen = params.get('screen');
  const profileParam = params.get('profile') && getProfiles().find(p => p.id === params.get('profile'));
  if (screen === 'offline' && profileParam) {
    show('offline', { profile: profileParam, notice: params.get('notice') === 'token' ? "You're signed out, so this copy needs your own TMDB token to keep working offline." : null });
  } else if (screen === 'save-key' && params.get('profile')) {
    show('save-key', { profileId: params.get('profile'), next: params.get('next') || 'main.html' });
  } else if (screen === 'waiting' && profileParam) {
    show('waiting', { profileId: profileParam.id });
  } else if (screen === 'create') {
    show('create', { upgrade: params.get('upgrade') });
  } else if (screen === 'signin') {
    show(screen);
  } else {
    show('home');
  }
})();

// ---------- Laptop layout: the poster mosaic ----------

// On laptops (the same test as style.css's laptop rules), the sign-in screens sit on the right
// of a split layout with a mosaic of posters on the left (the design's browser layout). The
// posters are this week's trending movies from the server (GET /v1/posters: just poster paths,
// no sign-in needed), loaded from TMDB's image server. Without them (offline, the server's TMDB
// switch off) the mosaic shows plain tiles instead. As drawn: four columns of four posters,
// each column staggered, tilted, under a fade, with the wordmark and a line about the app.
const MOSAIC_COLUMNS = [0, -90, -40, -130];
const MOSAIC_PER_COLUMN = 4;

async function fillPosterMosaic() {
  const mosaic = document.getElementById('auth-mosaic');
  if (!mosaic || mosaic.dataset.filled || !isLaptopLayout()) return;
  mosaic.dataset.filled = '1';
  let posters = [];
  try {
    const response = await fetch(`${serverBaseUrl()}/v1/posters`);
    if (response.ok) posters = ((await response.json()).posters || []).filter(p => typeof p === 'string');
  } catch (error) { /* offline: plain tiles */ }
  const art = el('div', 'auth__mosaic-art');
  art.setAttribute('aria-hidden', 'true');
  let n = 0;
  MOSAIC_COLUMNS.forEach(offset => {
    const column = el('div', 'auth__mosaic-col');
    column.style.marginTop = `${offset}px`;
    for (let i = 0; i < MOSAIC_PER_COLUMN; i++, n++) {
      const tile = el('div', 'auth__mosaic-tile');
      const path = posters.length ? posters[n % posters.length] : null;
      if (path) {
        const img = document.createElement('img');
        img.src = `https://image.tmdb.org/t/p/w342${path}`;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.addEventListener('error', () => img.remove());
        tile.appendChild(img);
      }
      column.appendChild(tile);
    }
    art.appendChild(column);
  });
  const fade = el('div', 'auth__mosaic-fade');
  fade.setAttribute('aria-hidden', 'true');
  const pitch = el('div', 'auth__pitch');
  pitch.appendChild(brandMark('span', 'auth__brand'));
  pitch.appendChild(el('h2', null, 'Every show and movie you watch, in one place.'));
  pitch.appendChild(el('p', null, 'Track episodes, keep a watchlist and see what airs next across your phone and browser.'));
  // The tiles are decoration (hidden above); the wordmark and the line are read out.
  mosaic.removeAttribute('aria-hidden');
  mosaic.append(art, fade, pitch);
}

fillPosterMosaic();
if (window.matchMedia) {
  const laptop = window.matchMedia(LAPTOP_QUERY);
  if (laptop.addEventListener) laptop.addEventListener('change', fillPosterMosaic);
}
