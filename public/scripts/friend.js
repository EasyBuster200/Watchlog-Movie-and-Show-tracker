// A friend's profile (friend.html?id=<account id>, opened from Friends): what they share
// (GET /v1/friends/:id/library, as much as their share level allows): a few numbers, their
// favourites, watched movies and shows, Watchlist and lists, as poster rows. Cards carry the
// usual buttons, so a title can go straight onto your own Watchlist. Remove and Block are
// buttons under the name.
//
// Watched movies and favourites come with their display fields; shows and list items are only
// ids, so their cards are built from TMDB (through the usual fetch shim and its cache), at most
// ROW_LIMIT per row.

const ROW_LIMIT = 20;
let me = null;
let friendId = null;

function rowSection(title, count) {
  const wrap = el('section', 'stack');
  const head = el('div', 'tt-section');
  head.appendChild(el('h2', null, count ? `${title} (${count})` : title));
  wrap.appendChild(head);
  const row = el('div', 'poster-row');
  wrap.appendChild(row);
  document.getElementById('friend-sections').appendChild(wrap);
  return row;
}

// A card from the fields a record carries (watched movies, favourites).
function itemFromSummary(row, mediaType) {
  return {
    tmdbId: row.tmdbId, mediaType, title: row.title || 'Unknown', year: row.year || null,
    releaseDate: row.releaseDate || null, posterPath: row.posterPath || null, voteAverage: row.voteAverage || null,
  };
}

async function itemFromTmdb(mediaType, tmdbId) {
  try {
    const response = await fetch(`/api/tmdb/${mediaType}/${tmdbId}?language=en-US`, { credentials: 'same-origin' });
    if (!response.ok) return null;
    return toStandardItem(await response.json(), mediaType);
  } catch (error) {
    return null;
  }
}

function fillRow(container, items, context, detail = () => null) {
  container.innerHTML = '';
  items.filter(Boolean).forEach(item => {
    const card = buildCard(item);
    attachStandardActions(card, item, context);
    const text = detail(item);
    if (text) addCardDetail(card, text);
    container.appendChild(card);
  });
  if (!container.children.length) container.appendChild(el('p', 'empty-note', 'Nothing here yet.'));
}

async function fillRowFromTmdb(container, entries, context, detail) {
  renderSkeletonRow(container, Math.min(entries.length, 6));
  const items = await Promise.all(entries.slice(0, ROW_LIMIT).map(e => itemFromTmdb(e.mediaType, e.tmdbId)));
  if (entries.length && !items.some(Boolean)) {
    container.innerHTML = '';
    container.appendChild(el('p', 'empty-note', "Couldn't load these titles right now. Try again later."));
    return;
  }
  fillRow(container, items, context, detail);
}

function renderNumbers(library) {
  const grid = el('div', 'stat-grid');
  const episodes = library.shows.reduce((sum, s) => sum + s.episodes, 0);
  grid.appendChild(buildStatTile(library.movies.length, 'Movies watched'));
  grid.appendChild(buildStatTile(library.shows.length, 'Shows'));
  grid.appendChild(buildStatTile(episodes, 'Episodes watched'));
  document.getElementById('friend-sections').appendChild(grid);
}

async function renderLibrary(library) {
  const name = library.friend.displayName;
  document.getElementById('friend-name').textContent = name;
  document.getElementById('friend-avatar').textContent = String(name).trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  document.title = name;
  const sub = document.getElementById('friend-sub');
  const sections = document.getElementById('friend-sections');
  sections.innerHTML = '';

  if (library.shareLevel === 'nothing') {
    sub.textContent = 'Friend';
    sections.appendChild(el('p', 'empty-note', `${name} keeps their library private.`));
    return;
  }
  sub.textContent = library.shareLevel === 'lists' ? 'Shares lists and favourites' : 'Friend';
  const context = await fetchStandardActionContext();

  if (library.shareLevel === 'everything') renderNumbers(library);

  const favMovies = library.favorites.filter(f => f.mediaType === 'movie');
  const favShows = library.favorites.filter(f => f.mediaType === 'tv');
  const pending = [];

  if (library.shareLevel === 'everything') {
    if (library.shows.length) {
      pending.push(fillRowFromTmdb(rowSection('Watched shows', library.shows.length), library.shows.map(s => ({ ...s, mediaType: 'tv' })), context,
        item => {
          const show = library.shows.find(s => s.tmdbId === item.tmdbId);
          return show ? `${show.episodes} episode${show.episodes === 1 ? '' : 's'} watched` : null;
        }));
    }
    if (library.movies.length) fillRow(rowSection('Watched movies', library.movies.length), library.movies.slice(0, ROW_LIMIT).map(m => itemFromSummary(m, 'movie')), context);
  }
  if (favShows.length) fillRow(rowSection('Favourite shows', favShows.length), favShows.slice(0, ROW_LIMIT).map(f => itemFromSummary(f, 'tv')), context);
  if (favMovies.length) fillRow(rowSection('Favourite movies', favMovies.length), favMovies.slice(0, ROW_LIMIT).map(f => itemFromSummary(f, 'movie')), context);
  if (library.watchlist && library.watchlist.length) pending.push(fillRowFromTmdb(rowSection('Watchlist', library.watchlist.length), library.watchlist, context));
  library.lists.forEach(list => {
    if (list.items.length) pending.push(fillRowFromTmdb(rowSection(list.name, list.items.length), list.items, context));
  });
  if (!sections.children.length) sections.appendChild(el('p', 'empty-note', `${name} hasn't added anything yet.`));
  await Promise.all(pending);
}

async function confirmRemove(name) {
  const ok = await confirmDialog({
    title: `Remove ${name}?`,
    message: "You stop seeing each other's libraries. You can add each other again with a friend code.",
    confirmLabel: 'Remove',
    danger: true,
  });
  if (!ok) return;
  try {
    await removeFriend(me, friendId);
    window.location.href = 'friends.html';
  } catch (err) {
    await confirmDialog({ title: "Couldn't remove", message: err.message || 'Try again.', confirmLabel: 'OK', cancelLabel: 'Close' });
  }
}

async function blockFriend(name) {
  const ok = await confirmDialog({
    title: `Block ${name}?`,
    message: "You stop being friends, and they can't send you requests. They aren't told.",
    confirmLabel: 'Block',
    danger: true,
  });
  if (!ok) return;
  try {
    await blockAccount(me, friendId);
    window.location.href = 'friends.html';
  } catch (err) {
    await confirmDialog({ title: "Couldn't block", message: err.message || 'Try again.', confirmLabel: 'OK', cancelLabel: 'Close' });
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await requireLogin();
  me = getActiveProfile();
  friendId = new URLSearchParams(window.location.search).get('id');
  const sections = document.getElementById('friend-sections');
  if (!friendId || !me.account || !isSignedIn(me)) {
    window.location.href = 'friends.html';
    return;
  }
  sections.appendChild(el('p', 'empty-note', 'Loading…'));
  let library;
  try {
    library = await getFriendLibrary(me, friendId);
  } catch (err) {
    sections.innerHTML = '';
    sections.appendChild(el('p', 'empty-note', err.code === 'not_friends' ? "You're not friends with this account any more." : (err.message || "Couldn't load it. Try again.")));
    return;
  }
  const name = library.friend.displayName;
  document.getElementById('friend-remove').addEventListener('click', () => confirmRemove(name));
  document.getElementById('friend-block').addEventListener('click', () => blockFriend(name));
  await renderLibrary(library);
});
