import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { MAX_CHANGES_IN, MAX_CHANGES_OUT } from '../src/routes/sync.js';
import { createEnv, createCtx, ORIGIN } from './helpers.js';

async function api(env, method, path, { token, body, ip = '203.0.113.1' } = {}) {
  const headers = { 'CF-Connecting-IP': ip };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, createCtx());
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

// One account, two devices (two sessions).
async function twoDevices(env) {
  const created = (await api(env, 'POST', '/v1/accounts', { body: { displayName: 'Ana', deviceName: 'Laptop' } })).body;
  const phone = (await api(env, 'POST', '/v1/sessions', { body: { accountKey: created.accountKey, deviceName: 'Phone' } })).body;
  return { laptop: created.token, phone: phone.token, accountId: created.account.id };
}

const sync = (env, token, since, changes) => api(env, 'POST', '/v1/sync', { token, body: { since, changes } });
const at = minutes => new Date(Date.UTC(2026, 10, 25, 12, minutes)).toISOString();
const movie = (id, minutes, extra = {}) => ({ kind: 'watched_movie', key: String(id), data: { tmdbId: id, title: `Movie ${id}` }, updatedAt: at(minutes), ...extra });

test("a change from one device reaches the other, and each device's cursor only moves forward", async () => {
  const env = createEnv();
  const { laptop, phone } = await twoDevices(env);

  const first = await sync(env, laptop, 0, [movie(550, 1)]);
  assert.equal(first.status, 200);
  assert.equal(first.body.accepted, 1);
  assert.equal(first.body.cursor, 1);
  assert.deepEqual(first.body.changes, [{ kind: 'watched_movie', key: '550', data: { tmdbId: 550, title: 'Movie 550' }, deleted: false, updatedAt: at(1) }]);

  const onPhone = await sync(env, phone, 0, []);
  assert.deepEqual(onPhone.body.changes.map(c => c.key), ['550']);
  assert.equal(onPhone.body.cursor, 1);

  const nothingNew = await sync(env, phone, onPhone.body.cursor, []);
  assert.deepEqual(nothingNew.body.changes, []);
  assert.equal(nothingNew.body.cursor, 1, 'an empty reply keeps the cursor');
});

test('deletions travel as tombstones', async () => {
  const env = createEnv();
  const { laptop, phone } = await twoDevices(env);
  await sync(env, laptop, 0, [movie(550, 1)]);
  const phoneCursor = (await sync(env, phone, 0, [])).body.cursor;

  await sync(env, laptop, 1, [{ kind: 'watched_movie', key: '550', deleted: true, updatedAt: at(2) }]);
  const reply = await sync(env, phone, phoneCursor, []);
  assert.deepEqual(reply.body.changes, [{ kind: 'watched_movie', key: '550', data: null, deleted: true, updatedAt: at(2) }]);
});

test('newest change wins, whichever device sends it last', async () => {
  const env = createEnv();
  const { laptop, phone } = await twoDevices(env);
  // The phone was offline: it watched the movie at :05, the laptop un-watched it at :10, and the
  // phone only syncs afterwards. The later change (the deletion) must stay.
  await sync(env, laptop, 0, [{ ...movie(550, 10), deleted: true, data: undefined }]);
  await sync(env, phone, 0, [movie(550, 5)]);
  const latest = (await sync(env, laptop, 0, [])).body.changes.find(c => c.key === '550');
  assert.equal(latest.deleted, true);
  assert.equal(latest.updatedAt, at(10));

  // A genuinely newer change still replaces it.
  await sync(env, phone, 0, [movie(550, 15)]);
  assert.equal((await sync(env, laptop, 0, [])).body.changes.find(c => c.key === '550').deleted, false);
});

test("a device whose clock runs ahead can't win forever", async () => {
  const env = createEnv();
  const { laptop, phone } = await twoDevices(env);
  const farFuture = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  await sync(env, laptop, 0, [{ ...movie(550, 0), updatedAt: farFuture }]);
  const stored = (await sync(env, phone, 0, [])).body.changes[0].updatedAt;
  assert.ok(Date.parse(stored) <= Date.now() + 6 * 60 * 1000, 'capped near the server clock');

  // Ten minutes later in real time, a normal change beats it.
  const later = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  await sync(env, phone, 0, [{ ...movie(550, 0), deleted: true, data: undefined, updatedAt: later }]);
  assert.equal((await sync(env, laptop, 0, [])).body.changes[0].deleted, true);
});

test('accounts never see each other\'s records, and deleting an account deletes its records', async () => {
  const env = createEnv();
  const a = await twoDevices(env);
  const b = (await api(env, 'POST', '/v1/accounts', { body: { displayName: 'Rui' }, ip: '203.0.113.9' })).body;
  await sync(env, a.laptop, 0, [movie(550, 1)]);
  assert.deepEqual((await sync(env, b.token, 0, [])).body.changes, []);

  await api(env, 'DELETE', '/v1/account', { token: a.laptop });
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM sync_records').get().n, 0);
});

test('big libraries come back in pages, with `more` until everything is through', async () => {
  const env = createEnv();
  const { laptop, phone } = await twoDevices(env);
  const total = MAX_CHANGES_OUT + 50;
  for (let start = 0; start < total; start += MAX_CHANGES_IN) {
    const batch = [];
    for (let i = start; i < Math.min(total, start + MAX_CHANGES_IN); i++) {
      batch.push({ kind: 'watched_episode', key: `1399:1:${i}`, data: { showId: 1399, season: 1, episode: i }, updatedAt: at(1) });
    }
    assert.equal((await sync(env, laptop, 0, batch)).status, 200);
  }
  let cursor = 0;
  let received = 0;
  let pages = 0;
  for (;;) {
    const reply = (await sync(env, phone, cursor, [])).body;
    received += reply.changes.length;
    cursor = reply.cursor;
    pages++;
    if (!reply.more) break;
  }
  assert.equal(received, total);
  assert.equal(pages, 2);
});

test('bad requests are refused without storing anything', async () => {
  const env = createEnv();
  const { laptop } = await twoDevices(env);
  const cases = [
    { since: -1, changes: [] },
    { since: 0, changes: 'nope' },
    { since: 0, changes: [{ ...movie(1, 1), kind: 'passwords' }] },
    { since: 0, changes: [{ ...movie(1, 1), key: '' }] },
    { since: 0, changes: [{ ...movie(1, 1), updatedAt: 'yesterday' }] },
    { since: 0, changes: [{ kind: 'watched_movie', key: '1', updatedAt: at(1) }] },
    { since: 0, changes: [{ ...movie(1, 1), data: { blob: 'x'.repeat(5000) } }] },
    { since: 0, changes: Array.from({ length: MAX_CHANGES_IN + 1 }, (_, i) => movie(i, 1)) },
  ];
  for (const body of cases) {
    const res = await api(env, 'POST', '/v1/sync', { token: laptop, body });
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM sync_records').get().n, 0);
  assert.equal((await api(env, 'POST', '/v1/sync', { body: { since: 0, changes: [] } })).status, 401, 'signed in only');
});

test('two devices syncing at once never get the same order numbers', async () => {
  const env = createEnv();
  const { laptop, phone, accountId } = await twoDevices(env);
  await Promise.all([
    sync(env, laptop, 0, [movie(1, 1), movie(2, 1)]),
    sync(env, phone, 0, [movie(3, 1), movie(4, 1)]),
  ]);
  const seqs = env.DB.sqlite.prepare('SELECT seq FROM sync_records WHERE account_id = ? ORDER BY seq').all(accountId).map(r => r.seq);
  assert.equal(new Set(seqs).size, 4);
});
