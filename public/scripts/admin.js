// The owner's admin page (admin.html; roadmap Phase 8 part 1), on top of the server's
// /v1/admin/... API (server/src/routes/admin.js). It uses the session of an online profile on
// this device whose account is the admin (the server's ADMIN_ACCOUNT_IDS secret). There's no
// separate admin password: being signed in as the owner on this device is what lets you in.
//
// Sections: notifications on this device (Web Push), sign-up requests (approve / decline),
// numbers, the sign-up mode, invites, users (sign out, suspend, delete), the TMDB proxy's switch
// and daily cap, and the activity log. People's libraries are never shown: counts only.
//
// Two layouts from the same pieces (the design's Admin and WebAdmin): one column on phones;
// on laptops (media.js's isLaptopLayout) the browser shell, a stats strip, then requests,
// accounts and activity as tables in the main column, and the sign-up mode (option cards),
// invites, TMDB and this device in a 360px side column.

const adminEl = document.getElementById('admin');
let adminProfile = null;
let web = false;
// The account whose Manage row is open, kept across re-renders.
let openUserId = null;

const SIGNUP_MODE_TEXT = {
  closed: ['Closed', 'Nobody new can make an account.'],
  invite: ['Invite only', 'New accounts need an invite code from here.'],
  approval: ['Approval', 'Anyone can ask; you approve them here. An invite code skips the wait.'],
  open: ['Open', 'Anyone can make an account (still rate limited).'],
};

const ACTION_TEXT = {
  approve: 'Approved', decline: 'Declined', delete: 'Deleted', suspend: 'Suspended', unsuspend: 'Unsuspended',
  'sign-out': 'Signed out', 'new-key': 'Emailed a new key', 'recovery.cancel': 'Cancelled a recovery', 'invite.create': 'Made an invite', 'invite.cancel': 'Cancelled an invite', settings: 'Changed settings',
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
  const days = Math.round(hours / 24);
  if (days < 30) return days === 1 ? '1 day ago' : `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function count(n) {
  return Number(n || 0).toLocaleString();
}

// A titled section with a card. Not added to the page: render() places it.
function section(title, id = null) {
  const wrap = el('section', 'settings-section');
  if (id) wrap.id = id;
  const head = el('div', 'admin-section__head');
  head.appendChild(el('h2', 'tt-filter-label settings-section__title', title));
  wrap.appendChild(head);
  const card = el('div', 'settings-card');
  wrap.appendChild(card);
  return { wrap, head, card };
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

// `variant`: 'pill' (the small round SettingsRow button), 'secondary', 'primary' or 'danger'.
function smallButton(label, variant, onClick) {
  const b = el('button', variant === 'pill' ? 'settings-row__btn' : `admin-btn admin-btn--${variant}`, label);
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

// The helpers (webPushSupported, setDevicePush, ...) are in serverApi.js, shared with Settings,
// where the same device turns on episode, release and recap notifications.

function renderPush(serverHasPush) {
  const { wrap, card } = section('This device');
  if (!serverHasPush) {
    card.appendChild(row('Notifications', 'Not set up on the server yet (the VAPID keys, see docs/DEVELOPMENT.md).'));
    return wrap;
  }
  if (!webPushSupported()) {
    card.appendChild(row('Notifications', isNativeAppPlatform()
      ? "The Android app can't get these yet. Open the admin page in a browser, or add Watchlog to an iPhone's Home Screen."
      : "This browser can't receive push notifications."));
    return wrap;
  }
  if (onIphoneBrowserTab()) {
    card.appendChild(row('Notifications', 'On iPhone, add Watchlog to the Home Screen (Share → Add to Home Screen) and open the admin page from there.'));
    return wrap;
  }
  const subscribed = devicePushKinds(adminProfile).requests && Notification.permission === 'granted';
  const label = web ? 'Notify me here' : 'Notify me on this device';
  const sw = buildSwitch('Notify me on this device', subscribed, async on => {
    try {
      await setDevicePush(adminProfile, { requests: on });
    } catch (err) {
      sw.setOn(!on);
      await confirmDialog({ title: "Couldn't change notifications", message: err.message || 'Try again.', confirmLabel: 'OK' });
    }
  });
  const r = row(label, 'When someone asks to join');
  r.appendChild(sw);
  card.appendChild(r);
  card.appendChild(row('Send a test', null, [smallButton('Send', 'pill', async () => {
    try {
      const result = await accountRequest(adminProfile, 'POST', '/v1/push/test');
      await confirmDialog({ title: 'Test sent', message: result.sent ? `Sent to ${result.sent} device${result.sent === 1 ? '' : 's'}.` : 'No device has notifications on yet.', confirmLabel: 'OK' });
    } catch (err) {
      await confirmDialog({ title: "Couldn't send", message: err.message, confirmLabel: 'OK' });
    }
  })]));
  return wrap;
}

// ---------- Sections ----------

function renderRequests(users) {
  const pending = users.filter(u => u.status === 'pending');
  const { wrap, card } = section(pending.length ? `Asking to join (${pending.length})` : 'Asking to join', 'requests');
  if (!pending.length) {
    card.appendChild(row(web ? 'Nobody is waiting. New requests show up here, and on this device if notifications are on.' : 'Nobody is waiting', null));
    card.lastChild.classList.add('admin-row--quiet');
    return wrap;
  }
  pending.forEach(user => {
    const sub = [user.requestNote ? `"${user.requestNote}"` : 'No note', `asked ${when(user.createdAt)}`].join(' · ');
    const r = row(user.displayName, sub, [
      smallButton('Decline', 'secondary', () => act(async () => {
        const ok = await confirmDialog({ title: `Decline ${user.displayName}?`, message: 'Their request is deleted. They can ask again.', confirmLabel: 'Decline', danger: true });
        if (ok) await adminRequest('DELETE', `/users/${user.id}`);
      })),
      smallButton('Approve', 'primary', () => act(() => adminRequest('POST', `/users/${user.id}/approve`))),
    ]);
    r.classList.add('admin-request');
    const avatar = el('span', 'admin-request__avatar web-only', '?');
    avatar.setAttribute('aria-hidden', 'true');
    r.insertBefore(avatar, r.firstChild);
    card.appendChild(r);
  });
  return wrap;
}

function backupNote(overview) {
  const backup = overview.lastBackup
    ? `Last backup: ${overview.lastBackup.at ? when(overview.lastBackup.at) : overview.lastBackup.key}${web ? ' (Sundays 03:00 UTC)' : ''}`
    : 'No backup yet (Sundays 03:00 UTC)';
  return `${backup}${overview.accounts.suspended ? ` · ${overview.accounts.suspended} suspended` : ''}`;
}

// Phone: StatTiles. Laptop: one card of five numbers, TMDB use with a progress bar.
function renderNumbers(overview) {
  const cap = overview.settings.tmdbDailyCap;
  if (web) {
    const wrap = el('div', 'admin-glance');
    const strip = el('section', 'settings-card admin-stats');
    strip.setAttribute('aria-label', 'At a glance');
    const stat = (value, label) => {
      const s = el('div', 'admin-stat');
      s.append(el('b', null, value), el('span', null, label));
      strip.appendChild(s);
      return s;
    };
    stat(count(overview.accounts.active), 'Accounts');
    stat(count(overview.activeLast7Days), 'Active this week');
    stat(count(overview.devices), 'Signed-in devices');
    const tmdb = stat(count(overview.tmdbToday), `TMDB today · cap ${count(cap)}`);
    const bar = buildProgressBar(overview.tmdbToday, cap, 'TMDB requests today');
    bar.classList.add('admin-stat__bar');
    tmdb.appendChild(bar);
    stat(count(overview.syncRecords), 'Synced records');
    wrap.appendChild(strip);
    wrap.appendChild(el('p', 'admin-note', backupNote(overview)));
    return wrap;
  }
  const wrap = el('section', 'settings-section');
  wrap.appendChild(el('h2', 'tt-filter-label settings-section__title', 'At a glance'));
  const grid = el('div', 'stat-grid admin-tiles');
  grid.appendChild(buildStatTile(count(overview.accounts.active), 'Accounts'));
  grid.appendChild(buildStatTile(count(overview.activeLast7Days), 'Active this week'));
  grid.appendChild(buildStatTile(count(overview.devices), 'Signed-in devices'));
  grid.appendChild(buildStatTile(count(overview.syncRecords), 'Synced records'));
  grid.appendChild(buildStatTile(count(overview.tmdbToday), `TMDB today (cap ${cap})`, { wide: true }));
  wrap.appendChild(grid);
  wrap.appendChild(el('p', 'settings-row__sub admin-note', backupNote(overview)));
  return wrap;
}

// Phone: chips and the chosen mode's description. Laptop: OptionCards.
function renderSignupMode(settings) {
  const { wrap, card } = section('Who can join');
  const pick = mode => act(() => adminRequest('PATCH', '/settings', { signupMode: mode }));
  if (web) {
    card.classList.add('admin-modes');
    card.setAttribute('role', 'radiogroup');
    card.setAttribute('aria-label', 'Sign-up mode');
    Object.entries(SIGNUP_MODE_TEXT).forEach(([mode, [label, text]]) => {
      const on = settings.signupMode === mode;
      const option = el('button', `tt-option${on ? ' tt-option--on' : ''}`);
      option.type = 'button';
      option.setAttribute('role', 'radio');
      option.setAttribute('aria-checked', on ? 'true' : 'false');
      const dot = el('span', 'tt-option__dot');
      dot.setAttribute('aria-hidden', 'true');
      const words = el('span', 'tt-option__text');
      words.append(el('span', 'tt-option__label', label), el('span', 'tt-option__desc', text));
      option.append(dot, words);
      if (!on) option.addEventListener('click', () => pick(mode));
      card.appendChild(option);
    });
    return wrap;
  }
  const block = el('div', 'settings-block');
  const chips = el('div', 'chip-wrap');
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', 'Sign-up mode');
  Object.entries(SIGNUP_MODE_TEXT).forEach(([mode, [label]]) => {
    chips.appendChild(buildChip(label, { selected: settings.signupMode === mode, onClick: () => pick(mode) }));
  });
  block.appendChild(chips);
  block.appendChild(el('p', 'settings-row__sub admin-mode-text', SIGNUP_MODE_TEXT[settings.signupMode][1]));
  card.appendChild(block);
  return wrap;
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

// The codes are stored hashed, so an invite can only be copied when it's made (newInvite);
// the list offers Cancel only.
function renderInvites(invites) {
  const { wrap, head, card } = section('Invites');
  if (web) {
    head.appendChild(smallButton('New invite', 'primary', newInvite));
  } else {
    card.appendChild(row('New invite', 'A single-use code that lets someone straight in', [smallButton('Make one', 'primary', newInvite)]));
  }
  const shown = invites.slice(0, 30);
  shown.forEach(invite => {
    const unused = !invite.usedAt && Date.parse(invite.expiresAt) > Date.now();
    card.appendChild(row(invite.note || 'Invite', inviteStatus(invite), unused ? [
      smallButton('Cancel', 'pill', () => act(() => adminRequest('DELETE', `/invites/${invite.id}`))),
    ] : []));
  });
  if (web) {
    if (!shown.length) card.appendChild(row('No invites yet', null));
    wrap.appendChild(el('p', 'admin-note', 'Single-use codes that let someone straight in. They expire after 7 days.'));
  }
  return wrap;
}

// What the Manage row offers for one account; each asks first where it can't be undone.
function userActions(user) {
  const actions = [];
  const add = (label, variant, run) => actions.push(smallButton(label, variant, run));
  if (user.devices) add('Sign out all their devices', 'secondary', () => act(() => adminRequest('POST', `/users/${user.id}/sign-out`)));
  if (user.recoveryUntil) {
    add('Cancel their recovery', 'secondary', async () => {
      const ok = await confirmDialog({
        title: `Cancel ${user.displayName}'s recovery?`,
        message: `Someone asked to recover this account with its email; it would get a new key on ${new Date(user.recoveryUntil).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. Cancel it if it wasn't them. They're told by email.`,
        confirmLabel: 'Cancel the recovery',
        cancelLabel: 'Keep it',
        danger: true,
      });
      if (ok) await act(() => adminRequest('DELETE', `/users/${user.id}/recovery`));
    });
  }
  if (user.status === 'active' && user.email) {
    add('Email them a new key', 'secondary', async () => {
      const ok = await confirmDialog({
        title: `Email ${user.displayName} a new key?`,
        message: "For someone who lost their key and can't use \"Lost your key?\". A new account key goes to the account's own email; you never see it. Their old key stops working, every device is signed out, and any recovery is cancelled. Their library stays.",
        confirmLabel: 'Send a new key',
      });
      if (!ok) return;
      await act(async () => {
        const reply = await adminRequest('POST', `/users/${user.id}/new-key`);
        await confirmDialog({ title: 'New key sent', message: `It went to ${reply.sentTo}. Tell ${user.displayName} to check that inbox (and spam).`, confirmLabel: 'OK', cancelLabel: 'Close' });
      });
    });
  }
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
  return actions;
}

// The design's StatusPill: Active, Recovering or Suspended.
function statusPill(user) {
  if (user.status === 'suspended') return el('span', 'tt-pill tt-pill--danger', 'Suspended');
  if (user.recoveryUntil) return el('span', 'tt-pill tt-pill--warning', 'Recovering');
  return el('span', 'tt-pill tt-pill--success', 'Active');
}

function manageButton(user, group) {
  const open = openUserId === user.id;
  const b = el('button', web ? 'admin-btn admin-btn--secondary' : 'settings-row__btn', 'Manage');
  b.type = 'button';
  b.setAttribute('aria-expanded', open ? 'true' : 'false');
  b.addEventListener('click', () => {
    openUserId = openUserId === user.id ? null : user.id;
    const nowOpen = openUserId === user.id;
    document.querySelectorAll('.admin-user__actions').forEach(node => node.remove());
    document.querySelectorAll('.admin-user [aria-expanded]').forEach(node => node.setAttribute('aria-expanded', 'false'));
    b.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
    if (nowOpen) group.appendChild(userActionsRow(user));
  });
  return b;
}

function userActionsRow(user) {
  const box = el('div', 'admin-user__actions');
  userActions(user).forEach(b => box.appendChild(b));
  return box;
}

function renderUsers(users) {
  const others = users.filter(u => u.status !== 'pending');
  const { wrap, card } = section(`Accounts (${others.length})`);
  if (web) {
    card.classList.add('admin-table', 'admin-table--users');
    const head = el('div', 'admin-trow admin-trow--head');
    ['Name', 'Status', 'Last seen', 'Devices', 'Records', ''].forEach((label, i) => head.appendChild(el('span', i === 3 || i === 4 ? 'num' : null, label)));
    card.appendChild(head);
  }
  others.forEach(user => {
    const group = el('div', 'admin-user');
    if (web) {
      const r = el('div', 'admin-trow');
      const name = el('span', 'admin-trow__name', user.displayName);
      if (user.isAdmin) name.appendChild(el('span', 'admin-trow__you', 'You · admin'));
      const status = el('span');
      status.appendChild(statusPill(user));
      const manage = el('span', 'num');
      if (!user.isAdmin) manage.appendChild(manageButton(user, group));
      r.append(name, status, el('span', null, when(user.lastSeen)), el('span', 'num', count(user.devices)), el('span', 'num', count(user.records)), manage);
      group.appendChild(r);
    } else {
      const label = user.isAdmin ? `${user.displayName} (you, admin)` : user.displayName;
      const sub = [user.status === 'suspended' ? 'suspended' : null, user.recoveryUntil ? 'recovery in progress' : null, `last seen ${when(user.lastSeen)}`, `${user.devices} device${user.devices === 1 ? '' : 's'}`, `${count(user.records)} records`].filter(Boolean).join(' · ');
      const r = row(label, sub);
      if (!user.isAdmin) r.appendChild(manageButton(user, group));
      group.appendChild(r);
    }
    if (openUserId === user.id && !user.isAdmin) group.appendChild(userActionsRow(user));
    card.appendChild(group);
  });
  return wrap;
}

function renderTmdb(settings) {
  const { wrap, card } = section(web ? 'TMDB' : 'Movie and show information (TMDB)');
  const r = row(web ? 'For online accounts' : 'TMDB for online accounts', settings.tmdbProxy === 'on' ? 'On: online accounts use your TMDB token' : 'Paused: online accounts get no posters or details');
  r.appendChild(buildSwitch('TMDB for online accounts', settings.tmdbProxy === 'on', on => act(() => adminRequest('PATCH', '/settings', { tmdbProxy: on ? 'on' : 'off' }))));
  card.appendChild(r);
  const cap = web ? count(settings.tmdbDailyCap) : settings.tmdbDailyCap;
  card.appendChild(row('Daily cap', `${cap} requests a day for everyone together`, [smallButton('Change', 'pill', async () => {
    const value = await promptDialog({ title: 'Daily cap', label: 'Requests per day (100 to 90000)', value: String(settings.tmdbDailyCap), confirmLabel: 'Save' });
    if (value !== null) await act(() => adminRequest('PATCH', '/settings', { tmdbDailyCap: Number(value) }));
  })]));
  return wrap;
}

function activityText(entry) {
  const about = entry.targetName || (entry.details && entry.details.name) || (entry.details && entry.details.note) || '';
  return entry.action === 'settings' && entry.details ? Object.entries(entry.details).map(([k, v]) => `${k}: ${v}`).join(', ') : about;
}

function renderActivity(entries) {
  const { wrap, card } = section('Activity');
  if (!entries.length) {
    card.appendChild(row('Nothing yet', null));
    return wrap;
  }
  if (web) {
    card.classList.add('admin-table', 'admin-table--activity');
    const head = el('div', 'admin-trow admin-trow--head');
    head.append(el('span', null, 'What'), el('span', null, 'Who / details'), el('span', 'num', 'When'));
    card.appendChild(head);
  }
  entries.slice(0, 30).forEach(entry => {
    const what = ACTION_TEXT[entry.action] || entry.action;
    const detail = activityText(entry);
    if (web) {
      const r = el('div', 'admin-trow');
      r.append(el('span', 'admin-trow__name', what), el('span', null, detail), el('span', 'num', when(entry.at)));
      const group = el('div', 'admin-user');
      group.appendChild(r);
      card.appendChild(group);
    } else {
      card.appendChild(row(what, [detail, when(entry.at)].filter(Boolean).join(' · ')));
    }
  });
  return wrap;
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
  if (web) {
    adminEl.appendChild(renderNumbers(overview));
    const grid = el('div', 'admin-grid');
    const main = el('div', 'admin-main');
    const aside = el('aside', 'admin-aside');
    main.append(renderRequests(users), renderUsers(users), renderActivity(entries));
    aside.append(renderSignupMode(overview.settings), renderInvites(invites), renderTmdb(overview.settings), renderPush(overview.push));
    grid.append(main, aside);
    adminEl.appendChild(grid);
  } else {
    adminEl.append(
      renderPush(overview.push),
      renderRequests(users),
      renderNumbers(overview),
      renderSignupMode(overview.settings),
      renderInvites(invites),
      renderUsers(users),
      renderTmdb(overview.settings),
      renderActivity(entries),
    );
  }
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
  // The browser shell (top bar, footer, "Settings / Admin" breadcrumbs) on laptops only: the
  // page has no bottom nav, as drawn for phones.
  web = isLaptopLayout();
  if (web) renderBrowserShell('profile');
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
