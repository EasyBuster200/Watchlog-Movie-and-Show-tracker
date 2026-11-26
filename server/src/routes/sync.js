// Sync (roadmap Phase 4): POST /v1/sync, one request that both sends this device's changes and
// returns everything changed since this device last asked.
//
// Request:  { since: <cursor, 0 the first time>, changes: [{ kind, key, data, deleted, updatedAt }] }
// Response: { cursor, changes: [{ kind, key, data, deleted, updatedAt }], more, accepted, serverTime,
//             admin? }   admin: { pendingRequests } only for the owner, so every page load
//             tells the owner's app about sign-up requests without an extra request
//
// - Every record is one row of sync_records (migration 0003). A deletion is kept as a tombstone
//   (deleted: true, data: null), so devices that were offline still learn about it.
// - Newest wins, per record: a change is stored only if its updatedAt is later than what's
//   stored. updatedAt is the device's clock, capped at the server's clock (+ a little), so a
//   device whose clock runs ahead can't win every argument. The reply carries serverTime, so the
//   app can stamp its changes with the server's clock instead of its own (public/scripts/sync.js).
// - Order: each accepted change gets the next number (seq) in the account's sequence
//   (accounts.sync_seq, bumped atomically). A device remembers the highest seq it has seen (the
//   cursor) and asks for everything after it. Its own changes come back too; applying them again
//   changes nothing.
// - Big libraries go in pieces: at most MAX_CHANGES_IN per request, MAX_CHANGES_OUT per reply
//   (`more` says to ask again). Keeps each request well inside the free plan's 10 ms of CPU.

import { route, json, readJson, ApiError } from '../router.js';
import { requireAuth, rateLimit } from '../auth.js';
import { isAdmin } from '../admin.js';

export const SYNC_KINDS = ['watched_movie', 'watched_episode', 'favorite', 'list', 'list_item', 'prefs'];
export const MAX_CHANGES_IN = 200;
export const MAX_CHANGES_OUT = 500;
const MAX_BODY_BYTES = 128 * 1024;
const MAX_KEY_LENGTH = 200;
const MAX_DATA_BYTES = 2048;
const CLOCK_ALLOWANCE_MS = 5 * 60 * 1000;
export const SYNC_LIMIT = [600, 3600]; // requests per account per hour

function invalid(message) {
  return new ApiError(400, 'invalid_changes', message);
}

// Checks one incoming change and returns it in the shape that's stored.
function cleanChange(change, now) {
  if (!change || typeof change !== 'object') throw invalid('Each change must be an object.');
  const { kind, key, deleted = false } = change;
  if (!SYNC_KINDS.includes(kind)) throw invalid(`Unknown kind: ${String(kind).slice(0, 40)}.`);
  if (typeof key !== 'string' || !key || key.length > MAX_KEY_LENGTH) throw invalid('Each change needs a key.');
  const time = Date.parse(change.updatedAt);
  if (!Number.isFinite(time)) throw invalid('Each change needs an updatedAt time.');
  const updatedAt = new Date(Math.min(time, now + CLOCK_ALLOWANCE_MS)).toISOString();
  let data = null;
  if (!deleted) {
    if (!change.data || typeof change.data !== 'object' || Array.isArray(change.data)) throw invalid('A change needs data unless it is a deletion.');
    data = JSON.stringify(change.data);
    if (data.length > MAX_DATA_BYTES) throw invalid('A record is too large.');
  }
  return { kind, key, data, deleted: deleted ? 1 : 0, updatedAt };
}

function changeJson(row) {
  return {
    kind: row.kind,
    key: row.record_key,
    data: row.data ? JSON.parse(row.data) : null,
    deleted: Boolean(row.deleted),
    updatedAt: row.updated_at,
  };
}

route('POST', '/sync', async ({ request, env }) => {
  const { account } = await requireAuth(request, env);
  await rateLimit(env, `sync:account:${account.id}`, SYNC_LIMIT[0], SYNC_LIMIT[1]);
  const body = await readJson(request, { maxBytes: MAX_BODY_BYTES });

  const since = body.since === undefined ? 0 : Number(body.since);
  if (!Number.isInteger(since) || since < 0) throw invalid('since must be a cursor from an earlier sync, or 0.');
  const incoming = body.changes === undefined ? [] : body.changes;
  if (!Array.isArray(incoming)) throw invalid('changes must be a list.');
  if (incoming.length > MAX_CHANGES_IN) throw invalid(`At most ${MAX_CHANGES_IN} changes per request.`);
  const now = Date.now();
  const changes = incoming.map(change => cleanChange(change, now));

  if (changes.length) {
    // Reserve seq numbers base+1 .. base+n for this request, atomically.
    const bumped = await env.DB.prepare('UPDATE accounts SET sync_seq = sync_seq + ? WHERE id = ? RETURNING sync_seq')
      .bind(changes.length, account.id).first();
    const base = bumped.sync_seq - changes.length;
    await env.DB.batch(changes.map((c, i) => env.DB.prepare(
      `INSERT INTO sync_records (account_id, kind, record_key, data, deleted, updated_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, kind, record_key) DO UPDATE SET
         data = excluded.data, deleted = excluded.deleted, updated_at = excluded.updated_at, seq = excluded.seq
       WHERE excluded.updated_at > sync_records.updated_at`
    ).bind(account.id, c.kind, c.key, c.data, c.deleted, c.updatedAt, base + i + 1)));
  }

  const { results } = await env.DB.prepare(
    `SELECT kind, record_key, data, deleted, updated_at, seq FROM sync_records
      WHERE account_id = ? AND seq > ? ORDER BY seq LIMIT ?`
  ).bind(account.id, since, MAX_CHANGES_OUT + 1).all();
  const more = results.length > MAX_CHANGES_OUT;
  const page = more ? results.slice(0, MAX_CHANGES_OUT) : results;
  const cursor = page.length ? page[page.length - 1].seq : since;
  const reply = { cursor, changes: page.map(changeJson), more, accepted: changes.length, serverTime: new Date().toISOString() };
  if (isAdmin(env, account.id)) {
    const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts WHERE status = 'pending'").first();
    reply.admin = { pendingRequests: pending ? pending.n : 0 };
  }
  return json(reply);
});
