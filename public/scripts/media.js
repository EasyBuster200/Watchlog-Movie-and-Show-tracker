// The shared component library: every page builds its UI from these DOM builders, so the
// look stays one design system (styles/style.css's tt-* classes, from docs/design). Page
// scripts only decide what data goes where.

const IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/w500';
const BACKDROP_BASE_URL = 'https://image.tmdb.org/t/p/w1280';
const PROFILE_BASE_URL = 'https://image.tmdb.org/t/p/w185';
const STILL_BASE_URL = 'https://image.tmdb.org/t/p/w300';
const THUMB_BASE_URL = 'https://image.tmdb.org/t/p/w154';

function posterUrl(posterPath) {
  return posterPath ? IMAGE_BASE_URL + posterPath : null;
}

function thumbUrl(posterPath) {
  return posterPath ? THUMB_BASE_URL + posterPath : null;
}

function backdropUrl(backdropPath) {
  return backdropPath ? BACKDROP_BASE_URL + backdropPath : null;
}

function profileUrl(profilePath) {
  return profilePath ? PROFILE_BASE_URL + profilePath : null;
}

function stillUrl(stillPath) {
  return stillPath ? STILL_BASE_URL + stillPath : null;
}

// The profile's region (Settings > Region, else guessed from the phone's locale), used to bias
// "Popular" rows toward content from there. See profiles.js's profileRegion.
function getUserRegion() {
  return profileRegion();
}

// Coming Soon (the Movies row and its see-all page): TMDB's upcoming movies for the profile's
// region that aren't out there yet. /movie/upcoming itself is mostly movies already released
// (its window starts weeks back), and dropping those page by page left pages of 1-3 movies. So
// this takes the window's end from /movie/upcoming and asks /discover/movie for the same
// theatrical releases (types 2|3) from tomorrow to then, in the region: every page is full.
let comingSoonEndPromise = null;
function fetchComingSoonPage(page) {
  const region = getUserRegion();
  if (!comingSoonEndPromise) {
    comingSoonEndPromise = fetchJson(`/api/tmdb/movie/upcoming?language=en-US&region=${region}&page=1`)
      .then(d => (d.dates && d.dates.maximum) || null)
      .catch(() => null);
  }
  return comingSoonEndPromise.then(end => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const latest = new Date();
    latest.setDate(latest.getDate() + 35);
    const params = new URLSearchParams({
      language: 'en-US',
      region,
      with_release_type: '2|3',
      'release_date.gte': localDateString(tomorrow),
      'release_date.lte': end || localDateString(latest),
      sort_by: 'popularity.desc',
      page: String(page),
    });
    return fetchJson(`/api/tmdb/discover/movie?${params}`);
  });
}

function detailUrl(item) {
  return `detail.html?type=${item.mediaType}&id=${item.tmdbId}`;
}

function personUrl(item) {
  return `person.html?id=${item.tmdbId}`;
}

// ---------- Icons ----------

// Line icons from the design system (24x24, stroked). `filled` fills the shape, used for a
// toggle that's on.
const TT_ICON_PATHS = {
  home: ['M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5.5v-6h-5v6H4a1 1 0 0 1-1-1z'],
  bookmark: ['M6 3.5h12v17l-6-4.5-6 4.5z'],
  folder: ['M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z'],
  film: ['M4.5 3.5h15v17h-15z', 'M8.5 3.5v17', 'M15.5 3.5v17', 'M4.5 8h4', 'M4.5 16h4', 'M15.5 8h4', 'M15.5 16h4'],
  tv: ['M3 7.5h18v12H3z', 'M8 3l4 4.5L16 3'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4.5 20.5a7.5 7.5 0 0 1 15 0'],
  eye: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  heart: ['M12 20s-7.5-4.6-9.2-9.4A4.6 4.6 0 0 1 12 7.2a4.6 4.6 0 0 1 9.2 3.4C19.5 15.4 12 20 12 20z'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20.5 20.5l-4.5-4.5'],
  back: ['M19 12H5', 'M11 6l-6 6 6 6'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  star: ['M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z'],
  chevron: ['M9 6l6 6-6 6'],
  'chevron-left': ['M15 6l-6 6 6 6'],
  play: ['M7 4.5v15l12-7.5z'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  plus: ['M12 5v14', 'M5 12h14'],
  more: ['M10.5 12a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0z', 'M3.5 12a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0z', 'M17.5 12a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0z'],
  cloud: ['M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.1 4.75 4.75 0 0 0 7 18.5z', 'M9.5 13.5l2 2 3.5-3.5'],
  sliders: ['M4 7h10', 'M18 7h2', 'M16 5v4', 'M4 17h4', 'M12 17h8', 'M10 15v4'],
  sort: ['M7 4v16', 'M3.5 7.5L7 4l3.5 3.5', 'M17 20V4', 'M13.5 16.5L17 20l3.5-3.5'],
  down: ['M6 9l6 6 6-6'],
  eyeoff: ['M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M4 4l16 16'],
  mail: ['M3.5 6h17v12h-17z', 'M3.5 7l8.5 6.5L20.5 7'],
  lock: ['M5.5 11h13v9.5h-13z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
  // Not in the design system's set; drawn in its style for "Copy" (two overlapping sheets).
  copy: ['M9 9h11v11H9z', 'M15 9V4H4v11h5'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  bell: ['M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z', 'M10 20.5a2 2 0 0 0 4 0'],
  shield: ['M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z'],
  calendar: ['M4 6.5h16v14H4z', 'M4 10.5h16', 'M8 3.5v4', 'M16 3.5v4'],
};

function ttIcon(name, { size = 24, filled = false, strokeWidth = 1.8 } = {}) {
  const paths = (TT_ICON_PATHS[name] || []).map((d, i) => {
    // A filled eye keeps a visible pupil: the inner circle is cut out in the page colour.
    const cut = filled && name === 'eye' && i === 1;
    return `<path d="${d}"${cut ? ' fill="var(--bg-page)" stroke="var(--bg-page)"' : ''}></path>`;
  }).join('');
  return `<svg class="tt-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

// The TMDB star next to a title's rating.
function ratingStarSvg(size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="var(--rating)" stroke="var(--rating)" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="${TT_ICON_PATHS.star[0]}"></path></svg>`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ---------- Bottom nav ----------

const NAV_ITEMS = [
  { id: 'home', icon: 'home', label: 'Home', href: 'main.html' },
  { id: 'watchlist', icon: 'bookmark', label: 'Watchlist', href: 'bookmarks.html' },
  { id: 'lists', icon: 'folder', label: 'Lists', href: 'lists.html' },
  { id: 'movies', icon: 'film', label: 'Movies', href: 'movies.html' },
  { id: 'shows', icon: 'tv', label: 'Shows', href: 'shows.html' },
  { id: 'profile', icon: 'user', label: 'Profile', href: 'profile.html' },
];

// The Android app always keeps the phone layout, even on a large tablet: style.css's laptop
// rules only apply without this class. (Capacitor's bridge is there before any page script.)
function markNativeApp() {
  const native = Boolean(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  document.documentElement.classList.toggle('is-native', native);
}

// The design's SideNav, which replaces the bottom bar on laptops (style.css shows one or the
// other): the wordmark, a search field (Enter opens the search page), the six sections with
// labels, and the profile with a settings button at the foot. Built next to the bottom nav by
// renderBottomNav, so the two always agree on the active section.
function renderSideNav(active) {
  let side = document.querySelector('nav.tt-sidenav');
  if (!side) {
    side = el('nav', 'tt-sidenav');
    side.setAttribute('aria-label', 'Main');
    document.body.insertBefore(side, document.body.firstChild);
    document.body.classList.add('has-sidenav');
  }
  side.innerHTML = '';

  const brand = el('a', 'tt-sidenav__brand');
  brand.href = 'main.html';
  const mark = el('span', 'tt-sidenav__mark');
  mark.innerHTML = ttIcon('play', { size: 14, filled: true });
  brand.appendChild(mark);
  brand.appendChild(document.createTextNode('Watchlog'));
  side.appendChild(brand);

  const form = el('form', 'tt-sidenav__search');
  form.setAttribute('role', 'search');
  const field = el('label', 'tt-search');
  field.innerHTML = ttIcon('search', { size: 18 });
  field.appendChild(el('span', 'tt-sr', 'Search'));
  const input = document.createElement('input');
  input.type = 'search';
  input.placeholder = 'Search movies and shows…';
  input.autocomplete = 'off';
  input.enterKeyHint = 'search';
  const current = new URLSearchParams(window.location.search).get('q');
  if (current && /search(\.html)?$/.test(window.location.pathname)) input.value = current;
  field.appendChild(input);
  form.appendChild(field);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const q = input.value.trim();
    if (q) window.location.href = `search.html?q=${encodeURIComponent(q)}`;
  });
  side.appendChild(form);

  const items = el('div', 'tt-sidenav__items');
  NAV_ITEMS.forEach(item => {
    const on = item.id === active;
    const link = el('a', `tt-sidenav__item${on ? ' tt-sidenav__item--on' : ''}`);
    link.href = item.href;
    if (on) link.setAttribute('aria-current', 'page');
    link.innerHTML = ttIcon(item.icon, { size: 20, strokeWidth: on ? 2 : 1.8 });
    link.appendChild(document.createTextNode(item.label));
    items.appendChild(link);
  });
  side.appendChild(items);

  const profile = typeof getActiveProfile === 'function' ? getActiveProfile() : null;
  if (profile) {
    const foot = el('div', 'tt-sidenav__foot');
    const me = el('a', 'tt-sidenav__me');
    me.href = 'profile.html';
    me.appendChild(el('span', 'tt-sidenav__avatar', profile.displayName.trim().charAt(0).toUpperCase()));
    me.appendChild(el('span', 'tt-sidenav__name', profile.displayName));
    foot.appendChild(me);
    const settings = el('a', 'tt-btn tt-btn--ghost tt-btn--icon tt-sidenav__settings');
    settings.href = 'settings.html';
    settings.setAttribute('aria-label', 'Settings');
    settings.innerHTML = ttIcon('more', { size: 20 });
    foot.appendChild(settings);
    side.appendChild(foot);
  }
}

// Every page has an empty <nav class="tt-nav" data-active="..."> - filled in here so the six
// icons are defined once. It also (re)builds the laptop sidebar to match.
function renderBottomNav(nav) {
  const active = nav.dataset.active;
  renderSideNav(active);
  nav.setAttribute('aria-label', 'Main');
  nav.innerHTML = '';
  NAV_ITEMS.forEach(item => {
    const on = item.id === active;
    const link = el('a', `tt-nav__item${on ? ' tt-nav__item--on' : ''}`);
    link.href = item.href;
    link.setAttribute('aria-label', item.label);
    if (on) link.setAttribute('aria-current', 'page');
    link.innerHTML = ttIcon(item.icon, { size: 24, strokeWidth: on ? 2 : 1.8 });
    nav.appendChild(link);
  });
}

// A back button (any element with data-back="<fallback page>"): history back, or the
// fallback when there's no history (opened from a notification, say). The fallback is read on
// click, so a page script can point it somewhere more specific once it knows.
function initBackButton(button) {
  if (!button) return;
  button.addEventListener('click', () => {
    if (window.history.length > 1) window.history.back();
    else window.location.href = button.dataset.back || 'main.html';
  });
}

document.addEventListener('DOMContentLoaded', () => {
  markNativeApp();
  document.querySelectorAll('nav.tt-nav[data-active]').forEach(renderBottomNav);
  document.querySelectorAll('[data-back]').forEach(initBackButton);
});

// ---------- Small building blocks ----------

function titleInitials(title) {
  return String(title || '')
    .split(/\s+/)
    .filter(word => /[A-Za-z0-9]/.test(word.charAt(0)))
    .slice(0, 2)
    .map(word => word.charAt(0).toUpperCase())
    .join('');
}

// Poster art: the image, or the title's initials on a plain tile when there's no poster.
function buildPosterArt(title, imageSrc, { lazy = true } = {}) {
  const art = el('div', 'tt-poster__art');
  if (imageSrc) {
    const img = document.createElement('img');
    img.src = imageSrc;
    img.alt = `${title} poster`;
    if (lazy) img.loading = 'lazy';
    art.appendChild(img);
  } else {
    const ph = el('div', 'tt-poster__ph', titleInitials(title));
    ph.setAttribute('aria-hidden', 'true');
    art.appendChild(ph);
  }
  return art;
}

function buildProgressBar(value, max, label = 'Progress') {
  const bar = el('div', 'tt-progress');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-label', label);
  const fill = el('div', 'tt-progress__fill');
  bar.appendChild(fill);
  bar.setProgress = (v, m) => {
    const pct = m > 0 ? Math.max(0, Math.min(100, (v / m) * 100)) : 0;
    fill.style.width = `${pct}%`;
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', String(m || 0));
    bar.setAttribute('aria-valuenow', String(v || 0));
  };
  bar.setProgress(value, max);
  return bar;
}

function buildChip(label, { selected = false, count = null, check = false, onClick } = {}) {
  const chip = el('button', `tt-chip${selected ? ' tt-chip--on' : ''}`);
  chip.type = 'button';
  chip.setAttribute('aria-pressed', selected ? 'true' : 'false');
  if (check && selected) chip.insertAdjacentHTML('beforeend', ttIcon('check', { size: 16, strokeWidth: 2.2 }));
  chip.appendChild(document.createTextNode(label));
  if (count != null) chip.appendChild(el('span', 'tt-chip__count', String(count)));
  if (onClick) chip.addEventListener('click', onClick);
  return chip;
}

// The design's TextField: a label (with an optional element on its right, e.g. a link), a 48px
// box with an optional leading icon, and a helper or error line. type 'password' adds a
// show/hide button. Returns the wrapper; `.input` is the <input>, `.setError(msg)` shows an
// error (null clears it).
let ttFieldCount = 0;
function buildTextField({ label, type = 'text', placeholder = '', value = '', icon = null, helper = '', aside = null, autocomplete = null, name = null, required = false, maxLength = null, inputMode = null } = {}) {
  ttFieldCount += 1;
  const id = `tt-field-${ttFieldCount}`;
  const field = el('div', 'tt-field');
  const top = el('div', 'tt-field__top');
  const labelEl = el('label', 'tt-field__label', label);
  labelEl.htmlFor = id;
  top.appendChild(labelEl);
  if (aside) top.appendChild(aside);
  field.appendChild(top);

  const box = el('div', 'tt-field__box');
  if (icon) box.insertAdjacentHTML('beforeend', ttIcon(icon, { size: 18 }));
  const input = document.createElement('input');
  input.id = id;
  input.type = type;
  input.placeholder = placeholder;
  input.value = value;
  input.required = required;
  if (autocomplete) input.autocomplete = autocomplete;
  if (name) input.name = name;
  if (maxLength) input.maxLength = maxLength;
  if (inputMode) input.inputMode = inputMode;
  box.appendChild(input);
  if (type === 'password') {
    const reveal = el('button', 'tt-field__reveal');
    reveal.type = 'button';
    const sync = shown => {
      input.type = shown ? 'text' : 'password';
      reveal.setAttribute('aria-pressed', shown ? 'true' : 'false');
      reveal.setAttribute('aria-label', `${shown ? 'Hide' : 'Show'} ${label.toLowerCase()}`);
      reveal.innerHTML = ttIcon(shown ? 'eyeoff' : 'eye', { size: 18 });
    };
    reveal.addEventListener('click', () => sync(input.type === 'password'));
    sync(false);
    box.appendChild(reveal);
  }
  field.appendChild(box);

  const hint = el('span', 'tt-field__hint', helper);
  hint.id = `${id}-hint`;
  hint.hidden = !helper;
  field.appendChild(hint);
  input.setAttribute('aria-describedby', hint.id);

  field.input = input;
  field.setError = message => {
    field.classList.toggle('tt-field--error', !!message);
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    hint.textContent = message || helper;
    hint.hidden = !message && !helper;
  };
  return field;
}

// The design's BrowseHeader: an optional title, a one-line summary of what's applied, a sort
// icon (a small menu that applies at once) and a filter icon (a bottom sheet with segmented
// choices for `single` sections - the first option means "no filter" - and a two-column
// checklist for `multi` ones, applied with "Show results"; a dot marks active filters).
// Options are { id, label, summary? } (label may carry a count, e.g. "Shows 12"; summary is the
// text used in the summary line). onChange({ sort, values }) fires when the sort changes or the
// sheet is applied. Returns { el, update(next), state }: update() takes any of title /
// sortOptions / sort / sections / values / summary, e.g. once genres have loaded.
function createBrowseHeader({ title = null, level = 2, sortOptions = [], sort = null, sections = [], values = {}, summary = null, onChange } = {}) {
  const st = { title, level, sortOptions, sections, summary, sort: sort || (sortOptions[0] && sortOptions[0].id), values: {}, open: null, draft: null };
  const defaultFor = sec => (sec.kind === 'multi' ? [] : sec.options[0] && sec.options[0].id);
  const isActive = (sec, v) => (sec.kind === 'multi' ? (v || []).length > 0 : v != null && v !== defaultFor(sec));
  const labelOf = (sec, id) => {
    const o = sec.options.find(x => x.id === id);
    return o ? (o.summary || o.label) : String(id);
  };
  const setValues = vals => {
    st.values = {};
    st.sections.forEach(sec => { st.values[sec.id] = vals[sec.id] != null ? vals[sec.id] : defaultFor(sec); });
  };
  setValues(values);

  const root = el('div', 'tt-bh');
  // The sheet is drawn into its own layer on <body>: inside a sticky header it would be trapped
  // in the header's stacking context, under the bottom nav.
  const layer = el('div', 'tt-bh-layer');
  const emit = () => { if (onChange) onChange({ sort: st.sort, values: { ...st.values } }); };
  const checkMark = () => `<span class="tt-menu__check">${ttIcon('check', { size: 16, strokeWidth: 2.4 })}</span>`;

  function outside(event) {
    const actions = root.querySelector('.tt-bh__actions');
    if (st.open === 'sort' && actions && !actions.contains(event.target)) close();
  }
  function close() {
    st.open = null;
    document.removeEventListener('click', outside, true);
    document.body.classList.remove('sheet-open');
    layer.remove();
    render();
  }

  function renderSheet() {
    const scrim = el('div', 'tt-scrim');
    scrim.addEventListener('click', close);
    const sheet = el('div', 'tt-sheet tt-sheet--bottom');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', 'Filters');
    sheet.appendChild(el('span', 'tt-sheet__handle'));
    const head = el('div', 'tt-sheet__head');
    head.appendChild(el('span', 'tt-sheet__title', 'Filters'));
    const clear = el('button', 'tt-link', 'Clear all');
    clear.type = 'button';
    clear.addEventListener('click', () => {
      st.sections.forEach(sec => { st.draft[sec.id] = defaultFor(sec); });
      render();
    });
    head.appendChild(clear);
    sheet.appendChild(head);

    const body = el('div', 'tt-sheet__body');
    st.sections.forEach(sec => {
      const v = st.draft[sec.id];
      const section = el('div', 'tt-sheet__section');
      section.appendChild(el('span', 'tt-filter-label', sec.label));
      const multi = sec.kind === 'multi';
      const group = el('div', multi ? 'tt-sheet__checks' : 'tt-seg');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', sec.label);
      sec.options.forEach(o => {
        const on = multi ? (v || []).includes(o.id) : v === o.id;
        const cls = multi ? `tt-menu__item${on ? ' tt-menu__item--on' : ''}` : `tt-seg__item${on ? ' tt-seg__item--on' : ''}`;
        const b = el('button', cls, o.label);
        b.type = 'button';
        if (multi) {
          b.setAttribute('role', 'checkbox');
          b.setAttribute('aria-checked', on ? 'true' : 'false');
          b.insertAdjacentHTML('beforeend', checkMark());
        } else {
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        b.addEventListener('click', () => {
          st.draft[sec.id] = multi ? (on ? v.filter(x => x !== o.id) : [...(v || []), o.id]) : o.id;
          render();
        });
        group.appendChild(b);
      });
      section.appendChild(group);
      body.appendChild(section);
    });
    sheet.appendChild(body);

    const apply = el('button', 'tt-btn tt-btn--primary', 'Show results');
    apply.type = 'button';
    apply.addEventListener('click', () => {
      st.values = { ...st.draft };
      close();
      emit();
    });
    sheet.appendChild(apply);
    return [scrim, sheet];
  }

  function render() {
    const scroll = layer.querySelector('.tt-sheet__body');
    const scrollTop = scroll ? scroll.scrollTop : 0;
    root.innerHTML = '';
    const row = el('div', 'tt-bh__row');
    const text = el('div', 'tt-bh__text');
    if (st.title) text.appendChild(el(st.level === 1 ? 'h1' : 'h2', 'tt-bh__title', st.title));
    const parts = [];
    const sortOpt = st.sortOptions.find(o => o.id === st.sort);
    if (sortOpt) parts.push(sortOpt.summary || sortOpt.label);
    st.sections.forEach(sec => {
      const v = st.values[sec.id];
      if (sec.kind === 'multi') { if ((v || []).length) parts.push(v.map(id => labelOf(sec, id)).join(', ')); }
      else if (isActive(sec, v)) parts.push(labelOf(sec, v));
    });
    // With no sort and nothing filtered, name the default choice ("All") rather than nothing.
    if (!parts.length && st.sections[0]) parts.push(labelOf(st.sections[0], st.values[st.sections[0].id]));
    text.appendChild(el('span', 'tt-bh__summary', st.summary || parts.join(' · ')));
    row.appendChild(text);

    const actions = el('div', 'tt-bh__actions');
    if (st.sortOptions.length) {
      const sortBtn = el('button', `tt-iconbtn${st.open === 'sort' ? ' tt-iconbtn--open' : ''}`);
      sortBtn.type = 'button';
      sortBtn.setAttribute('aria-label', `Sort: ${sortOpt ? sortOpt.label : ''}`);
      sortBtn.setAttribute('aria-haspopup', 'menu');
      sortBtn.setAttribute('aria-expanded', st.open === 'sort' ? 'true' : 'false');
      sortBtn.innerHTML = ttIcon('sort', { size: 18 });
      sortBtn.addEventListener('click', () => {
        if (st.open === 'sort') { close(); return; }
        st.open = 'sort';
        render();
        document.addEventListener('click', outside, true);
      });
      actions.appendChild(sortBtn);
    }
    const activeCount = st.sections.reduce((n, sec) => {
      const v = st.values[sec.id];
      return n + (sec.kind === 'multi' ? (v || []).length : (isActive(sec, v) ? 1 : 0));
    }, 0);
    if (st.sections.length) {
      const filterBtn = el('button', 'tt-iconbtn');
      filterBtn.type = 'button';
      filterBtn.setAttribute('aria-label', activeCount ? `Filters, ${activeCount} active` : 'Filters');
      filterBtn.setAttribute('aria-haspopup', 'dialog');
      filterBtn.setAttribute('aria-expanded', st.open === 'sheet' ? 'true' : 'false');
      filterBtn.innerHTML = ttIcon('sliders', { size: 18 });
      if (activeCount) filterBtn.appendChild(el('span', 'tt-iconbtn__dot'));
      filterBtn.addEventListener('click', () => {
        st.draft = JSON.parse(JSON.stringify(st.values));
        st.open = 'sheet';
        document.body.classList.add('sheet-open');
        render();
      });
      actions.appendChild(filterBtn);
    }
    if (st.open === 'sort') {
      const menu = el('div', 'tt-menu');
      menu.setAttribute('role', 'menu');
      st.sortOptions.forEach(o => {
        const on = o.id === st.sort;
        const item = el('button', `tt-menu__item${on ? ' tt-menu__item--on' : ''}`, o.label);
        item.type = 'button';
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', on ? 'true' : 'false');
        item.insertAdjacentHTML('beforeend', checkMark());
        item.addEventListener('click', () => {
          st.sort = o.id;
          close();
          emit();
        });
        menu.appendChild(item);
      });
      actions.appendChild(menu);
    }
    row.appendChild(actions);
    root.appendChild(row);
    layer.innerHTML = '';
    if (st.open === 'sheet') {
      renderSheet().forEach(n => layer.appendChild(n));
      if (!layer.isConnected) document.body.appendChild(layer);
      const body = layer.querySelector('.tt-sheet__body');
      if (body) body.scrollTop = scrollTop;
    }
  }

  render();
  return {
    el: root,
    update(next = {}) {
      ['title', 'sortOptions', 'summary'].forEach(k => { if (k in next) st[k] = next[k]; });
      if ('sort' in next) st.sort = next.sort;
      if ('sections' in next) {
        st.sections = next.sections;
        setValues(next.values || st.values);
      } else if ('values' in next) {
        setValues(next.values);
      }
      if (st.draft) st.sections.forEach(sec => { if (!(sec.id in st.draft)) st.draft[sec.id] = defaultFor(sec); });
      render();
    },
    get state() { return { sort: st.sort, values: { ...st.values } }; },
  };
}

// A compact row: thumbnail, title, meta line, optional progress. Used for search results and
// Continue Watching. `round` makes the image a circle (people).
function buildMediaRow({ href, title, meta, imageSrc, round = false, progress = null, onClick }) {
  const row = el(href ? 'a' : 'button', 'tt-media');
  if (href) row.href = href;
  else row.type = 'button';
  if (onClick) row.addEventListener('click', onClick);

  const art = buildPosterArt(title, imageSrc);
  if (round) art.classList.add('tt-media__photo');
  row.appendChild(art);

  const body = el('span', 'tt-media__body');
  body.appendChild(el('span', 'tt-media__title', title));
  if (meta) body.appendChild(el('span', 'tt-media__meta', meta));
  if (progress && progress.total > 0) {
    body.appendChild(buildProgressBar(progress.watched, progress.total, `${title} progress`));
    body.appendChild(el('span', 'tt-media__meta', `${progress.watched}/${progress.total} episodes watched`));
  }
  row.bodyEl = body;
  row.appendChild(body);
  return row;
}

function parseLocalDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// "Tonight", "Tomorrow", "In 3 days" - relative to today, for an episode's air date.
function daysUntil(dateStr) {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((parseLocalDate(dateStr) - start) / 86400000);
}

function relativeAirLabel(dateStr) {
  const days = daysUntil(dateStr);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  return `In ${days} days`;
}

// "Just now", "5 min ago", "3 h ago", "Yesterday", "4 days ago", then the date: for past events
// (friends' activity).
function timeAgo(iso) {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return '';
  const minutes = Math.round((Date.now() - then.getTime()) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.ceil((startOfToday - then) / 86400000);
  if (days <= 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// A round avatar with a friend's initials (friends.js, friend.js, the detail page's friends).
function buildFriendAvatar(name, className = 'friend-row__avatar') {
  const initials = String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
  return el('span', className, initials);
}

function episodeCode(seasonNumber, episodeNumber, name) {
  const hasRealName = name && !/^Episode\s+\d+$/i.test(name.trim());
  return `S${seasonNumber} · E${episodeNumber}${hasRealName ? ` · ${name}` : ''}`;
}

// One upcoming episode: a date tile, the show, the episode, and when it airs.
function buildAiringRow({ href, title, airDate, seasonNumber, episodeNumber, episodeName }) {
  const row = el(href ? 'a' : 'div', 'tt-airing');
  if (href) row.href = href;
  const date = parseLocalDate(airDate);

  const tile = el('span', 'tt-airing__date');
  tile.setAttribute('aria-hidden', 'true');
  // Just "TODAY" on the day itself; the weekday ("WED 6") within the next 7 days, where it can't
  // be mistaken for another week; and the month ("JAN 6") further out.
  const days = daysUntil(airDate);
  if (days <= 0) {
    tile.classList.add('tt-airing__date--today');
    tile.appendChild(el('span', 'tt-airing__dow', 'Today'));
  } else {
    tile.appendChild(el('span', 'tt-airing__dow', date.toLocaleDateString(undefined, days < 7 ? { weekday: 'short' } : { month: 'short' })));
    tile.appendChild(el('span', 'tt-airing__num', String(date.getDate())));
  }
  row.appendChild(tile);

  const body = el('span', 'tt-airing__body');
  body.appendChild(el('span', 'tt-airing__title', title));
  body.appendChild(el('span', 'tt-airing__ep', episodeCode(seasonNumber, episodeNumber, episodeName)));
  row.appendChild(body);

  const label = relativeAirLabel(airDate);
  const when = el('span', `tt-airing__when${label === 'Today' || label === 'Tomorrow' ? ' tt-airing__when--soon' : ''}`);
  when.appendChild(el('span', 'tt-sr', `${date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}, `));
  when.appendChild(document.createTextNode(label));
  row.appendChild(when);
  row.dataset.date = airDate;
  return row;
}

function buildCastCard({ tmdbId, name, role, profilePath }) {
  const card = el('a', 'tt-cast');
  card.href = personUrl({ tmdbId });
  const photo = el('div', 'tt-cast__photo');
  if (profilePath) {
    const img = document.createElement('img');
    img.src = profileUrl(profilePath);
    img.alt = name;
    img.loading = 'lazy';
    photo.appendChild(img);
  } else {
    const span = el('span', null, titleInitials(name));
    span.setAttribute('aria-hidden', 'true');
    photo.appendChild(span);
  }
  card.appendChild(photo);
  card.appendChild(el('span', 'tt-cast__name', name));
  if (role) card.appendChild(el('span', 'tt-cast__role', role));
  return card;
}

// The design system's on/off switch. `onChange(on)` runs after it flips; `setOn(on)` sets it.
function buildSwitch(label, on, onChange) {
  const btn = el('button', 'tt-switch');
  btn.type = 'button';
  btn.setAttribute('role', 'switch');
  btn.setAttribute('aria-label', label);
  btn.appendChild(el('span', 'tt-switch__knob'));
  btn.setOn = value => {
    btn.classList.toggle('tt-switch--on', value);
    btn.setAttribute('aria-checked', value ? 'true' : 'false');
  };
  btn.setOn(on);
  btn.addEventListener('click', () => {
    const next = btn.getAttribute('aria-checked') !== 'true';
    btn.setOn(next);
    if (onChange) onChange(next);
  });
  return btn;
}

function buildStatTile(value, label, { wide = false } = {}) {
  const tile = el('div', `tt-stat${wide ? ' tt-stat--wide' : ''}`);
  tile.appendChild(el('span', 'tt-stat__value', String(value)));
  tile.appendChild(el('span', 'tt-stat__label', label));
  return tile;
}

// ---------- Pagination ----------

// Prev / "Page X of Y" / Next, shared by every page with a paginated grid (browse grids,
// search, filmography, see-all feeds). Always three elements, so it fits a phone-width line.
function renderPagination(container, currentPage, totalPages, onPageChange) {
  container.innerHTML = '';
  container.classList.add('pager');
  if (!totalPages || totalPages <= 1) return;
  container.setAttribute('aria-label', 'Pages');

  function pageButton(icon, label, page, disabled) {
    const btn = el('button', 'pager__btn');
    btn.type = 'button';
    btn.setAttribute('aria-label', label);
    btn.innerHTML = ttIcon(icon, { size: 18, strokeWidth: 2 });
    btn.disabled = disabled;
    if (!disabled) btn.addEventListener('click', () => {
      onPageChange(page);
      container.closest('section, .page-body, main')?.scrollIntoView({ block: 'start' });
    });
    return btn;
  }

  container.appendChild(pageButton('chevron-left', 'Previous page', currentPage - 1, currentPage <= 1));
  const label = el('span', 'pager__label');
  label.innerHTML = `Page <strong>${currentPage}</strong> of ${totalPages}`;
  container.appendChild(label);
  container.appendChild(pageButton('chevron', 'Next page', currentPage + 1, currentPage >= totalPages));
}

// ---------- Skeletons ----------

const SKELETON_ROW_COUNT = 6;

// A placeholder shaped like a real poster card, shown while a row or grid waits on a fetch.
function buildSkeletonCard() {
  const card = el('div', 'tt-poster skeleton');
  card.setAttribute('aria-hidden', 'true');
  card.appendChild(el('div', 'tt-poster__art skeleton-shimmer'));
  card.appendChild(el('div', 'skeleton-line short skeleton-shimmer'));
  card.appendChild(el('div', 'skeleton-line skeleton-shimmer'));
  return card;
}

function renderSkeletonRow(container, count = SKELETON_ROW_COUNT) {
  for (let i = 0; i < count; i++) container.appendChild(buildSkeletonCard());
}

// A watched show as a row: poster, title with its status pill (Watching / Caught up / ...),
// and a progress bar through its aired episodes. The watched shows page lists these.
const SHOW_STATUS_LABELS = {
  watching: 'Watching',
  caught_up: 'Caught up',
  completed: 'Completed',
  dropped: 'Dropped',
  unknown: 'Unknown',
};
function buildShowProgressRow(show) {
  const aired = show.airedCount || 0;
  const watchedAired = aired - (show.unwatchedCount || 0);
  const row = buildMediaRow({
    href: detailUrl(show),
    title: show.title,
    imageSrc: thumbUrl(show.posterPath),
  });
  const titleEl = row.bodyEl.querySelector('.tt-media__title');
  const head = el('span', 'tt-media__head');
  titleEl.replaceWith(head);
  head.appendChild(titleEl);
  if (show.status) head.appendChild(el('span', `status-pill status-${show.status}`, SHOW_STATUS_LABELS[show.status] || show.status));
  row.bodyEl.appendChild(buildProgressBar(watchedAired, aired, `${show.title} progress`));
  row.bodyEl.appendChild(el('span', 'tt-media__meta', `${watchedAired}/${aired} aired episodes`));
  return row;
}

function buildSkeletonMediaRow() {
  const row = el('div', 'tt-media skeleton');
  row.setAttribute('aria-hidden', 'true');
  const art = el('div', 'tt-poster__art skeleton-shimmer');
  row.appendChild(art);
  const body = el('div', 'tt-media__body');
  body.appendChild(el('div', 'skeleton-line skeleton-shimmer'));
  body.appendChild(el('div', 'skeleton-line short skeleton-shimmer'));
  row.appendChild(body);
  return row;
}

// ---------- Poster rows fed by TMDB pages ----------

// Fills a horizontal poster row from a paginated feed. `fetchPage(page)` resolves to
// { results, total_pages }; `renderItem(raw)` returns a card or falsy to skip it. A filter that
// skips many results (Coming Soon drops already-released titles) would leave the row sparse,
// so this keeps pulling pages until it has `target` cards or runs out.
async function loadPosterRow(container, fetchPage, renderItem, { target = 20, maxPages = 10, emptyText = 'Nothing here yet.' } = {}) {
  container.innerHTML = '';
  renderSkeletonRow(container);
  const cards = [];
  try {
    for (let page = 1; page <= maxPages && cards.length < target; page++) {
      const data = await fetchPage(page);
      (data.results || []).forEach(raw => {
        const card = renderItem(raw);
        if (card) cards.push(card);
      });
      if (page >= (data.total_pages || page)) break;
    }
    container.innerHTML = '';
    if (cards.length === 0) {
      container.appendChild(el('p', 'empty-note', emptyText));
      return 0;
    }
    cards.slice(0, target).forEach(card => container.appendChild(card));
    return cards.length;
  } catch (error) {
    console.error('Failed to load row:', error);
    container.innerHTML = '';
    container.appendChild(el('p', 'empty-note', "Couldn't load this. Check your connection."));
    return 0;
  }
}

// With a non-English language (Settings > Language), TMDB leaves a text field empty when it has
// no translation. Pages that ask for `append_to_response=translations` fall back to the English
// text with this. `withTranslations()` gives the append_to_response entry, or '' for English.
function withTranslations() {
  return profileLanguage() === DEFAULT_TMDB_LANGUAGE ? '' : 'translations';
}

function textOrEnglish(data, field) {
  if (data && data[field]) return data[field];
  const translations = (data && data.translations && data.translations.translations) || [];
  const english = translations.find(t => t.iso_639_1 === 'en' && t.iso_3166_1 === 'US')
    || translations.find(t => t.iso_639_1 === 'en');
  return (english && english.data && english.data[field]) || '';
}

function fetchJson(url) {
  return fetch(url, { credentials: 'same-origin' }).then(r => {
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return r.json();
  });
}

// ---------- Search result rows ----------

// Normalizes a raw TMDB person search/credit result. Deliberately not the standard item
// shape: a person has no release date or rating, and its image is a profile photo.
function normalizeTmdbPerson(raw) {
  return {
    tmdbId: raw.id,
    mediaType: 'person',
    name: raw.name || 'Unknown',
    profilePath: raw.profile_path,
    knownForDepartment: raw.known_for_department || null,
  };
}

function mediaTypeLabel(mediaType) {
  if (mediaType === 'tv') return 'Show';
  if (mediaType === 'movie') return 'Movie';
  return 'Person';
}

// "Show • 2026 • 8.1/10" for a movie/show, "Person • Acting" for a person.
function searchResultMeta(item) {
  if (item.mediaType === 'person') return ['Person', item.knownForDepartment].filter(Boolean).join(' • ');
  return [mediaTypeLabel(item.mediaType), item.year, ratingLabel(item)].filter(Boolean).join(' • ');
}

function buildSearchResultRow(item, onSelect) {
  const isPerson = item.mediaType === 'person';
  return buildMediaRow({
    href: onSelect ? null : (isPerson ? personUrl(item) : detailUrl(item)),
    title: isPerson ? item.name : item.title,
    meta: searchResultMeta(item),
    imageSrc: isPerson ? profileUrl(item.profilePath) : thumbUrl(item.posterPath),
    round: isPerson,
    onClick: onSelect ? () => onSelect(item) : null,
  });
}

// Renders TMDB search-multi results into `resultsEl` as media rows - the typeahead dropdown
// (search.js) and the add-to-list dialog. `onSelect(item)`, if given, replaces navigation.
function renderSearchResultRows(resultsEl, rawResults, onSelect, { includePersons = false, limit = 8 } = {}) {
  const items = rawResults
    .filter(r => r.media_type === 'movie' || r.media_type === 'tv' || (includePersons && r.media_type === 'person'))
    .slice(0, limit)
    .map(r => (r.media_type === 'person' ? normalizeTmdbPerson(r) : toStandardItem(r)));

  resultsEl.innerHTML = '';
  if (items.length === 0) {
    resultsEl.appendChild(el('p', 'search-empty', 'No matches. Try a shorter word, or check the spelling.'));
    return;
  }
  items.forEach(item => resultsEl.appendChild(buildSearchResultRow(item, onSelect)));
}

// ---------- Poster card ----------

// "8.4/10", "Not rated", or "Coming soon" for something unreleased.
function ratingLabel(item) {
  if (isUnreleased(item.releaseDate)) return 'Coming soon';
  const rating = Number(item.voteAverage);
  if (!rating) return 'Not rated';
  return `${rating.toFixed(1)}/10`;
}

function formatRating(voteAverage) {
  if (voteAverage === null || voteAverage === undefined) return 'N/A';
  return Number(voteAverage).toFixed(1);
}

function cardMeta(item) {
  return [item.year, ratingLabel(item)].filter(Boolean).join(' • ');
}

// The poster card used everywhere a movie/show is listed: art with the action toggles on it,
// then a meta line and the title. `card.overlayActionsEl` is where toggles go;
// `card.infoEl` takes extra lines under the title (e.g. "3/10 episodes watched").
function buildCard(item) {
  const card = el('div', 'tt-poster');
  const art = buildPosterArt(item.title, posterUrl(item.posterPath));
  card.appendChild(art);
  card.appendChild(el('span', 'tt-poster__meta', cardMeta(item)));
  card.appendChild(el('span', 'tt-poster__title', item.title));

  card.overlayActionsEl = art;
  card.infoEl = card;
  card.addEventListener('click', () => {
    window.location.href = detailUrl(item);
  });
  return card;
}

function addCardDetail(card, text) {
  card.infoEl.appendChild(el('span', 'tt-poster__meta', text));
}

// A person's card (filmography-style grids, top actors): profile photo, department.
function buildPersonCard(person) {
  const card = el('div', 'tt-poster');
  card.appendChild(buildPosterArt(person.name, profileUrl(person.profilePath)));
  card.appendChild(el('span', 'tt-poster__meta', person.knownForDepartment || 'Person'));
  card.appendChild(el('span', 'tt-poster__title', person.name));
  card.addEventListener('click', () => {
    window.location.href = personUrl(person);
  });
  return card;
}

// A round toggle on poster art. `pos` is the corner (tr/tl/bl/br); `render(on)` redraws it.
function buildToggle(icon, pos, extraClass) {
  const button = el('button', `tt-toggle ${extraClass || ''} pos-${pos}`);
  button.type = 'button';
  button.setOn = on => {
    button.classList.toggle('tt-toggle--on', on);
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    button.innerHTML = ttIcon(icon, { size: 18, filled: on });
  };
  button.setOn(false);
  return button;
}

async function ensureProfileOrRedirect() {
  const user = await getCurrentUser();
  if (!user) window.location.href = 'profile-picker.html';
  return user;
}

// ---------- Card actions ----------

function closeExistingPopover() {
  const existing = document.querySelector('.save-popover');
  if (existing) existing.remove();
}

function watchlistKey(item) {
  return `${item.mediaType}:${item.tmdbId}`;
}

// Marking something watched takes it off the Watchlist (localApi.js does that), so this tells
// the page: bookmark buttons unfill and the Watchlist pages drop the card. detail.mediaType /
// detail.tmdbId name the title.
const TITLE_WATCHED_EVENT = 'tt:title-watched';
function announceTitleWatched(mediaType, tmdbId) {
  document.dispatchEvent(new CustomEvent(TITLE_WATCHED_EVENT, { detail: { mediaType, tmdbId: Number(tmdbId) } }));
}

// The bookmark: opens a popover of every list (the Watchlist first) to save the item to. It's
// shown filled while the item is on the Watchlist. `button` defaults to a corner toggle on
// poster art; the detail page passes its own button.
function attachSaveButton(actionsEl, item, context, { button = null } = {}) {
  const btn = button || buildToggle('bookmark', 'br', 'tt-toggle--save');
  const key = watchlistKey(item);
  const sync = () => {
    const on = !!(context && context.watchlistKeys && context.watchlistKeys.has(key));
    if (btn.setOn) btn.setOn(on);
  };
  btn.setAttribute('aria-label', `Save ${item.title} to a list`);
  sync();
  if (!button) actionsEl.appendChild(btn);
  document.addEventListener(TITLE_WATCHED_EVENT, event => {
    if (watchlistKey(event.detail) !== key || !context || !context.watchlistKeys) return;
    context.watchlistKeys.delete(key);
    sync();
  });

  btn.addEventListener('click', async event => {
    event.stopPropagation();
    if (!(await ensureProfileOrRedirect())) return;

    // On a card the popover goes on the card itself - the poster art clips its overflow.
    const anchor = btn.closest('.tt-poster') || btn.parentElement;
    if (anchor.querySelector('.save-popover')) {
      closeExistingPopover();
      return;
    }
    closeExistingPopover();

    const [lists, membership] = await Promise.all([
      fetchJson('/api/lists'),
      fetchJson(`/api/lists/membership/${item.mediaType}/${item.tmdbId}`),
    ]);

    const popover = el('div', 'save-popover');
    popover.addEventListener('click', e => e.stopPropagation());

    lists
      .slice()
      .sort((a, b) => b.is_default - a.is_default)
      .forEach(list => {
        const row = el('label', 'save-popover-row');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = membership.listIds.includes(list.id);
        // Watched titles can't go on the Watchlist.
        const watchedLock = list.is_default && membership.watched && !checkbox.checked;
        if (watchedLock) {
          checkbox.disabled = true;
          row.classList.add('save-popover-row--disabled');
        }
        checkbox.addEventListener('change', async () => {
          if (checkbox.checked) {
            await fetch(`/api/lists/${list.id}/items`, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tmdbId: item.tmdbId, mediaType: item.mediaType }),
            });
          } else {
            await fetch(`/api/lists/${list.id}/items/${item.tmdbId}/${item.mediaType}`, { method: 'DELETE', credentials: 'same-origin' });
          }
          if (list.is_default && context && context.watchlistKeys) {
            if (checkbox.checked) context.watchlistKeys.add(key);
            else context.watchlistKeys.delete(key);
            sync();
          }
        });
        row.appendChild(checkbox);
        row.appendChild(el('span', null, list.is_default ? 'Watchlist' : list.name));
        if (watchedLock) row.appendChild(el('span', 'save-popover-note', 'Watched'));
        popover.appendChild(row);
      });

    anchor.appendChild(popover);

    document.addEventListener('click', function outsideClick(e) {
      if (!popover.contains(e.target) && !btn.contains(e.target)) {
        popover.remove();
        document.removeEventListener('click', outsideClick);
      }
    });
  });
}

// The remove (×) toggle on list pages, top-left of the poster.
function attachRemoveButton(card, item, listId, onRemoved, { listName = 'this list' } = {}) {
  const button = el('button', 'tt-toggle pos-tl');
  button.type = 'button';
  button.setAttribute('aria-label', `Remove ${item.title} from ${listName}`);
  button.innerHTML = ttIcon('close', { size: 18 });
  button.addEventListener('click', async event => {
    event.stopPropagation();
    await fetch(`/api/lists/${listId}/items/${item.tmdbId}/${item.mediaType}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    onRemoved();
  });
  card.overlayActionsEl.appendChild(button);
}

// Movies are watched as a single unit. `watchedMovieIds` is a Set fetched once per page.
// `onChange` runs after a successful toggle so pages listing watched items can refresh.
function attachWatchedButton(actionsEl, item, watchedMovieIds, onChange, { button = null } = {}) {
  const btn = button || buildToggle('eye', 'tr', 'tt-toggle--watch');
  if (!button) actionsEl.appendChild(btn);

  if (isUnreleased(item.releaseDate)) {
    btn.disabled = true;
    btn.setAttribute('aria-label', `${item.title} isn't out yet`);
    return;
  }

  const sync = () => {
    const on = watchedMovieIds.has(item.tmdbId);
    btn.setOn(on);
    btn.setAttribute('aria-label', `${on ? 'Unmark' : 'Mark'} ${item.title} as watched`);
  };
  sync();

  btn.addEventListener('click', async event => {
    event.stopPropagation();
    if (!(await ensureProfileOrRedirect())) return;

    const url = `/api/watched/movies/${item.tmdbId}`;
    if (watchedMovieIds.has(item.tmdbId)) {
      await fetch(url, { method: 'DELETE', credentials: 'same-origin' });
      watchedMovieIds.delete(item.tmdbId);
    } else {
      // Sends the display fields the card already has, so localApi.js can store them with the
      // id and watched lists render straight from IndexedDB.
      await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pickSummaryFields(item)),
      });
      watchedMovieIds.add(item.tmdbId);
      announceTitleWatched('movie', item.tmdbId);
    }
    sync();
    if (onChange) onChange();
  });
}

function favoriteKey(item) {
  return `${item.mediaType}:${item.tmdbId}`;
}

function attachFavoriteButton(actionsEl, item, favoriteIds, onChange, { button = null } = {}) {
  const btn = button || buildToggle('heart', 'bl', 'tt-toggle--fav');
  const key = favoriteKey(item);
  const sync = () => {
    const on = favoriteIds.has(key);
    btn.setOn(on);
    btn.setAttribute('aria-label', `${on ? 'Remove' : 'Add'} ${item.title} ${on ? 'from' : 'to'} favourites`);
  };
  sync();

  btn.addEventListener('click', async event => {
    event.stopPropagation();
    if (!(await ensureProfileOrRedirect())) return;

    const url = `/api/favorites/${item.mediaType}/${item.tmdbId}`;
    if (favoriteIds.has(key)) {
      await fetch(url, { method: 'DELETE', credentials: 'same-origin' });
      favoriteIds.delete(key);
    } else {
      await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pickSummaryFields(item)),
      });
      favoriteIds.add(key);
    }
    sync();
    if (onChange) onChange();
  });

  if (!button) actionsEl.appendChild(btn);
}

// Fetches the active profile's watched-movie ids, favourite ids and Watchlist contents once
// per page, so every card's toggle state is known without a request per card.
async function fetchStandardActionContext() {
  const empty = { watchedMovieIds: new Set(), favoriteIds: new Set(), watchlistKeys: new Set(), watchlistId: null };
  const user = await getCurrentUser();
  if (!user) return empty;

  const [watchedMovies, favoriteIdsByType, lists] = await Promise.all([
    fetchJson('/api/watched/movies'),
    fetchJson('/api/favorites/ids'),
    fetchJson('/api/lists'),
  ]);

  const favoriteIds = new Set([
    ...favoriteIdsByType.movie.map(id => `movie:${id}`),
    ...favoriteIdsByType.tv.map(id => `tv:${id}`),
  ]);

  const watchlist = lists.find(l => l.is_default);
  const watchlistItems = watchlist ? await fetchJson(`/api/lists/${watchlist.id}/items`) : [];

  return {
    watchedMovieIds: new Set(watchedMovies),
    favoriteIds,
    watchlistKeys: new Set(watchlistItems.map(watchlistKey)),
    watchlistId: watchlist ? watchlist.id : null,
  };
}

// The standard toggles on a poster: watched (movies only - shows are tracked per episode on
// their page), favourite, and save. `onChange` fires after a watched/favourite toggle.
function attachStandardActions(card, item, context, { includeSave = true, onChange } = {}) {
  if (item.mediaType === 'movie') {
    attachWatchedButton(card.overlayActionsEl, item, context.watchedMovieIds, onChange);
  }
  attachFavoriteButton(card.overlayActionsEl, item, context.favoriteIds, onChange);
  if (includeSave) attachSaveButton(card.overlayActionsEl, item, context);
}

// ---------- Dialogs ----------

function openDialog() {
  const overlay = el('div', 'confirm-overlay');
  const modal = el('div', 'confirm-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  return { overlay, modal };
}

function dialogButton(label, variant) {
  const btn = el('button', `tt-btn tt-btn--${variant}`, label);
  btn.type = 'button';
  return btn;
}

// Yes/no dialog. Resolves true when confirmed.
function confirmDialog({ title = null, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
  return new Promise(resolve => {
    const { overlay, modal } = openDialog();
    if (title) modal.appendChild(el('h2', null, title));
    modal.appendChild(el('p', null, message));
    const actions = el('div', 'confirm-actions');
    const close = result => { overlay.remove(); resolve(result); };
    const cancel = dialogButton(cancelLabel, 'secondary');
    cancel.addEventListener('click', () => close(false));
    const ok = dialogButton(confirmLabel, danger ? 'danger' : 'primary');
    ok.addEventListener('click', () => close(true));
    actions.appendChild(cancel);
    actions.appendChild(ok);
    modal.appendChild(actions);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(false); });
  });
}

// Asks for one line of text. Resolves the trimmed text, or null when cancelled.
function promptDialog({ title, label, placeholder = '', confirmLabel = 'Save', value = '' }) {
  return new Promise(resolve => {
    const { overlay, modal } = openDialog();
    const form = el('form', 'dialog-form');
    form.appendChild(el('h2', null, title));
    const field = buildTextField({ label, placeholder, value, required: true });
    const { input } = field;
    form.appendChild(field);
    const actions = el('div', 'confirm-actions');
    const close = result => { overlay.remove(); resolve(result); };
    const cancel = dialogButton('Cancel', 'secondary');
    cancel.addEventListener('click', () => close(null));
    const ok = dialogButton(confirmLabel, 'primary');
    ok.type = 'submit';
    actions.appendChild(cancel);
    actions.appendChild(ok);
    form.appendChild(actions);
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (input.value.trim()) close(input.value.trim());
    });
    modal.appendChild(form);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(null); });
    input.focus();
  });
}

// ---------- Stats ----------

function formatWatchTime(totalMinutes) {
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours >= 24) {
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return `${days}D ${hours}h`;
  }
  const minutes = totalMinutes % 60;
  return `${totalHours}h ${minutes}m`;
}

// Summary tiles from GET /api/stats: five tiles, watch time spanning two columns. `layout`
// 'profile' is the Profile page's order; 'stats' leads with episodes and watch time.
function renderStatTiles(grid, stats, { layout = 'profile' } = {}) {
  grid.innerHTML = '';
  const watchTime = formatWatchTime(stats.totalWatchMinutes);
  const tiles = layout === 'stats'
    ? [
      [stats.episodesWatched, 'Episodes watched'],
      [stats.moviesWatched, 'Movies watched'],
      [stats.showsTracked, 'Shows tracked'],
      [watchTime, 'Watch time', { wide: true }],
      [stats.favorites, 'Favourites'],
    ]
    : [
      [stats.moviesWatched, 'Movies watched'],
      [stats.showsTracked, 'Shows tracked'],
      [stats.episodesWatched, 'Episodes watched'],
      [watchTime, 'Total watch time', { wide: true }],
      [stats.favorites, 'Favourites'],
    ];
  tiles.forEach(([value, label, opts]) => grid.appendChild(buildStatTile(value, label, opts)));
}
