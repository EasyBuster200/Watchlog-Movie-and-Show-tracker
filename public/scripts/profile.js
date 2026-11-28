// Profile: the profile card (name, since when, the ⋯ that opens Settings, and the backup
// status), the summary stats, then previews of watched and favourite movies and shows. Backups,
// notifications and account actions live in Settings (settings.js).

// The Friends row (friends.html): how many requests wait, from the last sync (sync.js).
function renderFriendsLink(user) {
  const sub = document.getElementById('friends-link-sub');
  if (!sub) return;
  const account = user.account;
  if (!account) sub.textContent = 'Needs an online account';
  else if (account.friendRequests) sub.textContent = account.friendRequests === 1 ? '1 friend request' : `${account.friendRequests} friend requests`;
  else sub.textContent = 'Your friends, and adding new ones with a friend code';
}

function renderHeader(user) {
  document.getElementById('profile-name').textContent = user.displayName;
  const since = new Date(user.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  document.getElementById('profile-since').textContent = `Local profile since ${since}`;
  document.getElementById('profile-avatar').textContent = user.displayName.trim().charAt(0).toUpperCase();
}

async function loadStats() {
  const stats = await fetchJson('/api/stats');
  renderStatTiles(document.getElementById('stats-grid'), stats, { layout: 'profile' });
  if (webProfile) fillWebStats(stats);
}

// ---------- Laptops: the design's WebProfile ----------
// A header band (avatar, name, since when and the backup state, Export data and Settings, a
// stats strip, tabs to the full lists), then watch time per month and top genres side by side.
// The phone's card, Friends row and stat tiles are .phone-only; the poster rows are shared.
let webProfile = null;

const WEB_PROFILE_TABS = [
  ['Overview', 'profile.html'],
  ['Movies', 'media-list.html?source=watched&type=movie'],
  ['Shows', 'media-list.html?source=watched&type=tv'],
  ['Favourites', 'media-list.html?source=favorites&type=movie'],
  ['Lists', 'lists.html'],
];

function buildWebProfile(user) {
  const root = document.getElementById('web-profile');
  const inner = el('div', 'web-profile__in');
  const head = el('div', 'web-profile__head');
  head.appendChild(el('span', 'web-profile__avatar', user.displayName.trim().charAt(0).toUpperCase()));
  const titles = el('div', 'web-profile__titles');
  titles.appendChild(el('h2', 'web-profile__name', user.displayName));
  const meta = el('span', 'web-profile__meta');
  const since = new Date(user.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  meta.appendChild(el('span', null, `${user.account ? 'Online account' : 'Offline profile'} since ${since}`));
  const backup = el('span', 'web-profile__backup');
  meta.appendChild(backup);
  titles.appendChild(meta);
  head.appendChild(titles);

  const actions = el('div', 'web-profile__actions');
  const exportBtn = el('button', 'tt-btn tt-btn--secondary', 'Export data');
  exportBtn.type = 'button';
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    try {
      if (await exportBackup(user)) renderAutoBackupStatus(user);
    } catch (error) {
      console.error('Backup export failed:', error);
      await confirmDialog({ title: 'Export failed', message: 'Something went wrong creating the backup file.', confirmLabel: 'OK', cancelLabel: 'Close' });
    }
    exportBtn.disabled = false;
  });
  const settings = el('a', 'tt-btn tt-btn--secondary', 'Settings');
  settings.href = 'settings.html';
  actions.append(exportBtn, settings);
  head.appendChild(actions);
  inner.appendChild(head);

  const stats = el('div', 'web-profile__stats');
  inner.appendChild(stats);

  const tabs = el('nav', 'web-profile__tabs');
  tabs.setAttribute('aria-label', 'Profile sections');
  WEB_PROFILE_TABS.forEach(([label, href], i) => {
    const a = el('a', i === 0 ? 'web-profile__tab web-profile__tab--on' : 'web-profile__tab', label);
    a.href = href;
    if (i === 0) a.setAttribute('aria-current', 'page');
    tabs.appendChild(a);
  });
  inner.appendChild(tabs);
  root.appendChild(inner);

  const charts = el('div', 'web-profile__charts web-only');
  const months = el('section', 'web-profile__card');
  const monthsHead = el('div', 'web-profile__card-head');
  monthsHead.append(el('h2', null, 'Watch time per month'), el('span', null, 'Hours, last 12 months'));
  const chart = el('div', 'web-month-chart');
  chart.setAttribute('role', 'img');
  months.append(monthsHead, chart);
  const genres = el('section', 'web-profile__card');
  genres.appendChild(el('h2', null, 'Top genres'));
  const genreList = el('div', 'web-genres');
  genres.appendChild(genreList);
  charts.append(months, genres);
  root.after(charts);

  webProfile = { backup, stats, chart, genreList };
}

function fillWebStats(stats) {
  webProfile.stats.innerHTML = '';
  [
    [stats.moviesWatched, 'Movies'],
    [stats.showsTracked, 'Shows'],
    [stats.episodesWatched, 'Episodes'],
    [formatWatchTime(stats.totalWatchMinutes).replace('D', 'd'), 'Watch time'],
    [stats.favorites, 'Favourites'],
  ].forEach(([value, label]) => {
    const stat = el('div', 'web-profile__stat');
    stat.append(el('span', 'web-profile__stat-value', typeof value === 'number' ? value.toLocaleString() : value), el('span', null, label));
    webProfile.stats.appendChild(stat);
  });
}

function monthName(month, options) {
  return parseLocalDate(`${month}-01`).toLocaleDateString(undefined, options);
}

async function loadWebCharts() {
  const { chart, genreList } = webProfile;
  try {
    const details = await fetchJson('/api/stats/details');
    const hours = details.monthly.map(m => m.minutes / 60);
    const max = Math.max(...hours, 1);
    chart.innerHTML = '';
    if (hours.every(h => h === 0)) {
      chart.appendChild(el('p', 'muted-note', 'Nothing watched in the last 12 months yet.'));
    } else {
      const peak = details.monthly[hours.indexOf(Math.max(...hours))];
      chart.setAttribute('aria-label', `Bar chart of hours watched per month, peaking at ${Math.round(max)} hours in ${monthName(peak.month, { month: 'long' })}`);
      details.monthly.forEach(({ month }, i) => {
        const col = el('div', i === hours.length - 1 ? 'web-month web-month--current' : 'web-month');
        col.title = `${monthName(month, { month: 'long', year: 'numeric' })}: ${Math.round(hours[i] * 10) / 10}h`;
        col.appendChild(el('span', 'web-month__value', String(Math.round(hours[i]))));
        const fill = el('div', 'web-month__fill');
        fill.style.height = `${Math.round((hours[i] / max) * 170)}px`;
        col.appendChild(fill);
        col.appendChild(el('span', 'web-month__label', monthName(month, { month: 'short' })));
        chart.appendChild(col);
      });
    }
    genreList.innerHTML = '';
    const top = details.genres.slice(0, 5);
    if (!top.length) genreList.appendChild(el('p', 'muted-note', 'Watch something to see your top genres.'));
    const most = Math.max(...top.map(g => g.count), 1);
    top.forEach(g => {
      const row = el('div', 'web-genre');
      const track = el('div', 'web-genre__track');
      const fill = el('div', 'web-genre__fill');
      fill.style.width = `${(g.count / most) * 100}%`;
      track.appendChild(fill);
      row.append(el('span', 'web-genre__name', g.name), track, el('span', 'web-genre__count', String(g.count)));
      genreList.appendChild(row);
    });
  } catch (error) {
    console.error('Failed to load stats details:', error);
    chart.innerHTML = '';
    chart.appendChild(el('p', 'muted-note', "Couldn't load these stats."));
  }
}

// Each preview shows at most this many. Watched Shows costs a TMDB lookup per show (it needs
// live episode counts), so the previews ask the API for only this many (?limit=).
const WATCHED_PREVIEW_LIMIT = 8;

const MEDIA_SECTIONS = [
  { url: '/api/watched/movies/details', containerId: 'watched-movies-container', empty: 'No watched movies yet.' },
  { url: '/api/favorites/movies', containerId: 'favorite-movies-container', empty: 'No favourite movies yet.' },
  { url: '/api/watched/shows', containerId: 'watched-shows-container', empty: 'No shows tracked yet.', showProgress: true },
  { url: '/api/favorites/tv', containerId: 'favorite-shows-container', empty: 'No favourite shows yet.' },
];

let actionContext = null;

async function renderSection(section) {
  const container = document.getElementById(section.containerId);
  if (section.showProgress && !container.children.length) renderSkeletonRow(container, 3);

  const items = await fetchJson(`${section.url}?limit=${WATCHED_PREVIEW_LIMIT}`);
  container.innerHTML = '';
  if (items.length === 0) {
    container.appendChild(el('p', 'empty-note', section.empty));
    return;
  }
  items.forEach(item => {
    const card = buildCard(item);
    if (section.showProgress && item.total != null) addCardDetail(card, `${item.watched}/${item.total} episodes watched`);
    attachStandardActions(card, item, actionContext, { onChange: refreshAll });
    container.appendChild(card);
  });
}

// A watched/favourite toggle here can change what belongs in every section and the stats.
async function refreshAll() {
  await Promise.all([loadStats(), ...MEDIA_SECTIONS.map(renderSection)]);
}

// The status row under the profile: last backup and where it went, or what went wrong.
function showBackupStatus(title, detail, { warning = false } = {}) {
  if (webProfile) {
    webProfile.backup.innerHTML = '';
    webProfile.backup.classList.toggle('is-warning', warning);
    webProfile.backup.appendChild(el('span', 'web-profile__dot', '·'));
    const icon = el('span', 'web-profile__backup-icon');
    icon.innerHTML = ttIcon('cloud', { size: 16 });
    webProfile.backup.append(icon, el('span', null, title));
    webProfile.backup.title = detail || '';
  }
  document.getElementById('backup-status').hidden = false;
  document.getElementById('backup-status-title').textContent = title;
  document.getElementById('backup-status-detail').textContent = detail || '';
  document.getElementById('backup-status-icon').classList.toggle('is-warning', warning);
}

function formatBackupDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// The web app (iPhone) has no automatic backup, and the browser's storage is the only copy of
// the library, so remind people to export one every BACKUP_REMINDER_AFTER_DAYS (backup.js).
function renderWebBackupReminder(user) {
  const days = daysSinceBackupExport(user.id);
  const where = 'Export one in Settings > Export data.';
  if (days === null) {
    showBackupStatus('No backup yet', `Your library is only stored in this browser. ${where}`, { warning: true });
  } else if (days >= BACKUP_REMINDER_AFTER_DAYS) {
    showBackupStatus(`Last backup ${days} days ago`, `Time for a new one. ${where}`, { warning: true });
  } else {
    showBackupStatus(`Backed up ${formatBackupDate(getLastBackupExport(user.id))}`, 'Exported from this browser');
  }
}

// The weekly auto-backup (autoBackup.js, Android only): when it last ran and where the file
// is, or anything that needs attention (a failed write, an older file it couldn't delete, or
// auto-backup being switched off in Settings).
function renderAutoBackupStatus(user) {
  // An online profile's library is saved to its account (sync.js), so no backup reminders.
  if (user.account) {
    if (isSignedIn(user)) showBackupStatus('Saved to your online account', 'Synced with your other devices');
    else showBackupStatus('Signed out', "Changes on this device aren't saved online until you sign in again (Settings).", { warning: true });
    return;
  }
  if (!isNativeApp()) {
    renderWebBackupReminder(user);
    return;
  }
  const info = getAutoBackupInfo(user.id);
  if (!getProfilePrefs(user).autoBackup) {
    showBackupStatus('Auto-backup is off', info && info.savedAt ? `Last saved ${formatBackupDate(info.savedAt)}. Turn it on in Settings.` : 'Turn it on in Settings.', { warning: true });
    return;
  }
  if (info && info.lastError) {
    showBackupStatus('Last auto-backup failed', info.lastError, { warning: true });
    return;
  }
  if (info && info.undeleted && info.undeleted.length) {
    showBackupStatus(
      `Backed up ${formatBackupDate(info.savedAt)}`,
      `Couldn't delete the older backup ${info.undeleted.map(p => `Documents/${p}`).join(', ')}. You can delete it yourself.`,
      { warning: true }
    );
    return;
  }
  if (info && info.savedAt) {
    showBackupStatus(`Backed up ${formatBackupDate(info.savedAt)}`, `Documents/${info.path}`);
  } else {
    showBackupStatus('Weekly backups are on', 'The first one is saved to Documents/Watchlog shortly.');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const user = await requireLogin();
  if (!user) return;

  renderHeader(user);
  if (isLaptopLayout()) {
    buildWebProfile(user);
    loadWebCharts();
  }
  renderFriendsLink(user);
  renderAutoBackupStatus(user);
  // The page-load run (autoBackup.js) may finish after this renders - refresh once it has.
  if (isNativeApp()) {
    setTimeout(async () => {
      await runAutoBackups();
      renderAutoBackupStatus(user);
    }, AUTO_BACKUP_START_DELAY_MS + 500);
  }

  actionContext = await fetchStandardActionContext();
  refreshAll();
});
