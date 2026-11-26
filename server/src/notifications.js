// Notifications through the server (roadmap Phase 6), run every hour by the Cron Trigger
// (index.js). For devices that switched them on (push_subscriptions.notify_*; Settings in the
// web app), from what each account has synced:
// - new episodes: a tracked show (any watched episode) whose next episode airs today, from
//   EPISODE_HOUR local time;
// - release reminders: a movie on the Watchlist that comes out today in the device's region
//   (earliest theatrical date, else digital, like the app's regionalReleaseDate), from
//   EPISODE_HOUR;
// - the weekly recap: Sundays from RECAP_HOUR, what was watched in the 7 days before and how
//   many tracked shows have an episode in the next 7.
// "Local time" is the device's own time zone, sent with its subscription. The Android app keeps
// its own local notifications and never subscribes, so nothing arrives twice.
//
// The free plan allows 50 outside requests and 10 ms of CPU per run, so each run does a
// bounded amount: it refreshes at most TMDB_PER_RUN titles in the tmdb_titles table (a few
// facts per show or movie, never whole TMDB answers), oldest first, and sends at most
// PUSHES_PER_RUN notifications. Anything left waits for the next hour; push_log keeps a
// notification from going out twice. TMDB is asked with the owner's token (TMDB_TOKEN), and
// counts against the proxy's overall daily cap; the admin page's TMDB switch pauses refreshing
// (sending carries on from what's stored).

import { pushConfigured, sendToSubscription } from './push.js';
import { getSettings } from './settings.js';
import { rateLimit } from './auth.js';

export const EPISODE_HOUR = 18;
export const RECAP_HOUR = 19;
export const RECAP_WEEKDAY = 'Sun';
export const NOTIFY_LIMITS = { tmdbPerRun: 15, pushesPerRun: 30 };
export const DEFAULT_EPISODE_RUNTIME_MINUTES = 30; // as the app's recap

const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_TIMEOUT_MS = 8000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RECAP_DAYS = 7;
const WATCHLIST_MOVIE_PREFIX = 'watchlist:movie:';
const THEATRICAL_RELEASE_TYPES = [2, 3];
const DIGITAL_RELEASE_TYPE = 4;

// Accounts with at least one device wanting these kinds (SQL, so no long lists of parameters:
// D1 allows 100 per query).
const accountsWanting = columns => `SELECT account_id FROM push_subscriptions WHERE ${columns.map(c => `${c} = 1`).join(' OR ')}`;

// ---------- Dates in a device's time zone ----------

const clockFormats = new Map();

export function validTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || !timeZone || timeZone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch (error) {
    return false;
  }
}

// { date: 'YYYY-MM-DD', hour: 0-23, weekday: 'Sun' } at `now` in `timeZone` (UTC if unknown).
export function localClock(timeZone, now) {
  const zone = validTimeZone(timeZone) ? timeZone : 'UTC';
  if (!clockFormats.has(zone)) {
    clockFormats.set(zone, new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short',
    }));
  }
  const parts = {};
  clockFormats.get(zone).formatToParts(now).forEach(p => { parts[p.type] = p.value; });
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, weekday: parts.weekday };
}

export function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// ---------- What's stored about a title ----------

// A movie's release in a region: earliest theatrical (types 2, 3), else earliest digital (4).
export function regionalRelease(releaseDates, region) {
  const entry = ((releaseDates && releaseDates.results) || []).find(r => r.iso_3166_1 === region);
  if (!entry) return null;
  const earliest = types => (entry.release_dates || [])
    .filter(d => types.includes(d.type) && d.release_date)
    .map(d => d.release_date.slice(0, 10))
    .sort()[0] || null;
  const theatrical = earliest(THEATRICAL_RELEASE_TYPES);
  if (theatrical) return { date: theatrical, kind: 'theatrical' };
  const digital = earliest([DIGITAL_RELEASE_TYPE]);
  return digital ? { date: digital, kind: 'digital' } : null;
}

// TMDB's /tv/{id} -> what's stored, plus when to ask again.
export function showFacts(show, now) {
  const next = show.next_episode_to_air;
  const data = {
    name: show.name || show.original_name || 'A show you watch',
    status: show.status || null,
    runtime: (show.episode_run_time && show.episode_run_time[0]) || (show.last_episode_to_air && show.last_episode_to_air.runtime) || null,
    next: next && next.air_date ? { date: next.air_date, season: next.season_number, episode: next.episode_number, name: next.name || null } : null,
  };
  const today = now.toISOString().slice(0, 10);
  let wait = 20 * HOUR_MS;
  if (!data.next && /^(Ended|Canceled)$/.test(data.status || '')) wait = 7 * DAY_MS;
  else if (data.next && data.next.date <= addDays(today, 2)) wait = 6 * HOUR_MS;
  return { data, nextDate: data.next ? data.next.date : null, refreshAfter: new Date(now.getTime() + wait).toISOString() };
}

// TMDB's /movie/{id}?append_to_response=release_dates -> what's stored, for these regions.
export function movieFacts(movie, regions, now) {
  const releases = {};
  regions.forEach(region => {
    const release = regionalRelease(movie.release_dates, region);
    if (release) releases[region] = release;
  });
  const today = now.toISOString().slice(0, 10);
  const upcoming = Object.values(releases).some(r => r.date >= addDays(today, -1));
  return {
    data: { title: movie.title || movie.original_title || 'A movie on your Watchlist', runtime: movie.runtime || null, releases },
    nextDate: null,
    refreshAfter: new Date(now.getTime() + (upcoming ? 2 : 7) * DAY_MS).toISOString(),
  };
}

// ---------- Messages (worded like the Android app's, notifications.js) ----------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function formatMinutes(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

export function episodeMessage(showId, show) {
  const next = show.next;
  const code = `S${next.season}E${next.episode}`;
  const realName = next.name && !/^Episode\s+\d+$/i.test(next.name.trim());
  return {
    title: show.name,
    body: `New episode today: ${code}${realName ? ` · ${next.name}` : ''}`,
    url: `detail.html?type=tv&id=${showId}`,
    tag: `ep-${showId}`,
  };
}

export function releaseMessage(movieId, movie, release) {
  return {
    title: movie.title,
    body: release.kind === 'digital' ? 'Out today to stream or buy.' : 'Out today in cinemas.',
    url: `detail.html?type=movie&id=${movieId}`,
    tag: `rel-${movieId}`,
  };
}

export function recapMessage({ episodes, movies, minutes, upcomingEpisodes }) {
  const watched = episodes || movies
    ? `This week: ${[episodes ? plural(episodes, 'episode') : null, movies ? plural(movies, 'movie') : null].filter(Boolean).join(', ')} (${formatMinutes(minutes)}).`
    : 'Nothing watched this week.';
  const coming = upcomingEpisodes ? ` Coming up: ${plural(upcomingEpisodes, 'new episode')}.` : '';
  return { title: 'Your week in Watchlog', body: watched + coming, url: 'stats.html', tag: 'recap' };
}

// ---------- Refreshing titles from TMDB ----------

async function tmdbGet(env, path, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${TMDB_API}${path}`, {
      headers: { Authorization: `Bearer ${env.TMDB_TOKEN}`, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 404) return { gone: true };
    if (!response.ok) return null;
    return { body: await response.json() };
  } catch (error) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Titles somebody's device needs, missing or due for a refresh, oldest first.
async function staleTitles(env, now, limit) {
  const since = new Date(now.getTime() - (RECAP_DAYS + 1) * DAY_MS).toISOString();
  // A show's next episode that aired two days ago (UTC) has aired everywhere: time to learn the next one.
  const passed = addDays(now.toISOString().slice(0, 10), -1);
  const { results } = await env.DB.prepare(
    `WITH wanted AS (
       SELECT DISTINCT 'tv' AS media_type, CAST(json_extract(data, '$.showId') AS INTEGER) AS id
         FROM sync_records WHERE kind = 'watched_episode' AND deleted = 0
          AND account_id IN (${accountsWanting(['notify_episodes', 'notify_recap'])})
       UNION
       SELECT 'movie', CAST(substr(record_key, ${WATCHLIST_MOVIE_PREFIX.length + 1}) AS INTEGER)
         FROM sync_records WHERE kind = 'list_item' AND deleted = 0 AND record_key LIKE '${WATCHLIST_MOVIE_PREFIX}%'
          AND account_id IN (${accountsWanting(['notify_releases'])})
       UNION
       SELECT 'movie', CAST(record_key AS INTEGER)
         FROM sync_records WHERE kind = 'watched_movie' AND deleted = 0 AND updated_at >= ?
          AND account_id IN (${accountsWanting(['notify_recap'])})
     )
     SELECT w.media_type, w.id FROM wanted w
       LEFT JOIN tmdb_titles t ON t.media_type = w.media_type AND t.tmdb_id = w.id
      WHERE w.id > 0 AND (t.tmdb_id IS NULL OR t.refresh_after <= ? OR (t.next_date IS NOT NULL AND t.next_date < ?))
      ORDER BY t.fetched_at IS NOT NULL, t.fetched_at
      LIMIT ?`
  ).bind(since, now.toISOString(), passed, limit).all();
  return results;
}

async function refreshTitles(env, now, fetchImpl) {
  if (!env.TMDB_TOKEN) return { refreshed: 0, skipped: 'no TMDB_TOKEN' };
  const settings = await getSettings(env);
  if (String(env.TMDB_PROXY || 'on').toLowerCase() === 'off' || settings.tmdbProxy === 'off') return { refreshed: 0, skipped: 'TMDB paused' };

  const stale = await staleTitles(env, now, NOTIFY_LIMITS.tmdbPerRun);
  if (!stale.length) return { refreshed: 0 };
  const { results: regionRows } = await env.DB.prepare(
    'SELECT DISTINCT region FROM push_subscriptions WHERE notify_releases = 1 AND region IS NOT NULL'
  ).all();
  const regions = regionRows.map(r => r.region);

  // Counted against the TMDB proxy's overall daily cap, like the app's own requests.
  const allowed = [];
  for (const title of stale) {
    try {
      await rateLimit(env, 'tmdb:all', settings.tmdbDailyCap, 24 * 60 * 60, now);
      allowed.push(title);
    } catch (error) {
      break;
    }
  }

  const fetched = await Promise.all(allowed.map(async ({ media_type: type, id }) => {
    const answer = await tmdbGet(env, type === 'tv' ? `/tv/${id}` : `/movie/${id}?append_to_response=release_dates`, fetchImpl);
    if (!answer) return null; // try again next hour
    const facts = answer.gone
      ? { data: { gone: true }, nextDate: null, refreshAfter: new Date(now.getTime() + 7 * DAY_MS).toISOString() }
      : type === 'tv' ? showFacts(answer.body, now) : movieFacts(answer.body, regions, now);
    return env.DB.prepare(
      `INSERT INTO tmdb_titles (media_type, tmdb_id, data, next_date, refresh_after, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (media_type, tmdb_id) DO UPDATE SET data = excluded.data, next_date = excluded.next_date,
         refresh_after = excluded.refresh_after, fetched_at = excluded.fetched_at`
    ).bind(type, id, JSON.stringify(facts.data), facts.nextDate, facts.refreshAfter, now.toISOString());
  }));
  const writes = fetched.filter(Boolean);
  if (writes.length) await env.DB.batch(writes);
  return { refreshed: writes.length, failed: allowed.length - writes.length };
}

// ---------- Working out what's due ----------

function groupBy(rows, key, value) {
  const map = new Map();
  rows.forEach(row => {
    if (!map.has(row[key])) map.set(row[key], []);
    map.get(row[key]).push(value(row));
  });
  return map;
}

async function loadTitles(env, type, ids) {
  const map = new Map();
  const list = [...new Set(ids)].filter(id => Number.isInteger(id) && id > 0);
  for (let i = 0; i < list.length; i += 90) {
    const chunk = list.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT tmdb_id, data FROM tmdb_titles WHERE media_type = ? AND tmdb_id IN (${chunk.map(() => '?').join(', ')})`
    ).bind(type, ...chunk).all();
    results.forEach(row => {
      const data = JSON.parse(row.data);
      if (!data.gone) map.set(row.tmdb_id, data);
    });
  }
  return map;
}

// The notifications due right now: [{ sub, tag, message }], in send order.
async function dueNotifications(env, subs, now) {
  const clocks = new Map(subs.map(sub => [sub.id, localClock(sub.time_zone, now)]));
  const wants = (sub, column, hour) => sub[column] === 1 && clocks.get(sub.id).hour >= hour;
  const episodeSubs = subs.filter(s => wants(s, 'notify_episodes', EPISODE_HOUR));
  const releaseSubs = subs.filter(s => wants(s, 'notify_releases', EPISODE_HOUR));
  const recapSubs = subs.filter(s => wants(s, 'notify_recap', RECAP_HOUR) && clocks.get(s.id).weekday === RECAP_WEEKDAY);
  if (!episodeSubs.length && !releaseSubs.length && !recapSubs.length) return [];

  const ids = list => [...new Set(list.map(s => s.account_id))];
  const bindIds = list => list.map(() => '?').join(', ');
  const showAccounts = ids([...episodeSubs, ...recapSubs]);
  const releaseAccounts = ids(releaseSubs);
  const recapAccounts = ids(recapSubs);

  // Each account's tracked shows and Watchlist movies.
  const showsByAccount = new Map();
  for (let i = 0; i < showAccounts.length; i += 90) {
    const chunk = showAccounts.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT account_id, CAST(json_extract(data, '$.showId') AS INTEGER) AS id FROM sync_records
        WHERE kind = 'watched_episode' AND deleted = 0 AND account_id IN (${bindIds(chunk)})`
    ).bind(...chunk).all();
    groupBy(results, 'account_id', r => r.id).forEach((v, k) => showsByAccount.set(k, v));
  }
  const watchlistByAccount = new Map();
  for (let i = 0; i < releaseAccounts.length; i += 90) {
    const chunk = releaseAccounts.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT account_id, record_key FROM sync_records
        WHERE kind = 'list_item' AND deleted = 0 AND record_key LIKE '${WATCHLIST_MOVIE_PREFIX}%' AND account_id IN (${bindIds(chunk)})`
    ).bind(...chunk).all();
    groupBy(results, 'account_id', r => Number(r.record_key.slice(WATCHLIST_MOVIE_PREFIX.length))).forEach((v, k) => watchlistByAccount.set(k, v));
  }

  // The week's watching, for recaps.
  const weekByAccount = new Map();
  const weekStart = new Date(now.getTime() - RECAP_DAYS * DAY_MS).toISOString();
  for (let i = 0; i < recapAccounts.length; i += 90) {
    const chunk = recapAccounts.slice(i, i + 90);
    const { results } = await env.DB.prepare(
      `SELECT account_id, kind, record_key, json_extract(data, '$.showId') AS show_id FROM sync_records
        WHERE kind IN ('watched_episode', 'watched_movie') AND deleted = 0 AND updated_at >= ?
          AND json_extract(data, '$.watchedAt') >= ? AND json_extract(data, '$.watchedAt') <= ?
          AND account_id IN (${bindIds(chunk)})`
    ).bind(weekStart, weekStart, now.toISOString(), ...chunk).all();
    groupBy(results, 'account_id', r => r).forEach((v, k) => weekByAccount.set(k, v));
  }

  const showIds = [];
  episodeSubs.forEach(s => showIds.push(...(showsByAccount.get(s.account_id) || [])));
  recapSubs.forEach(s => showIds.push(...(showsByAccount.get(s.account_id) || [])));
  const movieIds = [];
  releaseSubs.forEach(s => movieIds.push(...(watchlistByAccount.get(s.account_id) || [])));
  recapAccounts.forEach(a => (weekByAccount.get(a) || []).filter(r => r.kind === 'watched_movie').forEach(r => movieIds.push(Number(r.record_key))));
  const shows = await loadTitles(env, 'tv', showIds);
  const movies = await loadTitles(env, 'movie', movieIds);

  const due = [];
  episodeSubs.forEach(sub => {
    const today = clocks.get(sub.id).date;
    (showsByAccount.get(sub.account_id) || []).forEach(id => {
      const show = shows.get(id);
      if (!show || !show.next || show.next.date !== today) return;
      due.push({ sub, tag: `ep:${id}:${show.next.season}:${show.next.episode}`, message: episodeMessage(id, show) });
    });
  });
  releaseSubs.forEach(sub => {
    const today = clocks.get(sub.id).date;
    (watchlistByAccount.get(sub.account_id) || []).forEach(id => {
      const movie = movies.get(id);
      const release = movie && sub.region && movie.releases[sub.region];
      if (!release || release.date !== today) return;
      due.push({ sub, tag: `rel:${id}:${release.date}`, message: releaseMessage(id, movie, release) });
    });
  });
  recapSubs.forEach(sub => {
    const today = clocks.get(sub.id).date;
    const week = weekByAccount.get(sub.account_id) || [];
    let minutes = 0;
    let episodes = 0;
    let watchedMovies = 0;
    week.forEach(r => {
      if (r.kind === 'watched_movie') {
        watchedMovies++;
        const movie = movies.get(Number(r.record_key));
        minutes += (movie && movie.runtime) || 0;
      } else {
        episodes++;
        const show = shows.get(Number(r.show_id));
        minutes += (show && show.runtime) || DEFAULT_EPISODE_RUNTIME_MINUTES;
      }
    });
    const weekEnd = addDays(today, RECAP_DAYS);
    const upcomingEpisodes = (showsByAccount.get(sub.account_id) || []).filter(id => {
      const show = shows.get(id);
      return show && show.next && show.next.date > today && show.next.date <= weekEnd;
    }).length;
    due.push({ sub, tag: `recap:${today}`, message: recapMessage({ episodes, movies: watchedMovies, minutes, upcomingEpisodes }) });
  });
  return due;
}

// ---------- The hourly run ----------

export async function runNotifications(env, { now = new Date(), fetchImpl = fetch } = {}) {
  if (!pushConfigured(env)) return { skipped: 'push is not set up' };
  const { results: subs } = await env.DB.prepare(
    `SELECT id, account_id, endpoint, p256dh, auth, notify_episodes, notify_releases, notify_recap, time_zone, region
       FROM push_subscriptions WHERE notify_episodes = 1 OR notify_releases = 1 OR notify_recap = 1`
  ).all();
  if (!subs.length) return { subscriptions: 0 };

  const refresh = await refreshTitles(env, now, fetchImpl);

  const due = await dueNotifications(env, subs, now);
  const { results: logged } = await env.DB.prepare(
    'SELECT subscription_id, tag FROM push_log WHERE sent_at >= ?'
  ).bind(new Date(now.getTime() - (RECAP_DAYS + 1) * DAY_MS).toISOString()).all();
  const sentBefore = new Set(logged.map(r => `${r.subscription_id}|${r.tag}`));
  const toSend = due.filter(d => !sentBefore.has(`${d.sub.id}|${d.tag}`));

  let sent = 0;
  let removed = 0;
  let failed = 0;
  const gone = new Set();
  const logRows = [];
  for (const item of toSend.slice(0, NOTIFY_LIMITS.pushesPerRun)) {
    if (gone.has(item.sub.id)) continue;
    const outcome = await sendToSubscription(env, item.sub, item.message, { fetchImpl });
    if (outcome === 'sent') {
      sent++;
      logRows.push(env.DB.prepare('INSERT OR IGNORE INTO push_log (subscription_id, tag, sent_at) VALUES (?, ?, ?)').bind(item.sub.id, item.tag, now.toISOString()));
    } else if (outcome === 'gone') {
      removed++;
      gone.add(item.sub.id);
    } else {
      failed++;
    }
  }
  if (logRows.length) await env.DB.batch(logRows);
  return { subscriptions: subs.length, ...refresh, due: toSend.length, sent, removed, failed, waiting: Math.max(0, toSend.length - NOTIFY_LIMITS.pushesPerRun) };
}
