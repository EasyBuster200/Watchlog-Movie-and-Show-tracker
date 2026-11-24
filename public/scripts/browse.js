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
