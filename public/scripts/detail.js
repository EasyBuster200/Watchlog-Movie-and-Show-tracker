// The detail page for one movie or show (?type=movie|tv&id=): backdrop, poster, title and
// TMDB rating, the watched/save/favourite/trailer buttons, the overview, then
// Seasons (shows - each season opens episodes.html), Cast, the movie's collection, and More
// Like This (movies).

const CAST_PREVIEW_COUNT = 12;
const SIMILAR_PREVIEW_COUNT = 12;

function getParams() {
  const params = new URLSearchParams(window.location.search);
  return { mediaType: params.get('type'), tmdbId: params.get('id') };
}

function formatRuntime(minutes) {
  if (!minutes) return null;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return hours > 0 ? `${hours}h ${String(mins).padStart(2, '0')}m` : `${mins}m`;
}

function renderHeader(data, mediaType, item) {
  const backdrop = backdropUrl(data.backdrop_path);
  if (backdrop) document.getElementById('detail-hero').style.backgroundImage = `url('${backdrop}')`;

  const posterSlot = document.getElementById('detail-poster');
  posterSlot.replaceWith(buildPosterArt(item.title, posterUrl(item.posterPath), { lazy: false }));

  document.getElementById('detail-title').textContent = item.title;

  const parts = [item.year];
  if (data.genres && data.genres.length) parts.push(data.genres[0].name);
  if (mediaType === 'movie') {
    parts.push(formatRuntime(data.runtime));
  } else if (data.number_of_seasons) {
    parts.push(`${data.number_of_seasons} season${data.number_of_seasons === 1 ? '' : 's'}`);
  }
  document.getElementById('detail-meta').textContent = parts.filter(Boolean).join(' • ');

  const ratingEl = document.getElementById('detail-rating');
  if (data.vote_average) {
    ratingEl.innerHTML = `${ratingStarSvg(16)}<span>${Number(data.vote_average).toFixed(1)}/10</span>`;
    ratingEl.hidden = false;
  }

  const overview = document.getElementById('detail-overview');
  const toggle = document.getElementById('overview-toggle');
  overview.textContent = textOrEnglish(data, 'overview') || 'No overview available.';
  requestAnimationFrame(() => {
    toggle.hidden = overview.scrollHeight <= overview.clientHeight;
  });
  toggle.addEventListener('click', () => {
    const expanded = overview.classList.toggle('expanded');
    toggle.textContent = expanded ? 'Show less' : 'Show more';
  });
}

// A round secondary icon button whose icon fills while it's on - the detail page's watched,
// save and favourite buttons, driven by media.js's attach*Button helpers.
function buildIconButton(icon) {
  const btn = el('button', 'tt-btn tt-btn--secondary tt-btn--icon');
  btn.type = 'button';
  btn.setOn = on => {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.innerHTML = ttIcon(icon, { size: 20, filled: on });
  };
  btn.setOn(false);
  return btn;
}

function findTrailer(data) {
  const videos = (data.videos && data.videos.results) || [];
  return videos.find(v => v.site === 'YouTube' && v.type === 'Trailer' && v.official)
    || videos.find(v => v.site === 'YouTube' && v.type === 'Trailer');
}

function renderActions(data, item, context) {
  const actionsEl = document.getElementById('detail-actions');

  if (item.mediaType === 'movie') {
    const watched = buildIconButton('eye');
    actionsEl.appendChild(watched);
    attachWatchedButton(null, item, context.watchedMovieIds, null, { button: watched });
  }

  // The save popover positions itself against the button's parent.
  const saveAnchor = el('span', 'save-anchor');
  const save = buildIconButton('bookmark');
  saveAnchor.appendChild(save);
  actionsEl.appendChild(saveAnchor);
  attachSaveButton(null, item, context, { button: save });

  const favorite = buildIconButton('heart');
  actionsEl.appendChild(favorite);
  attachFavoriteButton(null, item, context.favoriteIds, null, { button: favorite });

  const trailer = findTrailer(data);
  if (trailer) {
    const link = el('a', 'tt-btn tt-btn--secondary');
    link.href = `https://www.youtube.com/watch?v=${trailer.key}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.innerHTML = `${ttIcon('play', { size: 20 })}<span>Trailer</span>`;
    actionsEl.appendChild(link);
  }
}

// ---------- Seasons ----------

async function renderSeasons(data, item) {
  const section = document.getElementById('seasons-section');
  const rowsEl = document.getElementById('season-rows');
  section.hidden = false;

  const { episodes: watchedEpisodes, newSeasonNumbers } = await fetchJson(`/api/watched/shows/${item.tmdbId}/episodes`)
    .catch(() => ({ episodes: [], newSeasonNumbers: [] }));
  const newSeasons = new Set(newSeasonNumbers || []);
  const watchedBySeason = new Map();
  watchedEpisodes.forEach(e => watchedBySeason.set(e.seasonNumber, (watchedBySeason.get(e.seasonNumber) || 0) + 1));

  const total = data.number_of_episodes || 0;
  document.getElementById('show-progress-label').textContent = `${watchedEpisodes.length}/${total} episodes watched`;
  document.getElementById('show-progress-bar').appendChild(buildProgressBar(watchedEpisodes.length, total, 'Episodes watched'));

  (data.seasons || []).filter(s => s.season_number > 0).forEach(season => {
    const comingSoon = season.episode_count === 0;
    const watched = watchedBySeason.get(season.season_number) || 0;
    const done = !comingSoon && watched >= season.episode_count;

    const row = el(comingSoon ? 'div' : 'a', `tt-row${done ? ' tt-row--done' : ''}${comingSoon ? ' tt-row--disabled' : ''}`);
    if (!comingSoon) row.href = `episodes.html?id=${item.tmdbId}&season=${season.season_number}`;

    const label = el('span', 'tt-row__label', season.name || `Season ${season.season_number}`);
    if (newSeasons.has(season.season_number)) label.appendChild(el('span', 'new-pill', 'New'));
    row.appendChild(label);

    const count = el('span', 'tt-row__count');
    if (comingSoon) {
      count.textContent = 'Coming soon';
    } else {
      if (done) count.insertAdjacentHTML('beforeend', ttIcon('check', { size: 16, strokeWidth: 2.2 }));
      count.appendChild(document.createTextNode(`${watched}/${season.episode_count} watched`));
      count.insertAdjacentHTML('beforeend', ttIcon('chevron', { size: 16 }));
    }
    row.appendChild(count);
    rowsEl.appendChild(row);
  });
}

// ---------- Cast, collection, more like this ----------

function renderCast(data) {
  const container = document.getElementById('cast-list');
  const toggle = document.getElementById('cast-toggle');
  const cast = (data.credits && data.credits.cast) || [];
  if (cast.length === 0) {
    document.getElementById('cast-section').hidden = true;
    return;
  }

  const render = all => {
    container.innerHTML = '';
    cast.slice(0, all ? cast.length : CAST_PREVIEW_COUNT).forEach(person => {
      container.appendChild(buildCastCard({ tmdbId: person.id, name: person.name, role: person.character, profilePath: person.profile_path }));
    });
    container.classList.toggle('expanded', all);
    toggle.textContent = all ? 'Show less' : 'See all';
  };

  let expanded = false;
  toggle.hidden = cast.length <= CAST_PREVIEW_COUNT;
  toggle.addEventListener('click', () => { expanded = !expanded; render(expanded); });
  render(false);
}

async function renderCollection(collectionId, currentTmdbId, context) {
  const collection = await fetchJson(`/api/tmdb/collection/${collectionId}`).catch(() => null);
  if (!collection) return;
  const parts = (collection.parts || [])
    .filter(part => part.id !== currentTmdbId)
    .sort((a, b) => (a.release_date || '9999').localeCompare(b.release_date || '9999'));
  if (parts.length === 0) return;

  document.getElementById('collection-title').textContent = collection.name || 'Collection';
  const listEl = document.getElementById('collection-list');
  parts.forEach(part => {
    const item = toStandardItem(part, 'movie');
    const card = buildCard(item);
    attachStandardActions(card, item, context);
    listEl.appendChild(card);
  });
  document.getElementById('collection-section').hidden = false;
}

function renderSimilar(data, item, context) {
  const results = (data.recommendations && data.recommendations.results) || [];
  if (results.length === 0) return;
  const listEl = document.getElementById('similar-list');
  results.slice(0, SIMILAR_PREVIEW_COUNT).forEach(raw => {
    const similar = toStandardItem(raw, item.mediaType);
    const card = buildCard(similar);
    attachStandardActions(card, similar, context);
    listEl.appendChild(card);
  });
  document.getElementById('similar-see-all').href = `media-list.html?source=similar&type=${item.mediaType}&id=${item.tmdbId}`;
  document.getElementById('similar-section').hidden = false;
}

// ---------- Friends on this title (roadmap Phase 7, step 2) ----------
// "Ana is on S3 · E4", "Ana and Rui watched this", from GET /v1/friends/title (serverApi.js's
// getTitleFriends), as much as each friend shares. Tapping it lists them, each opening their
// profile. Only for a signed-in online profile with friends.

function friendNames(friends) {
  const names = friends.map(f => f.displayName);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

function titleFriendsSummary(friends, mediaType) {
  const watchers = friends.filter(f => f.watchedAt);
  if (watchers.length === 1 && mediaType === 'tv' && watchers[0].latest) {
    const { season, episode } = watchers[0].latest;
    return `${watchers[0].displayName} is on S${season} · E${episode}`;
  }
  if (watchers.length) return `${friendNames(watchers)} watched this`;
  const favourites = friends.filter(f => f.favorite);
  if (favourites.length === friends.length) return `${friendNames(friends)} ${friends.length === 1 ? 'has' : 'have'} this in their favourites`;
  if (friends.every(f => f.watchlist)) return `${friendNames(friends)} ${friends.length === 1 ? 'wants' : 'want'} to watch this`;
  return `${friendNames(friends)} saved this`;
}

function titleFriendDetail(friend, mediaType) {
  const parts = [];
  if (friend.watchedAt) {
    if (mediaType === 'tv' && friend.latest) {
      parts.push(`On S${friend.latest.season} · E${friend.latest.episode}`);
      parts.push(`${friend.episodes} episode${friend.episodes === 1 ? '' : 's'} watched`);
    } else {
      parts.push(`Watched ${timeAgo(friend.watchedAt).toLowerCase()}`);
    }
  }
  if (friend.favorite) parts.push('Favourite');
  if (friend.watchlist) parts.push('On their Watchlist');
  return parts.join(' · ');
}

async function renderTitleFriends(mediaType, tmdbId) {
  const profile = getActiveProfile();
  if (!canAskAboutFriends(profile)) return;
  let friends;
  try {
    friends = (await getTitleFriends(profile, mediaType, tmdbId)).friends;
  } catch (error) {
    return; // Friends are extra: the page is fine without them.
  }
  if (!friends.length) return;
  const box = document.getElementById('detail-friends');
  const toggle = el('button', 'detail-friends__summary');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  const faces = el('span', 'detail-friends__faces');
  friends.slice(0, 3).forEach(f => faces.appendChild(buildFriendAvatar(f.displayName, 'friend-row__avatar detail-friends__face')));
  toggle.appendChild(faces);
  toggle.appendChild(el('span', 'detail-friends__text', titleFriendsSummary(friends, mediaType)));
  const chevron = el('span', 'detail-friends__chevron');
  chevron.innerHTML = ttIcon('chevron', { size: 18 });
  toggle.appendChild(chevron);

  const list = el('div', 'settings-card detail-friends__list');
  list.hidden = true;
  friends.forEach(friend => {
    const row = el('a', 'settings-row friend-row');
    row.href = `friend.html?id=${encodeURIComponent(friend.id)}`;
    row.appendChild(buildFriendAvatar(friend.displayName));
    const text = el('span', 'settings-row__text');
    text.appendChild(el('span', 'settings-row__label', friend.displayName));
    text.appendChild(el('span', 'settings-row__sub', titleFriendDetail(friend, mediaType)));
    row.appendChild(text);
    list.appendChild(row);
  });
  toggle.addEventListener('click', () => {
    list.hidden = !list.hidden;
    toggle.setAttribute('aria-expanded', String(!list.hidden));
  });
  box.append(toggle, list);
  box.hidden = false;
}

// ---------- Laptop (the design's browser detail page) ----------
// A full-width backdrop hero (breadcrumbs, poster, title, rating / year / genres / seasons /
// status, overview, the show's progress, Trailer / Watched / Watchlist / favourite), then a main
// column with the episodes (season tabs over EpisodeRows; shows only) and a 320px sidebar (next
// episode, details), then the phone page's cast, collection and More Like This, shown as
// full-width rows. Built only on laptops (isLaptopLayout); the phone hero, head, actions,
// overview and season rows are hidden there by CSS (.phone-only).

function sentenceCase(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1).toLowerCase() : text;
}

function languageName(code) {
  if (!code) return null;
  try {
    return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(code);
  } catch (error) {
    return code;
  }
}

function longDate(dateStr) {
  return dateStr ? parseLocalDate(dateStr).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null;
}

// Built before the title loads, so the breadcrumbs (media.js, data-crumbs-slot) land in it.
function buildWebDetail() {
  const main = document.querySelector('main');
  const hero = el('section', 'web-hero web-hero--detail web-only');
  const bd = el('div', 'web-hero__bd');
  bd.setAttribute('aria-hidden', 'true');
  hero.appendChild(bd);
  const wrap = el('div', 'web-wrap web-hero__in web-hero__in--detail');
  const crumbs = el('div', 'web-hero__crumbs');
  crumbs.dataset.crumbsSlot = '1';
  wrap.appendChild(crumbs);
  const row = el('div', 'web-hero__row');
  const poster = el('div', 'web-hero__poster');
  const info = el('div', 'web-hero__info web-hero__info--detail');
  info.appendChild(el('h1', 'web-hero__title'));
  row.append(poster, info);
  wrap.appendChild(row);
  hero.appendChild(wrap);
  main.insertBefore(hero, main.firstChild);

  const grid = el('div', 'web-wrap web-detail web-only');
  const mainCol = el('div', 'web-detail__main');
  const aside = el('aside', 'web-detail__aside');
  grid.append(mainCol, aside);
  hero.after(grid);
  return { hero, bd, poster, info, grid, mainCol, aside };
}

function webIconButton(icon, label, { iconOnly = false, primary = false } = {}) {
  const btn = el('button', `tt-btn ${primary ? 'tt-btn--primary' : 'tt-btn--secondary'} web-btn-lg${iconOnly ? ' tt-btn--icon' : ''}`);
  btn.type = 'button';
  btn.setOn = on => {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.innerHTML = ttIcon(icon, { size: 20, filled: on });
    if (!iconOnly) btn.appendChild(el('span', null, label));
  };
  if (iconOnly) btn.setAttribute('aria-label', label);
  btn.setOn(false);
  return btn;
}

function fillWebHero(web, data, mediaType, item, context, progress) {
  const backdrop = backdropUrl(data.backdrop_path);
  if (backdrop) web.bd.style.backgroundImage = `url('${backdrop}')`;
  web.poster.appendChild(buildPosterArt(item.title, posterUrl(item.posterPath), { lazy: false }));
  web.info.querySelector('.web-hero__title').textContent = item.title;

  const meta = el('div', 'web-hero__meta');
  if (data.vote_average) {
    const star = el('span', 'web-star');
    star.innerHTML = `${ratingStarSvg(16)}<span>${Number(data.vote_average).toFixed(1)}</span>`;
    meta.appendChild(star);
  }
  [
    item.year,
    (data.genres || []).slice(0, 3).map(g => g.name).join(', '),
    mediaType === 'movie' ? formatRuntime(data.runtime)
      : (data.number_of_seasons ? `${data.number_of_seasons} season${data.number_of_seasons === 1 ? '' : 's'}` : null),
    mediaType === 'tv' ? sentenceCase(data.status) : null,
  ].filter(Boolean).forEach(text => meta.appendChild(el('span', null, text)));
  web.info.appendChild(meta);

  const overview = textOrEnglish(data, 'overview');
  if (overview) web.info.appendChild(el('p', 'web-hero__overview', overview));

  if (progress) {
    const box = el('div', 'web-hero__progress');
    const barBox = el('div', 'web-hero__bar web-hero__bar--wide');
    progress.bar = buildProgressBar(progress.watched, progress.total, 'Episodes watched');
    barBox.appendChild(progress.bar);
    progress.label = document.createTextNode('');
    box.append(barBox, progress.label);
    web.info.appendChild(box);
    progress.update = () => {
      progress.bar.setProgress(progress.watched, progress.total);
      progress.label.textContent = `${progress.watched} of ${progress.total} episodes watched`;
    };
    progress.update();
  }

  const actions = el('div', 'web-hero__actions');
  const trailer = findTrailer(data);
  if (trailer) {
    const link = el('a', 'tt-btn tt-btn--primary web-btn-lg');
    link.href = `https://www.youtube.com/watch?v=${trailer.key}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.innerHTML = `${ttIcon('play', { size: 20, filled: true })}<span>Trailer</span>`;
    actions.appendChild(link);
  }
  if (mediaType === 'movie') {
    const watched = webIconButton('eye', 'Watched');
    actions.appendChild(watched);
    attachWatchedButton(null, item, context.watchedMovieIds, null, { button: watched });
  }
  const saveAnchor = el('span', 'save-anchor');
  const save = webIconButton('bookmark', 'Watchlist');
  saveAnchor.appendChild(save);
  actions.appendChild(saveAnchor);
  attachSaveButton(null, item, context, { button: save });
  const favorite = webIconButton('heart', 'Add to favourites', { iconOnly: true });
  actions.appendChild(favorite);
  attachFavoriteButton(null, item, context.favoriteIds, null, { button: favorite });
  web.info.appendChild(actions);
}

function fillWebAside(web, data, mediaType) {
  const next = mediaType === 'tv' && data.next_episode_to_air;
  if (next && next.air_date) {
    const card = el('section', 'web-card web-card--next');
    card.appendChild(el('span', 'web-eyebrow', 'Next episode'));
    const hasName = next.name && !/^Episode\s+\d+$/i.test(next.name.trim());
    card.appendChild(el('span', 'web-card__strong', `S${next.season_number} · E${next.episode_number}${hasName ? ` · ${next.name}` : ''}`));
    const when = relativeAirLabel(next.air_date);
    const day = parseLocalDate(next.air_date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    card.appendChild(el('span', 'web-card__sub', `${day} · ${when.charAt(0).toLowerCase()}${when.slice(1)}`));
    web.aside.appendChild(card);
  }

  const rows = mediaType === 'tv' ? [
    ['Created by', (data.created_by || []).map(p => p.name).join(', ')],
    ['Network', (data.networks || []).map(n => n.name).slice(0, 2).join(', ')],
    ['First aired', longDate(data.first_air_date)],
    ['Status', sentenceCase(data.status)],
    ['Episodes', data.number_of_episodes ? `${data.number_of_episodes}${(data.episode_run_time || [])[0] ? ` · ~${data.episode_run_time[0]}m each` : ''}` : null],
    ['Language', languageName(data.original_language)],
  ] : [
    ['Directed by', ((data.credits && data.credits.crew) || []).filter(c => c.job === 'Director').map(c => c.name).join(', ')],
    ['Released', longDate(data.release_date)],
    ['Runtime', formatRuntime(data.runtime)],
    ['Status', sentenceCase(data.status)],
    ['Language', languageName(data.original_language)],
  ];
  const card = el('section', 'web-card');
  card.appendChild(el('h2', 'web-card__title', 'Details'));
  const dl = el('dl', 'web-dl');
  rows.filter(([, v]) => v).forEach(([k, v]) => {
    dl.appendChild(el('dt', null, k));
    dl.appendChild(el('dd', null, v));
  });
  card.appendChild(dl);
  web.aside.appendChild(card);
  // A movie has no episodes column: the details card spans the page instead.
  if (mediaType === 'movie') web.grid.classList.add('web-detail--single');
}

// Season tabs over EpisodeRows. Marking an episode watched offers to catch up on every earlier
// unwatched episode, as episodes.html does. ?season= picks the tab (Home's links use it).
async function renderWebEpisodes(web, data, item, progress, watchedEpisodes, lastWatchedAt) {
  const seasons = (data.seasons || []).filter(s => s.season_number > 0);
  if (!seasons.length) return;
  const section = el('section', 'web-episodes');
  const head = el('div', 'tt-section');
  head.appendChild(el('h2', null, 'Episodes'));
  const summary = el('span', 'web-episodes__summary');
  head.appendChild(summary);
  section.appendChild(head);
  const tabs = el('div', 'web-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Seasons');
  section.appendChild(tabs);
  const list = el('div', 'web-episodes__list');
  section.appendChild(list);
  web.mainCol.appendChild(section);

  const watchedSet = new Set(watchedEpisodes.map(e => `${e.seasonNumber}:${e.episodeNumber}`));
  const seasonCounts = new Map(seasons.map(s => [s.season_number, s.episode_count]));
  const countWatched = n => [...watchedSet].filter(k => k.startsWith(`${n}:`)).length;
  const requested = Number(new URLSearchParams(window.location.search).get('season'));
  const firstUnfinished = seasons.find(s => s.episode_count > 0 && countWatched(s.season_number) < s.episode_count);
  let current = seasonCounts.has(requested) ? requested
    : (firstUnfinished || [...seasons].reverse().find(s => s.episode_count > 0) || seasons[0]).season_number;
  const seasonData = new Map();
  const rows = new Map();

  const tabButtons = new Map();
  function renderTabs() {
    tabs.innerHTML = '';
    seasons.forEach(s => {
      const on = s.season_number === current;
      const b = el('button', `web-tab${on ? ' web-tab--on' : ''}`);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.appendChild(document.createTextNode(s.name && !/^Season \d+$/.test(s.name) ? s.name : `Season ${s.season_number}`));
      b.appendChild(el('span', 'web-tab__count', s.episode_count ? `${countWatched(s.season_number)}/${s.episode_count}` : 'Soon'));
      b.addEventListener('click', () => { if (current !== s.season_number) { current = s.season_number; renderTabs(); loadSeason(); } });
      tabButtons.set(s.season_number, b);
      tabs.appendChild(b);
    });
    const total = seasonCounts.get(current) || 0;
    summary.textContent = total ? `Season ${current} · ${countWatched(current)} of ${total} watched` : `Season ${current} · coming soon`;
  }

  async function setWatched(s, e, on) {
    await fetch(`/api/watched/shows/${item.tmdbId}/season/${s}/episode/${e}`, { method: on ? 'POST' : 'DELETE', credentials: 'same-origin' });
    const key = `${s}:${e}`;
    const had = watchedSet.has(key);
    if (on) watchedSet.add(key);
    else watchedSet.delete(key);
    if (had !== on && progress) {
      progress.watched += on ? 1 : -1;
      progress.update();
    }
    if (s === current && rows.has(e)) rows.get(e).setWatched(on);
  }

  function unwatchedBefore(season, e) {
    const before = [];
    seasonCounts.forEach((count, s) => {
      const last = s < season ? count : s === season ? e - 1 : 0;
      for (let n = 1; n <= last; n++) if (!watchedSet.has(`${s}:${n}`)) before.push([s, n]);
    });
    return before;
  }

  async function loadSeason() {
    const season = current;
    list.innerHTML = '';
    list.appendChild(buildSkeletonMediaRow());
    if (!seasonData.has(season)) {
      seasonData.set(season, await fetchJson(`/api/tmdb/tv/${item.tmdbId}/season/${season}`).catch(() => null));
    }
    if (season !== current) return;
    const episodes = (seasonData.get(season) && seasonData.get(season).episodes) || [];
    list.innerHTML = '';
    rows.clear();
    if (!episodes.length) {
      list.appendChild(el('p', 'empty-note', 'No episodes announced yet. They appear here once TMDB lists them.'));
      return;
    }
    episodes.forEach(episode => {
      const key = `${season}:${episode.episode_number}`;
      const isNew = !watchedSet.has(key) && !isUnreleased(episode.air_date)
        && lastWatchedAt && new Date(episode.air_date) > new Date(lastWatchedAt);
      const row = buildEpisodeRow(episode, {
        watched: watchedSet.has(key),
        isNew,
        onToggle: async () => {
          const nowWatched = !watchedSet.has(key);
          await setWatched(season, episode.episode_number, nowWatched);
          if (nowWatched) {
            const before = unwatchedBefore(season, episode.episode_number);
            if (before.length) {
              const ok = await confirmDialog({
                title: 'Catch up?',
                message: `You have ${before.length} unwatched episode${before.length === 1 ? '' : 's'} before this one. Mark ${before.length === 1 ? 'it' : 'them'} as watched too?`,
                confirmLabel: 'Mark watched',
                cancelLabel: 'No',
              });
              if (ok) await Promise.all(before.map(([s, n]) => setWatched(s, n, true)));
            }
          }
          renderTabs();
          return nowWatched;
        },
      });
      rows.set(episode.episode_number, row);
      list.appendChild(row);
    });
  }

  renderTabs();
  loadSeason();
}

async function renderWebDetail(web, data, mediaType, item, context) {
  let watchedEpisodes = [];
  let lastWatchedAt = null;
  let progress = null;
  if (mediaType === 'tv') {
    const res = await fetchJson(`/api/watched/shows/${item.tmdbId}/episodes`).catch(() => ({ episodes: [] }));
    watchedEpisodes = res.episodes || [];
    lastWatchedAt = res.lastWatchedAt || null;
    if (data.number_of_episodes) progress = { watched: watchedEpisodes.length, total: data.number_of_episodes };
  }
  fillWebHero(web, data, mediaType, item, context, progress);
  fillWebAside(web, data, mediaType);
  if (mediaType === 'tv') renderWebEpisodes(web, data, item, progress, watchedEpisodes, lastWatchedAt);
}

document.addEventListener('DOMContentLoaded', async () => {
  const { mediaType, tmdbId } = getParams();
  if (!mediaType || !tmdbId || !['movie', 'tv'].includes(mediaType)) {
    document.querySelector('main').innerHTML = '<p class="empty-note">This title couldn\'t be found.</p>';
    return;
  }

  const web = isLaptopLayout() ? buildWebDetail() : null;

  // Highlight Movies or Shows in the bottom nav, depending on what this is.
  const nav = document.getElementById('bottom-nav');
  nav.dataset.active = mediaType === 'movie' ? 'movies' : 'shows';
  renderBottomNav(nav);

  // Shows get More Like This on laptops only (the phone page doesn't have it).
  const extras = [mediaType === 'movie' || web ? 'credits,videos,recommendations' : 'credits,videos', withTranslations()].filter(Boolean).join(',');
  const [data, context] = await Promise.all([
    fetchJson(`/api/tmdb/${mediaType}/${tmdbId}?append_to_response=${extras}`),
    fetchStandardActionContext(),
  ]);

  const item = toStandardItem(data, mediaType);
  document.title = item.title;

  renderHeader(data, mediaType, item);
  renderActions(data, item, context);
  renderTitleFriends(mediaType, item.tmdbId);
  renderCast(data);

  if (mediaType === 'tv') renderSeasons(data, item);
  if (mediaType === 'movie' && data.belongs_to_collection) renderCollection(data.belongs_to_collection.id, data.id, context);
  if (mediaType === 'movie' || web) renderSimilar(data, item, context);
  if (web) renderWebDetail(web, data, mediaType, item, context);
});
