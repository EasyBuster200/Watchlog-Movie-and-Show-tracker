// Home: Continue Watching (shows in progress), Airing Soon (the next episodes of tracked
// shows), Friends (their latest activity, online profiles with friends only), then Trending
// Shows and Trending Movies.
const HOME_ROW_LIMIT = 3;

async function loadTrendingRow(mediaType, containerId, context) {
  const container = document.getElementById(containerId);
  await loadPosterRow(
    container,
    page => fetchJson(`/api/tmdb/trending/${mediaType}/day?language=en-US&page=${page}`),
    raw => {
      const item = toStandardItem(raw, mediaType);
      const card = buildCard(item);
      attachStandardActions(card, item, context);
      return card;
    }
  );
}

async function loadContinueWatching() {
  const container = document.getElementById('continue-watching');
  container.innerHTML = '';
  container.appendChild(buildSkeletonMediaRow());
  try {
    const shows = await fetchJson('/api/watched/shows?includeStatus=true');
    // Only shows with aired episodes left that aren't dropped (localApi.js's computeShowStatus),
    // most recently watched first.
    const watching = shows
      .filter(s => s.status === 'watching')
      .sort((a, b) => (b.lastWatchedAt || '').localeCompare(a.lastWatchedAt || ''));

    container.innerHTML = '';
    if (watching.length === 0) {
      container.appendChild(el('p', 'empty-note', 'Nothing in progress. Mark an episode watched on any show to see it here.'));
      return;
    }
    watching.slice(0, HOME_ROW_LIMIT).forEach(show => {
      const next = show.nextUnwatched;
      container.appendChild(buildMediaRow({
        href: detailUrl(show),
        title: show.title,
        meta: next ? `Next: S${next.seasonNumber} · E${next.episodeNumber}` : null,
        imageSrc: thumbUrl(show.posterPath),
        progress: { watched: show.watched, total: show.total },
      }));
    });
  } catch (error) {
    console.error('Failed to load continue watching:', error);
    container.innerHTML = '';
    container.appendChild(el('p', 'empty-note', "Couldn't load your shows."));
  }
}

async function loadAiringSoon() {
  const container = document.getElementById('airing-soon');
  container.innerHTML = '';
  container.appendChild(buildSkeletonMediaRow());
  try {
    const shows = await fetchJson('/api/watched/shows/upcoming');
    container.innerHTML = '';
    if (!Array.isArray(shows) || shows.length === 0) {
      container.appendChild(el('p', 'empty-note', "No new episodes announced for the shows you're tracking."));
      return;
    }
    shows.slice(0, HOME_ROW_LIMIT).forEach(show => {
      const { seasonNumber, episodeNumber, airDate, name } = show.nextEpisode;
      container.appendChild(buildAiringRow({
        href: detailUrl(show),
        title: show.title,
        airDate,
        seasonNumber,
        episodeNumber,
        episodeName: name,
      }));
    });
  } catch (error) {
    console.error('Failed to load airing soon:', error);
    container.innerHTML = '';
    container.appendChild(el('p', 'empty-note', "Couldn't load upcoming episodes."));
  }
}

async function loadFriendsActivity() {
  const section = document.getElementById('friends-activity-section');
  if (!canAskAboutFriends(getActiveProfile())) return;
  section.hidden = false;
  const shown = await renderFriendActivity(document.getElementById('friends-activity'), { limit: HOME_ROW_LIMIT });
  if (shown === null) section.hidden = true;
}

// ---------- Laptop (the design's browser Home) ----------
// A full-width "Up next for you" hero (the most recently watched show in progress: its next
// episode, its overview, the show's progress, Open episode / Show details), Continue watching
// as four LandscapeCards, and "Airing this week" as a Monday-to-Sunday strip. Built only when the
// laptop layout applies (media.js's isLaptopLayout); the phone's Continue Watching and Airing
// Soon rows are hidden there by CSS (.phone-only).
const WEB_CONTINUE_LIMIT = 4;

function weekDays(now = new Date()) {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

// The next episode's own details (title, runtime, overview, rating, still), from the season.
async function nextEpisodeFor(show) {
  const next = show.nextUnwatched;
  if (!next) return null;
  const season = await fetchJson(`/api/tmdb/tv/${show.tmdbId}/season/${next.seasonNumber}`).catch(() => null);
  const ep = season && (season.episodes || []).find(e => e.episode_number === next.episodeNumber);
  return { ...next, name: ep && ep.name, runtime: ep && ep.runtime, overview: ep && ep.overview, rating: ep && ep.vote_average, still: ep && ep.still_path };
}

function episodeLabel(ep) {
  const hasName = ep.name && !/^Episode\s+\d+$/i.test(ep.name.trim());
  return `S${ep.seasonNumber} · E${ep.episodeNumber}${hasName ? ` · ${ep.name}` : ''}`;
}

function showSeasonUrl(show, seasonNumber) {
  return `${detailUrl(show)}&season=${seasonNumber}`;
}

function webSection(title, linkLabel, href) {
  const section = el('section', 'web-wrap web-sec web-only');
  const head = el('div', 'tt-section');
  head.appendChild(el('h2', null, title));
  if (linkLabel) {
    const a = el('a', 'tt-link', linkLabel);
    a.href = href;
    head.appendChild(a);
  }
  section.appendChild(head);
  return section;
}

function renderWebHero(show, ep, details) {
  const hero = el('section', 'web-hero web-hero--home web-only');
  const bd = el('div', 'web-hero__bd');
  bd.setAttribute('aria-hidden', 'true');
  const backdrop = details && backdropUrl(details.backdrop_path);
  if (backdrop) bd.style.backgroundImage = `url('${backdrop}')`;
  hero.appendChild(bd);
  const wrap = el('div', 'web-wrap web-hero__in');
  const info = el('div', 'web-hero__info');
  info.appendChild(el('span', 'web-eyebrow', 'Up next for you'));
  info.appendChild(el('h1', 'web-hero__title', show.title));
  const meta = el('div', 'web-hero__meta');
  meta.appendChild(el('span', 'web-hero__strong', episodeLabel(ep)));
  if (ep.runtime) meta.appendChild(el('span', null, `${ep.runtime}m`));
  if (ep.rating) {
    const star = el('span', 'web-star');
    star.innerHTML = `${ratingStarSvg(16)}<span>${Number(ep.rating).toFixed(1)}</span>`;
    meta.appendChild(star);
  }
  info.appendChild(meta);
  const overview = (ep.overview && ep.overview.trim()) || (details && textOrEnglish(details, 'overview'));
  if (overview) info.appendChild(el('p', 'web-hero__overview', overview));
  if (show.total) {
    const progress = el('div', 'web-hero__progress');
    const barBox = el('div', 'web-hero__bar');
    barBox.appendChild(buildProgressBar(show.watched, show.total, `${show.title} progress`));
    progress.appendChild(barBox);
    progress.appendChild(document.createTextNode(`${show.watched} of ${show.total} episodes`));
    info.appendChild(progress);
  }
  const actions = el('div', 'web-hero__actions');
  const open = el('a', 'tt-btn tt-btn--primary web-btn-lg', 'Open episode');
  open.href = showSeasonUrl(show, ep.seasonNumber);
  const more = el('a', 'tt-btn tt-btn--secondary web-btn-lg', 'Show details');
  more.href = detailUrl(show);
  actions.append(open, more);
  info.appendChild(actions);
  wrap.appendChild(info);
  hero.appendChild(wrap);
  return hero;
}

async function renderWebContinue(main, watching) {
  const section = webSection('Continue watching', 'See all', 'media-list.html?source=watched&type=tv&filter=watching');
  const grid = el('div', 'web-land-grid');
  section.appendChild(grid);
  main.insertBefore(section, main.querySelector('.home-continue'));
  if (!watching.length) {
    grid.appendChild(el('p', 'empty-note', 'Nothing in progress. Mark an episode watched on any show to see it here.'));
    return;
  }
  const shows = watching.slice(0, WEB_CONTINUE_LIMIT);
  const [episodes, details] = await Promise.all([
    Promise.all(shows.map(nextEpisodeFor)),
    Promise.all(shows.map(s => fetchJson(`/api/tmdb/tv/${s.tmdbId}`).catch(() => null))),
  ]);
  shows.forEach((show, i) => {
    const ep = episodes[i];
    const still = (details[i] && backdropUrl(details[i].backdrop_path)) || (ep && ep.still ? stillUrl(ep.still) : null);
    grid.appendChild(buildLandscapeCard({
      href: ep ? showSeasonUrl(show, ep.seasonNumber) : detailUrl(show),
      title: show.title,
      meta: ep ? episodeLabel(ep) : null,
      image: still,
      badge: show.hasNewEpisodes ? 'New' : null,
      watched: show.watched,
      total: show.total,
    }));
  });
  // The hero takes the first show in progress, with its backdrop.
  if (episodes[0]) document.body.insertBefore(renderWebHero(shows[0], episodes[0], details[0]), main);
}

async function renderWebWeek(main) {
  const section = webSection('Airing this week', 'Full calendar', 'airing-soon.html');
  const strip = el('div', 'web-week');
  section.appendChild(strip);
  main.insertBefore(section, main.querySelector('.home-airing'));
  const days = weekDays();
  const from = localDateString(days[0]);
  let schedule = [];
  try {
    schedule = await fetchJson(`/api/watched/shows/schedule?from=${from}`);
  } catch (error) {
    console.error('Failed to load this week:', error);
  }
  const today = localDateString(new Date());
  days.forEach(day => {
    const key = localDateString(day);
    const isToday = key === today;
    const col = el('div', `web-day${isToday ? ' web-day--today' : ''}`);
    const head = el('div', 'web-day__head');
    head.appendChild(el('span', 'web-day__dow', day.toLocaleDateString(undefined, { weekday: 'short' })));
    head.appendChild(el('span', 'web-day__date', `${day.getDate()}${isToday ? ' · Today' : ''}`));
    col.appendChild(head);
    const eps = (schedule || []).filter(ep => ep.airDate === key);
    if (!eps.length) col.appendChild(el('span', 'web-day__none', 'Nothing airing'));
    eps.forEach(ep => {
      const card = el('a', 'web-day__ep');
      card.href = showSeasonUrl(ep, ep.seasonNumber);
      card.appendChild(el('span', 'web-day__title', ep.title));
      const premiere = ep.episodeNumber === 1 ? ' · Premiere' : '';
      card.appendChild(el('span', 'web-day__sub', `S${ep.seasonNumber} · E${ep.episodeNumber}${premiere}`));
      col.appendChild(card);
    });
    strip.appendChild(col);
  });
}

async function renderWebHome() {
  const main = document.querySelector('main');
  let watching = [];
  try {
    const shows = await fetchJson('/api/watched/shows?includeStatus=true');
    watching = shows
      .filter(s => s.status === 'watching')
      .sort((a, b) => (b.lastWatchedAt || '').localeCompare(a.lastWatchedAt || ''));
  } catch (error) {
    console.error('Failed to load shows for the laptop Home:', error);
  }
  renderWebContinue(main, watching);
  renderWebWeek(main);
}

document.addEventListener('DOMContentLoaded', async () => {
  if (isLaptopLayout()) renderWebHome();
  loadContinueWatching();
  loadAiringSoon();
  loadFriendsActivity();
  const context = await fetchStandardActionContext();
  loadTrendingRow('tv', 'trending-shows', context);
  loadTrendingRow('movie', 'trending-movies', context);
});
