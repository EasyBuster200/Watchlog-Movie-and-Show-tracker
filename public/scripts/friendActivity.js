// Friends' activity (roadmap Phase 7, step 2): what friends watched, favourited and saved in the
// last 30 days, from GET /v1/friends/activity (serverApi.js's getFriendActivity). Home shows the
// newest few (app.js); activity.html shows them all. What appears follows each friend's "What
// your friends see" (decided with the user): watching only from friends who share everything.
//
// Watched movies and favourites carry their title and poster; shows and list additions are
// looked up on TMDB (through the fetch shim and its 7-day cache).

async function activityTitle(item) {
  if (item.title) return { title: item.title, posterPath: item.posterPath || null };
  try {
    const response = await fetch(`/api/tmdb/${item.mediaType}/${item.tmdbId}?language=en-US`, { credentials: 'same-origin' });
    if (!response.ok) return null;
    const standard = toStandardItem(await response.json(), item.mediaType);
    return { title: standard.title, posterPath: standard.posterPath };
  } catch (error) {
    return null;
  }
}

// "Ana watched S2 · E3", "Ana watched 3 episodes, up to S2 · E3", "Ana added it to Horror".
function activitySentence(item) {
  const name = item.friend.displayName;
  switch (item.type) {
    case 'episodes': {
      const last = `S${item.last.season} · E${item.last.episode}`;
      return item.episodes === 1 ? `${name} watched ${last}` : `${name} watched ${item.episodes} episodes, up to ${last}`;
    }
    case 'watched': return `${name} watched it`;
    case 'favorite': return `${name} added it to their favourites`;
    case 'watchlist': return `${name} added it to their Watchlist`;
    case 'list': return `${name} added it to “${item.listName}”`;
    default: return name;
  }
}

function buildActivityRow(item, info) {
  const row = buildMediaRow({
    href: detailUrl({ mediaType: item.mediaType, tmdbId: item.tmdbId }),
    title: info ? info.title : 'Unknown title',
    meta: activitySentence(item),
    imageSrc: info ? thumbUrl(info.posterPath) : null,
  });
  row.classList.add('activity-row');
  row.bodyEl.appendChild(el('span', 'tt-media__meta activity-row__when', timeAgo(item.at)));
  return row;
}

// Fills `container` with activity rows. Resolves the number of items shown, or null when the
// profile can't have friends' activity (offline, signed out, no friends): the caller hides it.
async function renderFriendActivity(container, { limit = Infinity, emptyText } = {}) {
  const profile = getActiveProfile();
  if (!canAskAboutFriends(profile)) return null;
  container.innerHTML = '';
  container.appendChild(buildSkeletonMediaRow());
  let reply;
  try {
    reply = await getFriendActivity(profile);
  } catch (error) {
    container.innerHTML = '';
    container.appendChild(el('p', 'empty-note', error.message || "Couldn't load your friends' activity."));
    return 0;
  }
  const items = reply.items.slice(0, limit);
  const infos = await Promise.all(items.map(activityTitle));
  container.innerHTML = '';
  if (!items.length) {
    container.appendChild(el('p', 'empty-note', emptyText || `Nothing from your friends in the last ${reply.days} days.`));
    return 0;
  }
  items.forEach((item, i) => container.appendChild(buildActivityRow(item, infos[i])));
  return items.length;
}
