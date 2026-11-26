import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { TMDB_LIMITS, POSTERS_PER_ADDRESS_PER_HOUR } from '../src/routes/tmdb.js';
import { createEnv, createCtx, ORIGIN, signupEmail } from './helpers.js';

// TMDB itself, stubbed: records every request the Worker makes, answers with `reply`.
function stubTmdb(reply = () => new Response(JSON.stringify({ id: 550, title: 'Fight Club' }), { status: 200 })) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {} });
    return reply(String(url));
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function api(env, method, path, { token, body, ip = '203.0.113.1' } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body ? JSON.stringify(body) : undefined }), env, createCtx());
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (error) { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
}

async function signedIn(env, ip) {
  return (await api(env, 'POST', '/v1/accounts', { body: { displayName: 'Ana', ...(await signupEmail(env)) }, ip })).body.token;
}

const tmdbEnv = (overrides = {}) => createEnv({ TMDB_TOKEN: 'owner-token', TMDB_PROXY: 'on', ...overrides });

test('a signed-in account gets TMDB answers, asked with the owner token and its query string', async () => {
  const env = tmdbEnv();
  const token = await signedIn(env);
  const tmdb = stubTmdb();
  try {
    const res = await api(env, 'GET', '/v1/tmdb/movie/550?append_to_response=credits&language=pt-PT&api_key=nope', { token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { id: 550, title: 'Fight Club' });
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
    assert.equal(tmdb.calls.length, 1);
    const url = new URL(tmdb.calls[0].url);
    assert.equal(url.origin + url.pathname, 'https://api.themoviedb.org/3/movie/550');
    assert.equal(url.searchParams.get('append_to_response'), 'credits');
    assert.equal(url.searchParams.get('language'), 'pt-PT');
    assert.equal(url.searchParams.get('api_key'), null, 'a stray api_key is never passed on');
    assert.equal(tmdb.calls[0].headers.Authorization, 'Bearer owner-token');
  } finally {
    tmdb.restore();
  }
});

test('only signed-in accounts can use it, and the owner token never appears in a response', async () => {
  const env = tmdbEnv();
  const tmdb = stubTmdb();
  try {
    const anonymous = await api(env, 'GET', '/v1/tmdb/movie/550');
    assert.equal(anonymous.status, 401);
    assert.equal(tmdb.calls.length, 0);
    const token = await signedIn(env);
    const res = await api(env, 'GET', '/v1/tmdb/movie/550', { token });
    assert.ok(!JSON.stringify(res.body).includes('owner-token'));
  } finally {
    tmdb.restore();
  }
});

test('account-specific and odd TMDB paths are refused without asking TMDB', async () => {
  const env = tmdbEnv();
  const token = await signedIn(env);
  const tmdb = stubTmdb();
  try {
    for (const path of ['authentication', 'account/123/favorite', 'list/1', 'movie/../account', 'movie/550%3Cscript%3E']) {
      const res = await api(env, 'GET', `/v1/tmdb/${path}`, { token });
      assert.equal(res.status, 404, path);
    }
    assert.equal((await api(env, 'POST', '/v1/tmdb/movie/550', { token })).status, 405);
    assert.equal(tmdb.calls.length, 0);
  } finally {
    tmdb.restore();
  }
});

test("TMDB's own errors pass through; a refused owner token or TMDB overload is the server's problem", async () => {
  const env = tmdbEnv();
  const token = await signedIn(env);
  let status = 404;
  const tmdb = stubTmdb(() => new Response(JSON.stringify({ status_message: 'not found' }), { status, headers: { 'Retry-After': '3' } }));
  try {
    assert.equal((await api(env, 'GET', '/v1/tmdb/movie/999999', { token })).status, 404);
    status = 401;
    const refused = await api(env, 'GET', '/v1/tmdb/movie/1', { token });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.error, 'tmdb_unavailable');
    status = 429;
    const busy = await api(env, 'GET', '/v1/tmdb/movie/1', { token });
    assert.equal(busy.status, 503);
    assert.equal(busy.body.error, 'tmdb_busy');
  } finally {
    tmdb.restore();
  }
});

test('without the TMDB_TOKEN secret, or with TMDB_PROXY off, it says so and asks no one', async () => {
  const tmdb = stubTmdb();
  try {
    const noToken = tmdbEnv({ TMDB_TOKEN: undefined });
    const res = await api(noToken, 'GET', '/v1/tmdb/movie/550', { token: await signedIn(noToken) });
    assert.equal(res.status, 503);
    assert.equal(res.body.error, 'tmdb_unavailable');

    const paused = tmdbEnv({ TMDB_PROXY: 'off' });
    const off = await api(paused, 'GET', '/v1/tmdb/movie/550', { token: await signedIn(paused) });
    assert.equal(off.status, 503);
    assert.equal(off.body.error, 'tmdb_paused');
    assert.equal(tmdb.calls.length, 0);
  } finally {
    tmdb.restore();
  }
});

test('each account has a daily limit, and so does the whole server', async () => {
  const tmdb = stubTmdb();
  try {
    const env = tmdbEnv();
    const token = await signedIn(env);
    const day = Math.floor(Date.now() / 1000 / 86400) * 86400;
    const account = env.DB.sqlite.prepare('SELECT account_id FROM sessions').get().account_id;
    env.DB.sqlite.prepare('INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, ?)').run(`tmdb:account:${account}`, day, TMDB_LIMITS.perAccountPerDay);
    const limited = await api(env, 'GET', '/v1/tmdb/movie/550', { token });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('Retry-After')) > 0);

    const other = await signedIn(env, '203.0.113.2');
    assert.equal((await api(env, 'GET', '/v1/tmdb/movie/550', { token: other })).status, 200, 'other accounts are unaffected');

    env.DB.sqlite.prepare("UPDATE rate_limits SET count = ? WHERE key = 'tmdb:all'").run(TMDB_LIMITS.totalPerDay);
    assert.equal((await api(env, 'GET', '/v1/tmdb/movie/550', { token: other })).status, 429, 'the overall cap applies to everyone');
  } finally {
    tmdb.restore();
  }
});

test('answers are reused from the edge cache when one is available', async () => {
  const store = new Map();
  globalThis.caches = {
    default: {
      match: async req => (store.has(req.url) ? store.get(req.url).clone() : undefined),
      put: async (req, res) => { store.set(req.url, res); },
    },
  };
  const tmdb = stubTmdb();
  try {
    const env = tmdbEnv();
    const ctx = createCtx();
    const token = await signedIn(env);
    const call = () => worker.fetch(new Request(`${ORIGIN}/v1/tmdb/movie/550`, { headers: { Authorization: `Bearer ${token}` } }), env, ctx);
    assert.equal((await call()).status, 200);
    await Promise.all(ctx.waits);
    const second = await call();
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('X-Watchlog-Cache'), 'hit');
    assert.deepEqual(await second.json(), { id: 550, title: 'Fight Club' });
    assert.equal(tmdb.calls.length, 1, 'TMDB was asked once');
  } finally {
    tmdb.restore();
    delete globalThis.caches;
  }
});

// --- GET /v1/posters (the sign-in screens' mosaic) ----------------------------------------------

test('posters: no sign-in needed, only poster paths come back, adult and odd paths dropped', async () => {
  const env = tmdbEnv();
  const tmdb = stubTmdb(() => new Response(JSON.stringify({ results: [
    { id: 1, poster_path: '/a1.jpg', title: 'One', overview: 'secret plot' },
    { id: 2, poster_path: null },
    { id: 3, poster_path: '/b2.jpg', adult: true },
    { id: 4, poster_path: '/../evil' },
    { id: 5, poster_path: '/c3.jpg' },
  ] }), { status: 200 }));
  try {
    const res = await api(env, 'GET', '/v1/posters');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { posters: ['/a1.jpg', '/c3.jpg'] });
    assert.equal(tmdb.calls.length, 1);
    assert.equal(new URL(tmdb.calls[0].url).pathname, '/3/trending/movie/week');
    assert.equal(tmdb.calls[0].headers.Authorization, 'Bearer owner-token');
    assert.ok(!JSON.stringify(res.body).includes('owner-token'));
  } finally {
    tmdb.restore();
  }
});

test('posters: paused or failing TMDB just gives an empty mosaic', async () => {
  const tmdb = stubTmdb(() => new Response('{}', { status: 500 }));
  try {
    assert.deepEqual((await api(tmdbEnv({ TMDB_PROXY: 'off' }), 'GET', '/v1/posters')).body, { posters: [] });
    assert.equal(tmdb.calls.length, 0);
    assert.deepEqual((await api(tmdbEnv(), 'GET', '/v1/posters')).body, { posters: [] });
    assert.deepEqual((await api(createEnv({ TMDB_PROXY: 'on' }), 'GET', '/v1/posters')).body, { posters: [] });
  } finally {
    tmdb.restore();
  }
});

test('posters: limited per address on cache misses', async () => {
  const env = tmdbEnv();
  const tmdb = stubTmdb(() => new Response(JSON.stringify({ results: [] }), { status: 200 }));
  try {
    for (let i = 0; i < POSTERS_PER_ADDRESS_PER_HOUR; i++) {
      assert.equal((await api(env, 'GET', '/v1/posters', { ip: '198.51.100.7' })).status, 200);
    }
    assert.equal((await api(env, 'GET', '/v1/posters', { ip: '198.51.100.7' })).status, 429);
    assert.equal((await api(env, 'GET', '/v1/posters', { ip: '198.51.100.8' })).status, 200);
  } finally {
    tmdb.restore();
  }
});
