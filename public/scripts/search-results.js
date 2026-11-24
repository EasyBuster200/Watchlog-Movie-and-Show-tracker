// The search results page (?q=<query>&type=movie|tv): the search field (results update as you
// type), a BrowseHeader whose summary says how many results there are and whose filter sheet
// picks All / Shows / Movies / People (with how many of each are on this page), then the
// results as rows, with Prev/Next paging through TMDB's multi-search.

const SEARCH_PAGE_DEBOUNCE_MS = 350;
const SEARCH_FILTERS = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'tv', label: 'Shows', match: r => r.media_type === 'tv' },
  { id: 'movie', label: 'Movies', match: r => r.media_type === 'movie' },
  { id: 'person', label: 'People', match: r => r.media_type === 'person' },
];

const searchState = { query: '', page: 1, filter: 'all', results: [], totalPages: 1 };
let searchController = null;

function syncUrl() {
  const params = new URLSearchParams();
  if (searchState.query) params.set('q', searchState.query);
  if (searchState.filter !== 'all') params.set('type', searchState.filter);
  window.history.replaceState(null, '', `${window.location.pathname}${params.toString() ? `?${params}` : ''}`);
}

let searchHeader = null;

function searchSummaryText() {
  if (!searchState.query) return 'Search for a movie, show or person.';
  const filter = SEARCH_FILTERS.find(f => f.id === searchState.filter);
  const n = searchState.results.filter(filter.match).length;
  const kind = searchState.filter === 'all' ? '' : `${filter.label} · `;
  return `${kind}${n} result${n === 1 ? '' : 's'} for “${searchState.query}”${searchState.totalPages > 1 ? ` · page ${searchState.page}` : ''}`;
}

// The filter sheet's Type choices carry this page's counts ("Shows 12").
function renderChips() {
  const options = SEARCH_FILTERS.map(f => ({
    id: f.id,
    label: searchState.query ? `${f.label} ${searchState.results.filter(f.match).length}` : f.label,
    summary: f.label,
  }));
  const next = {
    sections: [{ id: 'type', label: 'Show', kind: 'single', options }],
    values: { type: searchState.filter },
    summary: searchSummaryText(),
  };
  if (searchHeader) {
    searchHeader.update(next);
    return;
  }
  searchHeader = createBrowseHeader({
    ...next,
    onChange: ({ values }) => {
      searchState.filter = values.type;
      syncUrl();
      renderChips();
      renderResults();
    },
  });
  document.getElementById('search-chips').appendChild(searchHeader.el);
}

function renderResults() {
  const list = document.getElementById('search-results-list');
  const emptyEl = document.getElementById('search-empty');
  const filter = SEARCH_FILTERS.find(f => f.id === searchState.filter);
  const shown = searchState.results.filter(filter.match);

  list.innerHTML = '';
  if (!searchState.query) {
    emptyEl.hidden = true;
    renderPagination(document.getElementById('search-results-pagination'), 1, 1, () => {});
    return;
  }
  emptyEl.hidden = shown.length > 0;
  shown.forEach(raw => {
    const item = raw.media_type === 'person' ? normalizeTmdbPerson(raw) : toStandardItem(raw);
    list.appendChild(buildSearchResultRow(item));
  });
  renderPagination(document.getElementById('search-results-pagination'), searchState.page, searchState.totalPages, page => {
    searchState.page = page;
    loadResults();
  });
}

async function loadResults() {
  const list = document.getElementById('search-results-list');
  if (!searchState.query) {
    searchState.results = [];
    renderChips();
    renderResults();
    return;
  }
  if (searchController) searchController.abort();
  searchController = new AbortController();
  list.innerHTML = '';
  for (let i = 0; i < 5; i++) list.appendChild(buildSkeletonMediaRow());

  try {
    const params = new URLSearchParams({ query: searchState.query, page: searchState.page, include_adult: 'false' });
    const response = await fetch(`/api/tmdb/search/multi?${params}`, { credentials: 'same-origin', signal: searchController.signal });
    const data = await response.json();
    searchState.results = (data.results || []).filter(r => SEARCH_FILTERS.slice(1).some(f => f.match(r)));
    searchState.totalPages = Math.min(data.total_pages || 1, 500);
    renderChips();
    renderResults();
  } catch (error) {
    if (error.name === 'AbortError') return;
    console.error('Search failed:', error);
    list.innerHTML = '';
    list.appendChild(el('p', 'empty-note', 'Something went wrong loading results.'));
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  searchState.query = (params.get('q') || '').trim();
  const type = params.get('type');
  if (SEARCH_FILTERS.some(f => f.id === type)) searchState.filter = type;

  const input = document.getElementById('search-page-input');
  input.value = searchState.query;
  if (!searchState.query) input.focus();

  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      searchState.query = input.value.trim();
      searchState.page = 1;
      syncUrl();
      loadResults();
    }, SEARCH_PAGE_DEBOUNCE_MS);
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter') input.blur();
  });

  renderChips();
  loadResults();
});
