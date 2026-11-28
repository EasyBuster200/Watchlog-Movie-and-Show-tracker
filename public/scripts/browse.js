// "Browse All" on the Movies and Shows pages: a BrowseHeader ("Browse All Movies", a summary
// line, a sort menu and a genre filter sheet), then a three-column grid of TMDB's discover
// results with Prev/Next paging. Titles already watched are left out (`excludeIds()` returns
// their TMDB ids).

const BROWSE_SORTS = [
  { id: 'popular', label: 'Popular' },
  { id: 'rated', label: 'Top rated' },
  { id: 'newest', label: 'Newest' },
];

function browseSortParams(sort, mediaType) {
  const today = new Date().toISOString().slice(0, 10);
  const dateField = mediaType === 'movie' ? 'primary_release_date' : 'first_air_date';
  if (sort === 'rated') return { sort_by: 'vote_average.desc', 'vote_count.gte': '300' };
  if (sort === 'newest') return { sort_by: `${dateField}.desc`, [`${dateField}.lte`]: today, 'vote_count.gte': '20' };
  return { sort_by: 'popularity.desc' };
}

function initBrowse({ mediaType, context, excludeIds = () => new Set() }) {
  const state = { sort: 'popular', picked: [], page: 1 };

  const emptyEl = document.getElementById('browse-empty');
  const grid = document.getElementById('browse-grid');
  const pager = document.getElementById('browse-pagination');

  // Genres are a "multi" section: any picked genre matches. The section is added once TMDB's
  // genre list has loaded.
  const header = createBrowseHeader({
    title: `Browse All ${mediaType === 'movie' ? 'Movies' : 'Shows'}`,
    sortOptions: BROWSE_SORTS,
    sort: state.sort,
    onChange: ({ sort, values }) => {
      state.sort = sort;
      state.picked = values.genres || [];
      state.page = 1;
      loadPage();
    },
  });
  document.getElementById('browse-header').appendChild(header.el);

  async function loadPage() {
    const params = new URLSearchParams({
      page: state.page,
      language: 'en-US',
      include_adult: 'false',
      ...browseSortParams(state.sort, mediaType),
    });
    // Any of the picked genres (TMDB: "|" is OR).
    if (state.picked.length) params.set('with_genres', state.picked.join('|'));

    emptyEl.hidden = true;
    grid.innerHTML = '';
    renderSkeletonRow(grid, 9);
    try {
      const data = await fetchJson(`/api/tmdb/discover/${mediaType}?${params.toString()}`);
      const skip = excludeIds();
      grid.innerHTML = '';
      const results = (data.results || []).filter(raw => !skip.has(raw.id));
      emptyEl.hidden = results.length > 0;
      results.forEach(raw => {
        const item = toStandardItem(raw, mediaType);
        const card = buildCard(item);
        attachStandardActions(card, item, context);
        grid.appendChild(card);
      });
      // TMDB stops serving discover results after page 500.
      renderPagination(pager, data.page || state.page, Math.min(data.total_pages || 1, 500), page => {
        state.page = page;
        loadPage();
      });
    } catch (error) {
      console.error('Failed to load browse grid:', error);
      grid.innerHTML = '';
      grid.appendChild(el('p', 'empty-note', "Couldn't load this page. Check your connection."));
    }
  }

  fetchJson(`/api/tmdb/genre/${mediaType}/list`)
    .then(data => header.update({
      sections: [{ id: 'genres', label: 'Genres', kind: 'multi', options: (data.genres || []).map(g => ({ id: g.id, label: g.name })) }],
    }))
    .catch(error => console.error('Failed to load genres:', error));

  loadPage();
}

// ---------- Laptop browse view (the design's Browser · Movies) ----------
// Under the page's rows on laptops (decided with the user: the rows stay): a header with a
// "Sort by" dropdown, collection tabs (All / Coming soon / Top rated / Recommended), a 240px
// filter sidebar (genre checklist, release year, Hide watched), the result count, a six-column
// grid and numbered pages. No genre counts (decided with the user). The phone's Browse All
// section is hidden there (.phone-only), and only one of the two is built.
const WEB_SORTS = [
  { id: 'popular', label: 'Popularity' },
  { id: 'rating', label: 'Rating' },
  { id: 'date', label: 'Release date' },
  { id: 'title', label: 'Title A–Z' },
];
const WEB_TABS = [
  { id: 'all', label: 'All' },
  { id: 'soon', label: 'Coming soon' },
  { id: 'top', label: 'Top rated' },
  { id: 'recommended', label: 'Recommended' },
];
const WEB_PAGE_SIZE = 20;

function webDiscoverParams(state, mediaType) {
  const isMovie = mediaType === 'movie';
  const dateField = isMovie ? 'primary_release_date' : 'first_air_date';
  const today = localDateString(new Date());
  const tomorrow = localDateString(new Date(Date.now() + 864e5));
  const params = { page: String(state.page), language: 'en-US', include_adult: 'false' };
  if (state.tab === 'top') Object.assign(params, { sort_by: 'vote_average.desc', 'vote_count.gte': '300' });
  else if (state.sort === 'rating') Object.assign(params, { sort_by: 'vote_average.desc', 'vote_count.gte': '300' });
  else if (state.sort === 'date') Object.assign(params, { sort_by: `${dateField}.desc`, 'vote_count.gte': state.tab === 'soon' ? '0' : '20' });
  else if (state.sort === 'title') params.sort_by = isMovie ? 'title.asc' : 'name.asc';
  else params.sort_by = 'popularity.desc';

  let gte = state.yearFrom ? `${state.yearFrom}-01-01` : null;
  let lte = state.yearTo ? `${state.yearTo}-12-31` : null;
  if (state.tab === 'soon') {
    if (!gte || gte < tomorrow) gte = tomorrow;
    if (isMovie) Object.assign(params, { region: getUserRegion(), with_release_type: '2|3' });
  } else if (state.sort === 'date' && (!lte || lte > today)) {
    lte = today;
  }
  if (gte) params[`${dateField}.gte`] = gte;
  if (lte) params[`${dateField}.lte`] = lte;
  if (state.genres.length) params.with_genres = state.genres.join('|');
  return params;
}

// Numbered pages: Prev, 1, …, the pages around the current one, …, the last, Next.
function renderNumberedPagination(container, current, total, onPage) {
  container.innerHTML = '';
  if (!total || total <= 1) return;
  const button = (label, page, { on = false, disabled = false, aria = null, icon = null } = {}) => {
    const b = el('button', `web-pg${on ? ' web-pg--on' : ''}`);
    b.type = 'button';
    if (icon) b.innerHTML = ttIcon(icon, { size: 16, strokeWidth: 2 });
    else b.textContent = label;
    if (aria) b.setAttribute('aria-label', aria);
    if (on) b.setAttribute('aria-current', 'page');
    if (disabled) b.setAttribute('aria-disabled', 'true');
    else if (!on) b.addEventListener('click', () => onPage(page));
    container.appendChild(b);
  };
  button('', current - 1, { disabled: current <= 1, aria: 'Previous page', icon: 'chevron-left' });
  const pages = new Set([1, total, current - 1, current, current + 1].filter(p => p >= 1 && p <= total));
  if (current <= 3) [2, 3].forEach(p => p <= total && pages.add(p));
  let last = 0;
  [...pages].sort((a, b) => a - b).forEach(p => {
    if (p - last > 1) container.appendChild(el('span', 'web-pg__gap', '…'));
    button(p.toLocaleString(), p, { on: p === current });
    last = p;
  });
  button('', current + 1, { disabled: current >= total, aria: 'Next page', icon: 'chevron' });
}

function initWebBrowse({ mediaType, context, excludeIds = () => new Set() }) {
  const noun = mediaType === 'movie' ? 'movie' : 'show';
  const state = { sort: 'popular', tab: 'all', genres: [], yearFrom: '', yearTo: '', hideWatched: false, page: 1 };
  let genreList = [];
  let recommendedPool = null;

  const section = el('section', 'web-browse web-only');
  const head = el('header', 'web-browse__head');
  const titles = el('div', 'web-browse__titles');
  titles.appendChild(el('h2', 'web-browse__title', `Browse all ${noun}s`));
  titles.appendChild(el('span', 'web-browse__sub', 'Browse everything on TMDB, or narrow it down with the filters.'));
  head.appendChild(titles);
  const sortLabel = el('label', 'web-sort', 'Sort by');
  const select = el('select', 'web-select');
  select.id = 'web-browse-sort';
  WEB_SORTS.forEach(s => {
    const o = el('option', null, s.label);
    o.value = s.id;
    select.appendChild(o);
  });
  select.addEventListener('change', () => { state.sort = select.value; state.page = 1; load(); });
  sortLabel.appendChild(select);
  head.appendChild(sortLabel);
  section.appendChild(head);

  const tabs = el('div', 'web-tabs web-browse__tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Collections');
  section.appendChild(tabs);
  const renderTabs = () => {
    tabs.innerHTML = '';
    WEB_TABS.forEach(t => {
      const on = t.id === state.tab;
      const b = el('button', `web-tab${on ? ' web-tab--on' : ''}`, t.label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.addEventListener('click', () => { if (!on) { state.tab = t.id; state.page = 1; renderTabs(); load(); } });
      tabs.appendChild(b);
    });
  };

  const body = el('div', 'web-browse__body');
  const aside = el('aside', 'web-filters');
  aside.setAttribute('aria-label', 'Filters');
  const genresBox = el('div', 'web-fl');
  const genresHead = el('div', 'web-fl__head');
  genresHead.appendChild(el('h3', null, 'Genres'));
  const clear = el('button', 'tt-link', 'Clear');
  clear.type = 'button';
  clear.hidden = true;
  clear.addEventListener('click', () => { state.genres = []; state.page = 1; renderGenres(); load(); });
  genresHead.appendChild(clear);
  genresBox.appendChild(genresHead);
  const genreItems = el('div', 'web-fl__list');
  genresBox.appendChild(genreItems);
  aside.appendChild(genresBox);

  const yearBox = el('div', 'web-fl');
  yearBox.appendChild(el('h3', null, 'Release year'));
  const yearRow = el('div', 'web-fl__years');
  const thisYear = new Date().getFullYear();
  const yearInput = (label, key) => {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'web-year';
    input.min = '1870';
    input.max = String(thisYear + 5);
    input.placeholder = key === 'yearFrom' ? '1900' : String(thisYear);
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => {
      const n = Number(input.value);
      state[key] = input.value && n >= 1870 && n <= thisYear + 5 ? String(Math.round(n)) : '';
      if (!state[key]) input.value = '';
      state.page = 1;
      load();
    });
    return input;
  };
  yearRow.append(yearInput('From year', 'yearFrom'), el('span', 'web-fl__dash', '–'), yearInput('To year', 'yearTo'));
  yearBox.appendChild(yearRow);
  aside.appendChild(yearBox);

  const hideBox = el('div', 'web-fl web-fl--row');
  hideBox.appendChild(el('span', 'web-fl__label', 'Hide watched'));
  const sw = el('button', 'tt-switch');
  sw.type = 'button';
  sw.setAttribute('role', 'switch');
  sw.setAttribute('aria-label', 'Hide watched');
  sw.appendChild(el('span', 'tt-switch__knob'));
  const syncSwitch = () => {
    sw.classList.toggle('tt-switch--on', state.hideWatched);
    sw.setAttribute('aria-checked', state.hideWatched ? 'true' : 'false');
  };
  sw.addEventListener('click', () => { state.hideWatched = !state.hideWatched; syncSwitch(); state.page = 1; load(); });
  syncSwitch();
  hideBox.appendChild(sw);
  aside.appendChild(hideBox);
  body.appendChild(aside);

  const results = el('div', 'web-results');
  const countLine = el('div', 'web-results__count');
  const empty = el('p', 'empty-note', 'Nothing matches these filters on this page. Try removing a genre.');
  empty.hidden = true;
  const grid = el('div', 'web-grid');
  const pager = el('nav', 'web-pager');
  pager.setAttribute('aria-label', 'Pages');
  results.append(countLine, empty, grid, pager);
  body.appendChild(results);
  section.appendChild(body);
  document.querySelector('main').appendChild(section);

  function renderGenres() {
    genreItems.innerHTML = '';
    genreList.forEach(g => {
      const on = state.genres.includes(g.id);
      const b = el('button', `web-ck${on ? ' web-ck--on' : ''}`);
      b.type = 'button';
      b.setAttribute('role', 'checkbox');
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      const box = el('span', 'web-ck__box');
      box.innerHTML = ttIcon('check', { size: 12, strokeWidth: 3 });
      b.append(box, document.createTextNode(g.name));
      b.addEventListener('click', () => {
        state.genres = on ? state.genres.filter(id => id !== g.id) : [...state.genres, g.id];
        state.page = 1;
        renderGenres();
        load();
      });
      genreItems.appendChild(b);
    });
    clear.hidden = state.genres.length === 0;
  }

  function describe(total) {
    const names = genreList.filter(g => state.genres.includes(g.id)).map(g => g.name);
    const sortName = (WEB_SORTS.find(s => s.id === state.sort) || WEB_SORTS[0]).label.toLowerCase();
    countLine.innerHTML = '';
    countLine.appendChild(el('strong', null, `${total.toLocaleString()} ${noun}${total === 1 ? '' : 's'}`));
    const rest = [names.length ? `in ${names.join(', ')}` : null, state.tab === 'top' ? 'top rated' : `sorted by ${sortName}`].filter(Boolean).join(' · ');
    countLine.appendChild(document.createTextNode(` ${rest}`));
  }

  function renderItems(items) {
    grid.innerHTML = '';
    const skip = state.hideWatched ? excludeIds() : new Set();
    const shown = items.filter(item => !skip.has(item.tmdbId));
    empty.hidden = shown.length > 0;
    shown.forEach(item => {
      const card = buildCard(item);
      attachStandardActions(card, item, context);
      grid.appendChild(card);
    });
  }

  // Recommended comes from the local, seed-based pool (localApi.js): filtered, sorted and paged
  // here, since TMDB's discover filters don't apply to it.
  async function loadRecommended() {
    if (!recommendedPool) {
      const first = await fetchJson(`/api/recommendations/${mediaType}?page=1`);
      const rest = await Promise.all(Array.from({ length: Math.max(0, (first.totalPages || 1) - 1) }, (_, i) =>
        fetchJson(`/api/recommendations/${mediaType}?page=${i + 2}`).then(d => d.items || []).catch(() => [])));
      recommendedPool = [...(first.items || []), ...rest.flat()];
    }
    let items = recommendedPool.filter(item => {
      if (state.genres.length && !(item.genreIds || []).some(id => state.genres.includes(id))) return false;
      const year = Number(item.year);
      if (state.yearFrom && (!year || year < Number(state.yearFrom))) return false;
      if (state.yearTo && (!year || year > Number(state.yearTo))) return false;
      return true;
    });
    if (state.sort === 'rating') items = [...items].sort((a, b) => (b.voteAverage || 0) - (a.voteAverage || 0));
    if (state.sort === 'date') items = [...items].sort((a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || ''));
    if (state.sort === 'title') items = [...items].sort((a, b) => a.title.localeCompare(b.title));
    const totalPages = Math.max(1, Math.ceil(items.length / WEB_PAGE_SIZE));
    state.page = Math.min(state.page, totalPages);
    describe(items.length);
    renderItems(items.slice((state.page - 1) * WEB_PAGE_SIZE, state.page * WEB_PAGE_SIZE));
    if (!recommendedPool.length) {
      empty.hidden = false;
      empty.textContent = `Watch or save a few ${noun}s to get recommendations.`;
    }
    renderNumberedPagination(pager, state.page, totalPages, goTo);
  }

  let request = 0;
  async function load() {
    const mine = ++request;
    empty.textContent = 'Nothing matches these filters on this page. Try removing a genre.';
    empty.hidden = true;
    grid.innerHTML = '';
    renderSkeletonRow(grid, 12);
    try {
      if (state.tab === 'recommended') {
        await loadRecommended();
        return;
      }
      const params = new URLSearchParams(webDiscoverParams(state, mediaType));
      const data = await fetchJson(`/api/tmdb/discover/${mediaType}?${params}`);
      if (mine !== request) return;
      describe(data.total_results || 0);
      renderItems((data.results || []).map(raw => toStandardItem(raw, mediaType)));
      // TMDB stops serving discover results after page 500.
      renderNumberedPagination(pager, data.page || state.page, Math.min(data.total_pages || 1, 500), goTo);
    } catch (error) {
      if (mine !== request) return;
      console.error('Failed to load the browse grid:', error);
      grid.innerHTML = '';
      grid.appendChild(el('p', 'empty-note', "Couldn't load this page. Check your connection."));
    }
  }

  function goTo(page) {
    state.page = page;
    load();
    section.scrollIntoView({ block: 'start' });
  }

  fetchJson(`/api/tmdb/genre/${mediaType}/list`)
    .then(data => { genreList = data.genres || []; renderGenres(); })
    .catch(error => console.error('Failed to load genres:', error));
  renderTabs();
  load();
}
