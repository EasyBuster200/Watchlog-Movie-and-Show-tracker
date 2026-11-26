// The owner's admin page (admin.html; roadmap Phase 8 part 1), on top of the server's
// /v1/admin/... API (server/src/routes/admin.js). It uses the session of an online profile on
// this device whose account is the admin (the server's ADMIN_ACCOUNT_IDS secret). There's no
// separate admin password: being signed in as the owner on this device is what lets you in.
//
// Sections: notifications on this device (Web Push), sign-up requests (approve / decline),
// numbers, the sign-up mode, invites, users (sign out, suspend, delete), the TMDB proxy's switch
// and daily cap, and the activity log. People's libraries are never shown: counts only.

const adminEl = document.getElementById('admin');
let adminProfile = null;

const SIGNUP_MODE_TEXT = {
  closed: ['Closed', 'Nobody new can make an account.'],
  invite: ['Invite only', 'New accounts need an invite code from here.'],
  approval: ['Approval', 'Anyone can ask; you approve them here. An invite code skips the wait.'],
  open: ['Open', 'Anyone can make an account (still rate limited).'],
};

const ACTION_TEXT = {
  approve: 'Approved', decline: 'Declined', delete: 'Deleted', suspend: 'Suspended', unsuspend: 'Unsuspended',
  'sign-out': 'Signed out', 'invite.create': 'Made an invite', 'invite.cancel': 'Cancelled an invite', settings: 'Changed settings',
};

function adminRequest(method, path, body) {
  return accountRequest(adminProfile, method, `/v1/admin${path}`, body);
}

function when(iso) {
  if (!iso) return 'never';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function section(title, id = null) {
  const wrap = el('section', 'settings-section');
  if (id) wrap.id = id;
  wrap.appendChild(el('span', 'tt-filter-label', title));
  const card = el('div', 'settings-card');
  wrap.appendChild(card);
  adminEl.appendChild(wrap);
  return card;
}

function row(label, sub = null, actions = []) {
  const r = el('div', 'settings-row admin-row');
  const text = el('span', 'settings-row__text');
  text.appendChild(el('span', 'settings-row__label', label));
  if (sub) text.appendChild(el('span', 'settings-row__sub', sub));
  r.appendChild(text);
  if (actions.length) {
    const box = el('span', 'admin-row__actions');
    actions.forEach(a => box.appendChild(a));
    r.appendChild(box);
  }
  return r;
}

function smallButton(label, variant, onClick) {
  const b = el('button', `tt-btn tt-btn--${variant} admin-btn`, label);
  b.type = 'button';
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await onClick(); } finally { b.disabled = false; }
  });
  return b;
}

async function act(run, failTitle = "That didn't work") {
  try {
    const result = await run();
    await render();
    return result;
  } catch (err) {
    await confirmDialog({ title: failTitle, message: err.message || 'Something went wrong. Try again.', confirmLabel: 'OK' });
    return undefined;
  }
}

function message(title, text, extra = []) {
  adminEl.innerHTML = '';
  const card = el('div', 'settings-card admin-message');
  card.appendChild(el('h2', null, title));
  card.appendChild(el('p', null, text));
  extra.forEach(node => card.appendChild(node));
  adminEl.appendChild(card);
}

// ---------- Which profile on this device is the owner ----------

async function findAdminProfile() {
  const activeId = getActiveProfileId();
  // A pending profile counts too: the owner's own account may be waiting (see requireAdmin).
  const signedIn = getProfiles().filter(p => isSignedIn(p))
    .sort((a, b) => (b.id === activeId) - (a.id === activeId));
  let firstAccount = null;
  for (const profile of signedIn) {
    try {
      const data = await refreshOnlineAccount(profile);
      if (data.isAdmin) return { profile: getProfiles().find(p => p.id === profile.id) };
      if (!firstAccount) firstAccount = data.account;
    } catch (err) {
      if (err.code === 'offline' || err.code === 'unavailable') return { error: err };
    }
  }
  return { notAdmin: firstAccount };
}

// ---------- Notifications on this device (Web Push) ----------

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !isNativeAppPlatform();
}

function onIphoneBrowserTab() {
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone;
  return ios && !standalone;
}

function keyBytes(base64Url) {
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64Url.length % 4)) % 4);
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
}

async function currentSubscription() {
  const registration = await navigator.serviceWorker.ready;
  return { registration, subscription: await registration.pushManager.getSubscription() };
}

async function turnPushOn() {
  const { publicKey } = await serverRequest('GET', '/v1/push/key');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in the browser or phone settings.');
  const { registration, subscription } = await currentSubscription();
  const sub = subscription || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await accountRequest(adminProfile, 'PUT', '/v1/push/subscription', sub.toJSON());
}

async function turnPushOff() {
  const { subscription } = await currentSubscription();
  if (!subscription) return;
  await accountRequest(adminProfile, 'DELETE', '/v1/push/subscription', { endpoint: subscription.endpoint }).catch(() => {});
  await subscription.unsubscribe();
}

async function renderPush(card, serverHasPush) {
  if (!serverHasPush) {
    card.appendChild(row('Notifications', 'Not set up on the server yet (the VAPID keys, see docs/DEVELOPMENT.md).'));
    return;
  }
  if (!pushSupported()) {
    card.appendChild(row('Notifications', isNativeAppPlatform()
      ? "The Android app can't get these yet. Open the admin page in a browser, or add Watchlog to an iPhone's Home Screen."
      : "This browser can't receive push notifications."));
    return;
  }
  if (onIphoneBrowserTab()) {
    card.appendChild(row('Notifications', 'On iPhone, add Watchlog to the Home Screen (Share → Add to Home Screen) and open the admin page from there.'));
    return;
  }
  let subscribed = false;
  try { subscribed = Boolean((await currentSubscription()).subscription); } catch (err) { /* no service worker yet */ }
  const sw = buildSwitch('Notify me on this device', subscribed && Notification.permission === 'granted', async on => {
    try {
      if (on) await turnPushOn(); else await turnPushOff();
    } catch (err) {
      sw.setOn(!on);
      await confirmDialog({ title: "Couldn't change notifications", message: err.message || 'Try again.', confirmLabel: 'OK' });
    }
  });
  const r = row('Notify me on this device', 'When someone asks to join');
  r.appendChild(sw);
  card.appendChild(r);
  card.appendChild(row('Send a test', null, [smallButton('Send', 'secondary', async () => {
    try {
      const result = await accountRequest(adminProfile, 'POST', '/v1/push/test');
      await confirmDialog({ title: 'Test sent', message: result.sent ? `Sent to ${result.sent} device${result.sent === 1 ? '' : 's'}.` : 'No device has notifications on yet.', confirmLabel: 'OK' });
    } catch (err) {
      await confirmDialog({ title: "Couldn't send", message: err.message, confirmLabel: 'OK' });
    }
  })]));
}

// ---------- Sections ----------

function renderRequests(users) {
  const pending = users.filter(u => u.status === 'pending');
  const card = section(pending.length ? `Asking to join (${pending.length})` : 'Asking to join', 'requests');
  if (!pending.length) {
    card.appendChild(row('Nobody is waiting', null));
    return;
  }
  pending.forEach(user => {
    const sub = [user.requestNote ? `"${user.requestNote}"` : 'No note', `asked ${when(user.createdAt)}`].join(' · ');
    card.appendChild(row(user.displayName, sub, [
      smallButton('Decline', 'secondary', () => act(async () => {
        const ok = await confirmDialog({ title: `Decline ${user.displayName}?`, message: 'Their request is deleted. They can ask again.', confirmLabel: 'Decline', danger: true });
        if (ok) await adminRequest('DELETE', `/users/${user.id}`);
      })),
      smallButton('Approve', 'primary', () => act(() => adminRequest('POST', `/users/${user.id}/approve`))),
    ]));
  });
}

function renderNumbers(overview) {
  const wrap = el('section', 'settings-section');
  wrap.appendChild(el('span', 'tt-filter-label', 'At a glance'));
  const grid = el('div', 'stat-grid');
  grid.appendChild(buildStatTile(overview.accounts.active, 'Accounts'));
  grid.appendChild(buildStatTile(overview.activeLast7Days, 'Active this week'));
  grid.appendChild(buildStatTile(overview.devices, 'Signed-in devices'));
  grid.appendChild(buildStatTile(`${overview.tmdbToday}`, `TMDB today (cap ${overview.settings.tmdbDailyCap})`, { wide: true }));
  grid.appendChild(buildStatTile(overview.syncRecords, 'Synced records'));
  wrap.appendChild(grid);
  const backup = overview.lastBackup
    ? `Last backup: ${overview.lastBackup.at ? when(overview.lastBackup.at) : overview.lastBackup.key}`
    : 'No backup yet (Sundays 03:00 UTC)';
  wrap.appendChild(el('p', 'settings-row__sub admin-note', `${backup}${overview.accounts.suspended ? ` · ${overview.accounts.suspended} suspended` : ''}`));
  adminEl.appendChild(wrap);
}

function renderSignupMode(settings) {
  const card = section('Who can join');
  const block = el('div', 'settings-block');
  const chips = el('div', 'chip-wrap');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Sign-up mode');
  Object.entries(SIGNUP_MODE_TEXT).forEach(([mode, [label]]) => {
    chips.appendChild(buildChip(label, {
      selected: settings.signupMode === mode,
      onClick: () => act(() => adminRequest('PATCH', '/settings', { signupMode: mode })),
    }));
  });
  block.appendChild(chips);
  block.appendChild(el('p', 'settings-row__sub', SIGNUP_MODE_TEXT[settings.signupMode][1]));
  card.appendChild(block);
}

function inviteStatus(invite) {
  if (invite.usedAt) return `Used by ${invite.usedBy || 'a deleted account'} ${when(invite.usedAt)}`;
  if (Date.parse(invite.expiresAt) <= Date.now()) return 'Expired';
  return `Unused · expires ${new Date(invite.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
}

async function newInvite() {
  const note = await promptDialog({ title: 'New invite', label: 'Who is it for? (only you see this)', placeholder: 'e.g. Mum', confirmLabel: 'Make invite' });
  if (note === null) return;
  const made = await act(() => adminRequest('POST', '/invites', { note, days: 7 }), "Couldn't make the invite");
  if (!made) return;
  const { overlay, modal } = openDialog();
  modal.appendChild(el('h2', null, 'Invite code'));
  modal.appendChild(el('p', null, 'Send this to them. In Watchlog: Create an account, then enter it as the invite code. It works once, for 7 days.'));
  modal.appendChild(el('div', 'code-display', made.code));
  const status = el('p', 'settings-row__sub');
  modal.appendChild(status);
  const actions = el('div', 'confirm-actions');
  const copy = dialogButton('Copy', 'secondary');
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(made.code); status.textContent = 'Copied.'; } catch (err) { status.textContent = 'Select the code and copy it.'; }
  });
  const done = dialogButton('Done', 'primary');
  done.addEventListener('click', () => overlay.remove());
  actions.appendChild(copy);
  actions.appendChild(done);
  modal.appendChild(actions);
}

function renderInvites(invites) {
  const card = section('Invites');
  card.appendChild(row('New invite', 'A single-use code that lets someone straight in', [smallButton('Make one', 'primary', newInvite)]));
  invites.slice(0, 30).forEach(invite => {
    const unused = !invite.usedAt && Date.parse(invite.expiresAt) > Date.now();
    card.appendChild(row(invite.note || 'Invite', inviteStatus(invite), unused ? [
      smallButton('Cancel', 'secondary', () => act(() => adminRequest('DELETE', `/invites/${invite.id}`))),
    ] : []));
  });
}

const STATUS_LABEL = { active: null, pending: 'waiting', suspended: 'suspended' };

async function userMenu(user) {
  const { overlay, modal } = openDialog();
  modal.appendChild(el('h2', null, user.displayName));
  modal.appendChild(el('p', null, `Joined ${when(user.createdAt)} · last seen ${when(user.lastSeen)} · ${user.devices} device${user.devices === 1 ? '' : 's'} · ${user.records} synced records · ${user.tmdbToday} TMDB requests today`));
  const actions = el('div', 'confirm-actions confirm-actions--stacked');
  const close = () => overlay.remove();
  const add = (label, variant, run) => {
    const b = dialogButton(label, variant);
    b.addEventListener('click', async () => { close(); await run(); });
    actions.appendChild(b);
  };
  if (user.status === 'pending') add('Approve', 'primary', () => act(() => adminRequest('POST', `/users/${user.id}/approve`)));
  if (user.devices) add('Sign out all their devices', 'secondary', () => act(() => adminRequest('POST', `/users/${user.id}/sign-out`)));
  if (user.status === 'suspended') add('Unsuspend', 'secondary', () => act(() => adminRequest('POST', `/users/${user.id}/unsuspend`)));
  if (user.status === 'active') {
    add('Suspend', 'secondary', async () => {
      const ok = await confirmDialog({ title: `Suspend ${user.displayName}?`, message: "They're signed out everywhere and can't sign in until you unsuspend them. Their data stays.", confirmLabel: 'Suspend', danger: true });
      if (ok) await act(() => adminRequest('POST', `/users/${user.id}/suspend`));
    });
  }
  add('Delete account', 'danger', async () => {
    const ok = await confirmDialog({ title: `Delete ${user.displayName}?`, message: 'Their account and everything synced to it is deleted from the server. What their devices hold stays there. This can\'t be undone.', confirmLabel: 'Delete', danger: true });
    if (ok) await act(() => adminRequest('DELETE', `/users/${user.id}`));
  });
  add('Close', 'secondary', async () => {});
  modal.appendChild(actions);
  overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
}

function renderUsers(users) {
  const others = users.filter(u => u.status !== 'pending');
  const card = section(`Accounts (${others.length})`);
  others.forEach(user => {
    const label = user.isAdmin ? `${user.displayName} (you, admin)` : user.displayName;
    const sub = [STATUS_LABEL[user.status], `last seen ${when(user.lastSeen)}`, `${user.devices} device${user.devices === 1 ? '' : 's'}`, `${user.records} records`].filter(Boolean).join(' · ');
    card.appendChild(row(label, sub, user.isAdmin ? [] : [smallButton('Manage', 'secondary', () => userMenu(user))]));
  });
}

function renderTmdb(settings) {
  const card = section('Movie and show information (TMDB)');
  const r = row('TMDB for online accounts', settings.tmdbProxy === 'on' ? 'On: online accounts use your TMDB token' : 'Paused: online accounts get no posters or details');
  r.appendChild(buildSwitch('TMDB for online accounts', settings.tmdbProxy === 'on', on => act(() => adminRequest('PATCH', '/settings', { tmdbProxy: on ? 'on' : 'off' }))));
  card.appendChild(r);
  card.appendChild(row('Daily cap', `${settings.tmdbDailyCap} requests a day for everyone together`, [smallButton('Change', 'secondary', async () => {
    const value = await promptDialog({ title: 'Daily cap', label: 'Requests per day (100 to 90000)', value: String(settings.tmdbDailyCap), confirmLabel: 'Save' });
    if (value !== null) await act(() => adminRequest('PATCH', '/settings', { tmdbDailyCap: Number(value) }));
  })]));
}

function renderActivity(entries) {
  const card = section('Activity');
  if (!entries.length) {
    card.appendChild(row('Nothing yet', null));
    return;
  }
  entries.slice(0, 30).forEach(entry => {
    const about = entry.targetName || (entry.details && entry.details.name) || (entry.details && entry.details.note) || '';
    const detail = entry.action === 'settings' && entry.details ? Object.entries(entry.details).map(([k, v]) => `${k}: ${v}`).join(', ') : about;
    card.appendChild(row(ACTION_TEXT[entry.action] || entry.action, [detail, when(entry.at)].filter(Boolean).join(' · ')));
  });
}

// ---------- Drawing the page ----------

async function render() {
  const [overview, { users }, { invites }, { entries }] = await Promise.all([
    adminRequest('GET', '/overview'),
    adminRequest('GET', '/users'),
    adminRequest('GET', '/invites'),
    adminRequest('GET', '/audit'),
  ]);
  const scroll = window.scrollY;
  adminEl.innerHTML = '';
  const pushCard = section('This device');
  await renderPush(pushCard, overview.push);
  renderRequests(users);
  renderNumbers(overview);
  renderSignupMode(overview.settings);
  renderInvites(invites);
  renderUsers(users);
  renderTmdb(overview.settings);
  renderActivity(entries);
  window.scrollTo(0, scroll);
  if (window.location.hash === '#requests' && !render.scrolled) {
    render.scrolled = true;
    document.getElementById('requests').scrollIntoView();
  }
}

function copyButton(text) {
  const b = smallButton('Copy', 'secondary', async () => {
    try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch (err) { b.textContent = 'Select it'; }
  });
  return b;
}

document.addEventListener('DOMContentLoaded', async () => {
  adminEl.appendChild(el('p', 'settings-row__sub', 'Loading…'));
  const found = await findAdminProfile();
  if (found.error) {
    message("Can't reach Watchlog", found.error.message);
    return;
  }
  if (found.notAdmin) {
    const id = el('code', 'admin-id', found.notAdmin.id);
    message('This account is not the admin',
      `"${found.notAdmin.displayName}" is signed in here, but it isn't the owner. To make it the admin, add this account id to the ADMIN_ACCOUNT_IDS secret on the watchlog Worker (Cloudflare dashboard → Settings → Variables and Secrets), then reload.`,
      [id, copyButton(found.notAdmin.id)]);
    return;
  }
  if (!found.profile) {
    const link = el('a', 'tt-btn tt-btn--primary', 'Sign in');
    link.href = 'profile-picker.html?screen=signin';
    message('Sign in first', "Sign in to the owner's online account on this device, then come back here.", [link]);
    return;
  }
  adminProfile = found.profile;
  try {
    await render();
  } catch (err) {
    message("Couldn't load the admin page", err.message || 'Try again.');
  }
});
