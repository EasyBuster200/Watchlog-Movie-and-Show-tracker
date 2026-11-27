// Friends (roadmap Phase 7, first step): friend codes, requests, blocking, what friends may see,
// and a friend's library. Decided with the user: people find each other by friend code only
// (no search), and friends see everything by default (each account can lower it).
//
//   GET    /v1/friends                       { code, shareLevel, friends, incoming, outgoing, blocked }
//   POST   /v1/friends/code                  a new friend code (the old one stops working)
//   PUT    /v1/friends/settings              { shareLevel: 'everything' | 'lists' | 'nothing' }
//   POST   /v1/friends/requests              { code }  -> { status: 'sent' | 'friends' }
//   POST   /v1/friends/requests/:id/accept   accept the request from account :id
//   DELETE /v1/friends/requests/:id          decline theirs, or cancel mine
//   DELETE /v1/friends/:id                   stop being friends
//   POST   /v1/friends/:id/block             block (also ends the friendship and any requests)
//   DELETE /v1/friends/blocks/:id            unblock
//   GET    /v1/friends/:id/library           what that friend shares, plus your taste match
//   GET    /v1/friends/title/:type/:id       which friends watched, favourited or saved a title
//   GET    /v1/friends/activity              what friends did in the last 30 days
//
// Every rule is checked here, never trusted from the app: only friends see a library, and only
// as much as its owner's share level allows. A blocked account is told "nobody has that code".
// Sync replies carry `friends: { incoming }` so every device can show a banner, and the
// recipient's devices get a push (kind 'friends').

import { route, json, noContent, readJson, ApiError } from '../router.js';
import { requireAuth, rateLimit, pairingCodeData, generatePairingCode, nowIso } from '../auth.js';
import { notifyAccounts } from '../push.js';

export const SHARE_LEVELS = ['everything', 'lists', 'nothing'];
export const FRIEND_LIMITS = {
  requestsPerAccount: [30, 24 * 3600],
  newCodesPerAccount: [5, 3600],
  maxFriends: 200,
};
const WATCHLIST_SYNC_ID = 'watchlist';

const limited = (env, key, [limit, seconds]) => rateLimit(env, key, limit, seconds);
const pair = (x, y) => (x < y ? [x, y] : [y, x]);
const NO_SUCH_CODE = () => new ApiError(404, 'no_such_code', 'Nobody has that friend code. Check it with your friend.');
const NOT_FRIENDS = () => new ApiError(404, 'not_friends', "You're not friends with that account.");

export function formatFriendCode(code) {
  return code ? `${code.slice(0, 4)}-${code.slice(4)}` : null;
}

async function friendCodeFor(env, accountId) {
  const row = await env.DB.prepare('SELECT friend_code AS code FROM accounts WHERE id = ?').bind(accountId).first();
  if (row && row.code) return row.code;
  return newFriendCode(env, accountId);
}

async function newFriendCode(env, accountId) {
  for (let tries = 0; tries < 5; tries++) {
    const code = pairingCodeData(generatePairingCode());
    try {
      await env.DB.prepare('UPDATE accounts SET friend_code = ? WHERE id = ?').bind(code, accountId).run();
      return code;
    } catch (error) {
      if (!/UNIQUE/i.test(String(error && error.message))) throw error;
    }
  }
  throw new ApiError(503, 'try_again', 'Something went wrong. Try again.');
}

export async function areFriends(env, x, y) {
  const [a, b] = pair(x, y);
  return Boolean(await env.DB.prepare('SELECT 1 FROM friendships WHERE account_a = ? AND account_b = ?').bind(a, b).first());
}

async function isBlockedEitherWay(env, x, y) {
  return Boolean(await env.DB.prepare('SELECT 1 FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)')
    .bind(x, y, y, x).first());
}

async function friendCount(env, id) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM friendships WHERE account_a = ? OR account_b = ?').bind(id, id).first();
  return row ? row.n : 0;
}

async function makeFriends(env, x, y) {
  if (await friendCount(env, x) >= FRIEND_LIMITS.maxFriends || await friendCount(env, y) >= FRIEND_LIMITS.maxFriends) {
    throw new ApiError(409, 'too_many_friends', `An account can have up to ${FRIEND_LIMITS.maxFriends} friends.`);
  }
  const [a, b] = pair(x, y);
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO friendships (account_a, account_b, created_at) VALUES (?, ?, ?)').bind(a, b, nowIso()),
    env.DB.prepare('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)').bind(x, y, y, x),
  ]);
}

function later(ctx, promise) {
  const safe = promise.catch(error => console.error('Friend push failed', error && error.message ? error.message : error));
  if (ctx && ctx.waitUntil) ctx.waitUntil(safe); else return safe;
  return undefined;
}

route('GET', '/friends', async ({ request, env }) => {
  const { account } = await requireAuth(request, env);
  const id = account.id;
  const [code, settings, friends, incoming, outgoing, blocked] = await Promise.all([
    friendCodeFor(env, id),
    env.DB.prepare('SELECT share_level AS shareLevel FROM accounts WHERE id = ?').bind(id).first(),
    env.DB.prepare(
      `SELECT a.id, a.display_name AS displayName, f.created_at AS since FROM friendships f
         JOIN accounts a ON a.id = CASE WHEN f.account_a = ? THEN f.account_b ELSE f.account_a END
        WHERE (f.account_a = ? OR f.account_b = ?) AND a.status = 'active' ORDER BY a.display_name COLLATE NOCASE`
    ).bind(id, id, id).all(),
    env.DB.prepare(`SELECT a.id, a.display_name AS displayName, r.created_at AS at FROM friend_requests r JOIN accounts a ON a.id = r.from_id
                    WHERE r.to_id = ? AND a.status = 'active' ORDER BY r.created_at DESC`).bind(id).all(),
    env.DB.prepare(`SELECT a.id, a.display_name AS displayName, r.created_at AS at FROM friend_requests r JOIN accounts a ON a.id = r.to_id
                    WHERE r.from_id = ? ORDER BY r.created_at DESC`).bind(id).all(),
    env.DB.prepare(`SELECT a.id, a.display_name AS displayName, b.created_at AS at FROM blocks b JOIN accounts a ON a.id = b.blocked_id
                    WHERE b.blocker_id = ? ORDER BY b.created_at DESC`).bind(id).all(),
  ]);
  return json({
    code: formatFriendCode(code),
    shareLevel: (settings && settings.shareLevel) || 'everything',
    friends: friends.results,
    incoming: incoming.results,
    outgoing: outgoing.results,
    blocked: blocked.results,
  });
});

route('POST', '/friends/code', async ({ request, env }) => {
  const { account } = await requireAuth(request, env);
  await limited(env, `friend-code:account:${account.id}`, FRIEND_LIMITS.newCodesPerAccount);
  return json({ code: formatFriendCode(await newFriendCode(env, account.id)) });
});

route('PUT', '/friends/settings', async ({ request, env }) => {
  const { account } = await requireAuth(request, env);
  const { shareLevel } = await readJson(request);
  if (!SHARE_LEVELS.includes(shareLevel)) throw new ApiError(400, 'invalid_share_level', 'Choose everything, lists or nothing.');
  await env.DB.prepare('UPDATE accounts SET share_level = ? WHERE id = ?').bind(shareLevel, account.id).run();
  return json({ shareLevel });
});

route('POST', '/friends/requests', async ({ request, env, ctx }) => {
  const { account } = await requireAuth(request, env);
  await limited(env, `friend-request:account:${account.id}`, FRIEND_LIMITS.requestsPerAccount);
  const code = pairingCodeData((await readJson(request)).code);
  if (!code) throw new ApiError(400, 'invalid_code_format', "That doesn't look like a friend code. It's 8 letters and numbers, like ABCD-1234.");
  const target = await env.DB.prepare("SELECT id, display_name AS displayName FROM accounts WHERE friend_code = ? AND status = 'active'").bind(code).first();
  if (!target) throw NO_SUCH_CODE();
  if (target.id === account.id) throw new ApiError(400, 'own_code', "That's your own friend code.");
  if (await isBlockedEitherWay(env, account.id, target.id)) throw NO_SUCH_CODE();
  if (await areFriends(env, account.id, target.id)) throw new ApiError(409, 'already_friends', `You're already friends with ${target.displayName}.`);

  // They already asked me: that's a yes.
  const theirs = await env.DB.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?').bind(target.id, account.id).first();
  if (theirs) {
    await makeFriends(env, account.id, target.id);
    return json({ status: 'friends', friend: { id: target.id, displayName: target.displayName } });
  }
  await env.DB.prepare('INSERT OR IGNORE INTO friend_requests (from_id, to_id, created_at) VALUES (?, ?, ?)').bind(account.id, target.id, nowIso()).run();
  later(ctx, notifyAccounts(env, [target.id], {
    title: `${account.displayName} wants to be friends`,
    body: 'Open Watchlog to accept or decline.',
    url: '/friends.html',
    tag: 'friend-requests',
  }, { kind: 'friends' }));
  return json({ status: 'sent', friend: { id: target.id, displayName: target.displayName } }, 201);
});

route('POST', '/friends/requests/:id/accept', async ({ request, env, params }) => {
  const { account } = await requireAuth(request, env);
  const pending = await env.DB.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?').bind(params.id, account.id).first();
  if (!pending) throw new ApiError(404, 'no_request', 'That request was cancelled or already answered.');
  await makeFriends(env, account.id, params.id);
  return noContent();
});

route('DELETE', '/friends/requests/:id', async ({ request, env, params }) => {
  const { account } = await requireAuth(request, env);
  await env.DB.prepare('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)')
    .bind(params.id, account.id, account.id, params.id).run();
  return noContent();
});

route('DELETE', '/friends/blocks/:id', async ({ request, env, params }) => {
  const { account } = await requireAuth(request, env);
  await env.DB.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').bind(account.id, params.id).run();
  return noContent();
});

route('DELETE', '/friends/:id', async ({ request, env, params }) => {
  const { account } = await requireAuth(request, env);
  const [a, b] = pair(account.id, params.id);
  await env.DB.prepare('DELETE FROM friendships WHERE account_a = ? AND account_b = ?').bind(a, b).run();
  return noContent();
});

route('POST', '/friends/:id/block', async ({ request, env, params }) => {
  const { account } = await requireAuth(request, env);
  if (params.id === account.id) throw new ApiError(400, 'own_account', "You can't block yourself.");
  const exists = await env.DB.prepare('SELECT 1 FROM accounts WHERE id = ?').bind(params.id).first();
  if (!exists) throw new ApiError(404, 'not_found', 'That account no longer exists.');
  const [a, b] = pair(account.id, params.id);
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?)').bind(account.id, params.id, nowIso()),
    env.DB.prepare('DELETE FROM friendships WHERE account_a = ? AND account_b = ?').bind(a, b),
    env.DB.prepare('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)').bind(account.id, params.id, params.id, account.id),
  ]);
  return noContent();
});

// A friend's library, as much as they share. Kept small for the free plan's CPU: watched
// episodes come back as one row per show (a count and the last time), worked out by D1.
route('GET', '/friends/:id/library', async ({ request, env, params }) => {
  const { account } = await requireAuth(request, env);
  const friend = await env.DB.prepare("SELECT id, display_name AS displayName, share_level AS shareLevel FROM accounts WHERE id = ? AND status = 'active'")
    .bind(params.id).first();
  if (!friend || friend.id === account.id || !(await areFriends(env, account.id, friend.id))) throw NOT_FRIENDS();
  const level = SHARE_LEVELS.includes(friend.shareLevel) ? friend.shareLevel : 'everything';
  const reply = { friend: { id: friend.id, displayName: friend.displayName }, shareLevel: level };
  if (level === 'nothing') return json(reply);

  const id = friend.id;
  const summary = prefix => `json_extract(data, '$.title') AS title, json_extract(data, '$.year') AS year,
    json_extract(data, '$.releaseDate') AS releaseDate, json_extract(data, '$.posterPath') AS posterPath,
    json_extract(data, '$.voteAverage') AS voteAverage${prefix}`;
  const [favorites, lists, items] = await Promise.all([
    env.DB.prepare(`SELECT json_extract(data, '$.mediaType') AS mediaType, CAST(json_extract(data, '$.tmdbId') AS INTEGER) AS tmdbId,
                           json_extract(data, '$.favoritedAt') AS favoritedAt, ${summary('')}
                      FROM sync_records WHERE account_id = ? AND kind = 'favorite' AND deleted = 0
                     ORDER BY favoritedAt DESC`).bind(id).all(),
    env.DB.prepare(`SELECT record_key AS syncId, json_extract(data, '$.name') AS name, json_extract(data, '$.createdAt') AS createdAt
                      FROM sync_records WHERE account_id = ? AND kind = 'list' AND deleted = 0 ORDER BY createdAt`).bind(id).all(),
    env.DB.prepare(`SELECT json_extract(data, '$.list') AS list, json_extract(data, '$.mediaType') AS mediaType,
                           CAST(json_extract(data, '$.tmdbId') AS INTEGER) AS tmdbId, json_extract(data, '$.addedAt') AS addedAt
                      FROM sync_records WHERE account_id = ? AND kind = 'list_item' AND deleted = 0 ORDER BY addedAt DESC`).bind(id).all(),
  ]);
  reply.favorites = favorites.results;
  reply.lists = lists.results.map(list => ({ ...list, items: items.results.filter(i => i.list === list.syncId).map(({ list: _l, ...i }) => i) }));
  if (level === 'lists') return json(reply);

  const [movies, shows] = await Promise.all([
    env.DB.prepare(`SELECT CAST(record_key AS INTEGER) AS tmdbId, json_extract(data, '$.watchedAt') AS watchedAt, ${summary('')}
                      FROM sync_records WHERE account_id = ? AND kind = 'watched_movie' AND deleted = 0 ORDER BY watchedAt DESC`).bind(id).all(),
    env.DB.prepare(`SELECT CAST(json_extract(data, '$.showId') AS INTEGER) AS tmdbId, COUNT(*) AS episodes,
                           MAX(json_extract(data, '$.watchedAt')) AS lastWatchedAt
                      FROM sync_records WHERE account_id = ? AND kind = 'watched_episode' AND deleted = 0
                     GROUP BY tmdbId ORDER BY lastWatchedAt DESC`).bind(id).all(),
  ]);
  reply.watchlist = items.results.filter(i => i.list === WATCHLIST_SYNC_ID).map(({ list: _l, ...i }) => i);
  reply.movies = movies.results;
  reply.shows = shows.results;
  reply.tasteMatch = await tasteMatch(env, account.id, friend.id, movies.results, shows.results);
  return json(reply);
});

// ---------- Step 2: friends on a title, the activity feed, taste match ----------
// All of it follows "What your friends see" (decided with the user, no separate switch):
// 'everything' shares watching, favourites, the Watchlist and lists; 'lists' shares favourites
// and list additions (not the Watchlist); 'nothing' shares none of it.

export const ACTIVITY_DAYS = 30;
export const ACTIVITY_LIMIT = 100;
export const TASTE_MIN_TITLES = 3;
const TASTE_TITLES = 20;

// My friends who share something, with their share level. Plain `?`s (the id three times),
// since an account's friends come from both columns of `friendships`.
const SHARING_FRIENDS = `SELECT a.id, a.display_name AS displayName, a.share_level AS level FROM friendships f
  JOIN accounts a ON a.id = CASE WHEN f.account_a = ? THEN f.account_b ELSE f.account_a END
  WHERE (f.account_a = ? OR f.account_b = ?) AND a.status = 'active' AND a.share_level IN ('everything', 'lists')`;

// Taste match: how much two people's watched titles (movies, and shows with any watched
// episode) overlap, as a percentage: shared / sqrt(mine × theirs), so a short library next to a
// long one isn't 100% just because it's all in there. Null until both have TASTE_MIN_TITLES.
async function tasteMatch(env, me, friendId, theirMovies, theirShows) {
  const showIds = `SELECT DISTINCT json_extract(data, '$.showId') AS id FROM sync_records WHERE account_id = ? AND kind = 'watched_episode' AND deleted = 0`;
  const [mine, sharedMovies, sharedShows] = await Promise.all([
    env.DB.prepare(`SELECT (SELECT COUNT(*) FROM sync_records WHERE account_id = ? AND kind = 'watched_movie' AND deleted = 0) AS movies,
                           (SELECT COUNT(*) FROM (${showIds})) AS shows`).bind(me, me).first(),
    env.DB.prepare(`SELECT t.record_key AS k FROM sync_records t
                      JOIN sync_records m ON m.account_id = ? AND m.kind = 'watched_movie' AND m.deleted = 0 AND m.record_key = t.record_key
                     WHERE t.account_id = ? AND t.kind = 'watched_movie' AND t.deleted = 0`).bind(me, friendId).all(),
    env.DB.prepare(`${showIds} INTERSECT ${showIds}`).bind(me, friendId).all(),
  ]);
  const myCount = (mine ? mine.movies + mine.shows : 0);
  const theirCount = theirMovies.length + theirShows.length;
  const movieKeys = new Set(sharedMovies.results.map(r => Number(r.k)));
  const showKeys = new Set(sharedShows.results.map(r => Number(r.id)));
  const shared = movieKeys.size + showKeys.size;
  const percent = myCount >= TASTE_MIN_TITLES && theirCount >= TASTE_MIN_TITLES
    ? Math.min(100, Math.round((100 * shared) / Math.sqrt(myCount * theirCount)))
    : null;
  // The titles you've both watched, most recently watched by them first.
  const titles = [
    ...theirMovies.filter(m => movieKeys.has(m.tmdbId)).map(m => ({ ...m, mediaType: 'movie', at: m.watchedAt })),
    ...theirShows.filter(s => showKeys.has(s.tmdbId)).map(s => ({ mediaType: 'tv', tmdbId: s.tmdbId, at: s.lastWatchedAt })),
  ].sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, TASTE_TITLES);
  return { percent, shared, mine: myCount, theirs: theirCount, titles };
}

// Which friends watched, favourited or saved one title: "2 friends watched this", "Ana is on S3E4".
route('GET', '/friends/title/:type/:id', async ({ request, env, params }) => {
  const { account } = await requireAuth(request, env);
  const type = params.type;
  const tmdbId = Number(params.id);
  if (!['movie', 'tv'].includes(type) || !Number.isInteger(tmdbId) || tmdbId <= 0) throw new ApiError(400, 'invalid_title', 'That title is not valid.');
  const me = account.id;
  // One correlated subquery per fact, each on sync_records' primary key (account, kind, key).
  // Episode keys are "<show>:<season>:<episode>", so a key range finds one show's episodes
  // (";" sorts right after ":"); specials (season 0) don't count.
  const one = (kind, expr, extra = '') => `(SELECT ${expr} FROM sync_records r WHERE r.account_id = f.id AND r.kind = '${kind}' AND r.deleted = 0 ${extra})`;
  const episodeRange = "AND r.record_key >= ? AND r.record_key < ? AND json_extract(r.data, '$.seasonNumber') > 0";
  const watchedCols = type === 'movie'
    ? `${one('watched_movie', "json_extract(r.data, '$.watchedAt')", 'AND r.record_key = ?')} AS watchedAt, NULL AS episodes, NULL AS latest`
    : `${one('watched_episode', "MAX(json_extract(r.data, '$.watchedAt'))", episodeRange)} AS watchedAt,
       ${one('watched_episode', 'COUNT(*)', episodeRange)} AS episodes,
       ${one('watched_episode', "MAX(json_extract(r.data, '$.seasonNumber') * 10000 + json_extract(r.data, '$.episodeNumber'))", episodeRange)} AS latest`;
  const range = [`${tmdbId}:`, `${tmdbId};`];
  const watchedParams = type === 'movie' ? [String(tmdbId)] : [...range, ...range, ...range];
  const rows = await env.DB.prepare(
    `SELECT f.id, f.displayName, f.level, ${watchedCols},
            ${one('favorite', '1', 'AND r.record_key = ?')} AS favorite,
            ${one('list_item', '1', 'AND r.record_key = ?')} AS watchlist
       FROM (${SHARING_FRIENDS}) f`
  ).bind(...watchedParams, `${type}:${tmdbId}`, `${WATCHLIST_SYNC_ID}:${type}:${tmdbId}`, me, me, me).all();
  const friends = [];
  for (const row of rows.results) {
    const everything = row.level === 'everything';
    const entry = { id: row.id, displayName: row.displayName };
    if (everything && row.watchedAt) {
      entry.watchedAt = row.watchedAt;
      if (type === 'tv') {
        entry.episodes = row.episodes;
        entry.latest = { season: Math.floor(row.latest / 10000), episode: row.latest % 10000 };
      }
    }
    if (row.favorite) entry.favorite = true;
    if (everything && row.watchlist) entry.watchlist = true;
    if (entry.watchedAt || entry.favorite || entry.watchlist) friends.push(entry);
  }
  friends.sort((a, b) => String(b.watchedAt || '').localeCompare(String(a.watchedAt || '')) || a.displayName.localeCompare(b.displayName));
  return json({ friends });
});

// What friends did lately (ACTIVITY_DAYS), newest first, at most ACTIVITY_LIMIT items. Episodes
// are grouped per friend, show and day ("Ana watched 3 episodes of Severance"). Times are the
// records' own (watchedAt, favoritedAt, addedAt), so an imported history doesn't flood the feed.
route('GET', '/friends/activity', async ({ request, env }) => {
  const { account } = await requireAuth(request, env);
  const me = account.id;
  const since = new Date(Date.now() - ACTIVITY_DAYS * 24 * 3600 * 1000).toISOString();
  const friendsSql = SHARING_FRIENDS;
  const [episodes, others] = await Promise.all([
    env.DB.prepare(
      `SELECT f.id AS friendId, f.displayName, CAST(json_extract(r.data, '$.showId') AS INTEGER) AS tmdbId,
              substr(json_extract(r.data, '$.watchedAt'), 1, 10) AS day, COUNT(*) AS episodes,
              MAX(json_extract(r.data, '$.watchedAt')) AS at,
              MIN(json_extract(r.data, '$.seasonNumber') * 10000 + json_extract(r.data, '$.episodeNumber')) AS first,
              MAX(json_extract(r.data, '$.seasonNumber') * 10000 + json_extract(r.data, '$.episodeNumber')) AS last
         FROM (${friendsSql}) f JOIN sync_records r ON r.account_id = f.id
        WHERE f.level = 'everything' AND r.kind = 'watched_episode' AND r.deleted = 0
          AND r.updated_at >= ? AND json_extract(r.data, '$.watchedAt') >= ?
        GROUP BY f.id, tmdbId, day ORDER BY at DESC LIMIT ?`
    ).bind(me, me, me, since, since, ACTIVITY_LIMIT).all(),
    env.DB.prepare(
      `SELECT f.id AS friendId, f.displayName, r.kind, r.data,
              COALESCE(json_extract(r.data, '$.watchedAt'), json_extract(r.data, '$.favoritedAt'), json_extract(r.data, '$.addedAt')) AS at,
              json_extract(l.data, '$.name') AS listName
         FROM (${friendsSql}) f JOIN sync_records r ON r.account_id = f.id
         LEFT JOIN sync_records l ON l.account_id = r.account_id AND l.kind = 'list' AND l.deleted = 0
                                 AND l.record_key = json_extract(r.data, '$.list')
        WHERE r.deleted = 0 AND r.updated_at >= ?
          AND (   (r.kind = 'watched_movie' AND f.level = 'everything')
               OR  r.kind = 'favorite'
               OR (r.kind = 'list_item' AND json_extract(r.data, '$.list') = '${WATCHLIST_SYNC_ID}' AND f.level = 'everything')
               OR (r.kind = 'list_item' AND l.record_key IS NOT NULL))
          AND COALESCE(json_extract(r.data, '$.watchedAt'), json_extract(r.data, '$.favoritedAt'), json_extract(r.data, '$.addedAt')) >= ?
        ORDER BY at DESC LIMIT ?`
    ).bind(me, me, me, since, since, ACTIVITY_LIMIT).all(),
  ]);
  const ep = n => ({ season: Math.floor(n / 10000), episode: n % 10000 });
  const items = [
    ...episodes.results.map(r => ({
      type: 'episodes', friend: { id: r.friendId, displayName: r.displayName }, at: r.at,
      mediaType: 'tv', tmdbId: r.tmdbId, episodes: r.episodes, first: ep(r.first), last: ep(r.last),
    })),
    ...others.results.map(r => {
      const data = JSON.parse(r.data);
      const item = {
        type: r.kind === 'watched_movie' ? 'watched' : r.kind === 'favorite' ? 'favorite' : r.listName ? 'list' : 'watchlist',
        friend: { id: r.friendId, displayName: r.displayName }, at: r.at,
        mediaType: r.kind === 'watched_movie' ? 'movie' : data.mediaType, tmdbId: Number(data.tmdbId),
      };
      if (r.listName) item.listName = r.listName;
      for (const field of ['title', 'year', 'releaseDate', 'posterPath', 'voteAverage']) if (data[field] != null) item[field] = data[field];
      return item;
    }),
  ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, ACTIVITY_LIMIT);
  return json({ items, days: ACTIVITY_DAYS });
});
