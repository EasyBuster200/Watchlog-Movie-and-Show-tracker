// The TMDB proxy (roadmap Phase 5, pulled into Phase 3 with the user): online accounts get movie
// and show information through GET /v1/tmdb/<TMDB path>, and the Worker asks TMDB with the
// owner's token, a Worker secret (TMDB_TOKEN) that never reaches the app. Offline profiles still
// call TMDB directly with their own token (public/scripts/localApi.js).
//
// - Signed in only (a session token), GET only, read-only TMDB paths only.
// - Limits, so strangers can't run up the owner's quota: per account per day, and overall per
//   day (which also protects the Worker's free 100,000 requests a day). Both are D1 counters,
//   two small writes per request. Sign-up is open for now; it must become invite-only before
//   online accounts are shown to everyone (decided with the user).
// - TMDB_PROXY = "off" (a wrangler.jsonc var) pauses it without a code change.
// - Responses are kept in Cloudflare's edge cache for a while where that's available (the docs
//   don't promise it on workers.dev; without it, every request goes to TMDB).
// - The response body is passed through untouched (no parsing: cheap on the 10 ms CPU limit);
//   the app strips adult titles itself, as it does for direct calls.

import { route, ApiError } from '../router.js';
import { requireAuth, rateLimit } from '../auth.js';

const TMDB_API = 'https://api.themoviedb.org/3';
const DAY = 24 * 60 * 60;
const TMDB_TIMEOUT_MS = 8000;

export const TMDB_LIMITS = {
  perAccountPerDay: 5000,
  totalPerDay: 40000,
};

// Paths are TMDB's own: letters, digits, '-', '_', '.', '/'. Account-specific endpoints are refused.
const SAFE_PATH = /^[A-Za-z0-9_\-./]+$/;
const BLOCKED = /^(authentication|account|guest_session|list|session)(\/|$)/;

// How long a TMDB answer may be reused, in seconds.
function cacheSeconds(path) {
  if (/^(configuration|genre|watch\/providers)(\/|$)/.test(path)) return DAY;
  if (/^(movie|tv|person|collection)\/\d+$/.test(path)) return 6 * 3600;
  if (/^search\//.test(path)) return 10 * 60;
  return 30 * 60;
}

function edgeCache() {
  return typeof caches !== 'undefined' && caches.default ? caches.default : null;
}

function jsonBody(body, status, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

route('GET', '/tmdb/*', async ({ request, env, ctx, params }) => {
  if (String(env.TMDB_PROXY || 'on').toLowerCase() === 'off') {
    throw new ApiError(503, 'tmdb_paused', 'Movie and show information is paused right now. Try again later.');
  }
  if (!env.TMDB_TOKEN) {
    console.error('TMDB proxy: the TMDB_TOKEN secret is not set');
    throw new ApiError(503, 'tmdb_unavailable', "Movie and show information isn't available right now.");
  }
  const { account } = await requireAuth(request, env);

  const path = params.path;
  if (!SAFE_PATH.test(path) || path.includes('..') || BLOCKED.test(path)) {
    throw new ApiError(404, 'not_found', 'There is nothing at this address.');
  }

  await rateLimit(env, `tmdb:account:${account.id}`, TMDB_LIMITS.perAccountPerDay, DAY);
  await rateLimit(env, 'tmdb:all', TMDB_LIMITS.totalPerDay, DAY);

  const target = new URL(`${TMDB_API}/${path}`);
  new URL(request.url).searchParams.forEach((value, name) => {
    if (name !== 'api_key') target.searchParams.append(name, value);
  });
  // The cache key is the TMDB address alone: the same answer serves every account.
  const cacheKey = new Request(target.toString());
  const cache = edgeCache();
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return jsonBody(await hit.text(), 200, { 'X-Watchlog-Cache': 'hit' });
    } catch (error) { /* a cache problem only costs a TMDB request */ }
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      headers: { accept: 'application/json', Authorization: `Bearer ${env.TMDB_TOKEN}` },
      signal: AbortSignal.timeout(TMDB_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ApiError(502, 'tmdb_unreachable', "Couldn't reach TMDB. Try again in a moment.");
  }

  if (upstream.status === 401) {
    // TMDB refused the owner's token: a server problem, not the person's.
    console.error('TMDB proxy: TMDB rejected TMDB_TOKEN');
    throw new ApiError(503, 'tmdb_unavailable', "Movie and show information isn't available right now.");
  }
  if (upstream.status === 429) {
    throw new ApiError(503, 'tmdb_busy', 'TMDB is busy. Try again in a moment.', { retryAfter: Number(upstream.headers.get('Retry-After')) || 10 });
  }
  const body = await upstream.text();
  if (!upstream.ok) return jsonBody(body || '{}', upstream.status);

  if (cache) {
    const stored = new Response(body, { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${cacheSeconds(path)}` } });
    ctx.waitUntil(cache.put(cacheKey, stored).catch(() => {}));
  }
  return jsonBody(body, 200);
});
