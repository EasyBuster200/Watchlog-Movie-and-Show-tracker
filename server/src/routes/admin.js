// The admin page's API (roadmap Phase 8 part 1), for the owner only (admin.js: ADMIN_ACCOUNT_IDS).
// Every change is written to the audit log. People's libraries are never shown here: counts and
// metadata only (the roadmap's privacy promise).
//
//   GET    /v1/admin/overview               counts, settings, today's TMDB use, the last backup
//   GET    /v1/admin/users                  every account, sign-up requests first
//   POST   /v1/admin/users/:id/approve      a request becomes an account
//   POST   /v1/admin/users/:id/suspend      signed out everywhere, can't sign in
//   POST   /v1/admin/users/:id/unsuspend
//   POST   /v1/admin/users/:id/sign-out     signs out all its devices
//   DELETE /v1/admin/users/:id              deletes it (also how a request is declined)
//   GET    /v1/admin/invites                POST { note, days } -> { invite, code }
//   DELETE /v1/admin/invites/:id            an unused one
//   GET    /v1/admin/settings               PATCH { signupMode, tmdbProxy, tmdbDailyCap }
//   GET    /v1/admin/audit                  the last 100 actions
//
// Admin accounts themselves can't be suspended, signed out or deleted from here (so the owner
// can't lock themself out by a mis-tap).

import { route, json, noContent, readJson, ApiError } from '../router.js';
import { generatePairingCode, pairingCodeData, hashInviteCode, nowIso, cleanName } from '../auth.js';
import { requireAdmin, isAdmin, adminIds, audit } from '../admin.js';
import { getSettings, updateSettings } from '../settings.js';
import { pushConfigured } from '../push.js';

const DAY = 24 * 60 * 60;
const INVITE_DAYS_DEFAULT = 7;
const INVITE_DAYS_MAX = 30;

const dayWindow = (now = Date.now()) => Math.floor(now / 1000 / DAY) * DAY;
const daysAgo = days => new Date(Date.now() - days * DAY * 1000).toISOString();

async function lastBackup(env) {
  if (!env.BACKUPS) return null;
  try {
    let newest = null;
    let cursor;
    do {
      const page = await env.BACKUPS.list({ prefix: 'd1/', cursor });
      for (const object of page.objects) if (!newest || object.key > newest.key) newest = object;
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    if (!newest) return null;
    return { key: newest.key, at: newest.uploaded ? new Date(newest.uploaded).toISOString() : null, bytes: newest.size ?? null };
  } catch (error) {
    return null;
  }
}

route('GET', '/admin/overview', async ({ request, env }) => {
  await requireAdmin(request, env);
  const now = nowIso();
  const [statuses, active, devices, records, tmdb, invites] = await Promise.all([
    env.DB.prepare('SELECT status, COUNT(*) AS n FROM accounts GROUP BY status').all(),
    env.DB.prepare('SELECT COUNT(DISTINCT account_id) AS n FROM sessions WHERE last_used_at > ?').bind(daysAgo(7)).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?').bind(now).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM sync_records WHERE deleted = 0').first(),
    env.DB.prepare("SELECT count FROM rate_limits WHERE key = 'tmdb:all' AND window_start = ?").bind(dayWindow()).first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM invites WHERE used_at IS NULL AND expires_at > ?').bind(now).first(),
  ]);
  const accounts = { active: 0, pending: 0, suspended: 0 };
  statuses.results.forEach(r => { accounts[r.status] = r.n; });
  return json({
    accounts,
    activeLast7Days: active ? active.n : 0,
    devices: devices ? devices.n : 0,
    syncRecords: records ? records.n : 0,
    tmdbToday: tmdb ? tmdb.count : 0,
    openInvites: invites ? invites.n : 0,
    settings: await getSettings(env, { fresh: true }),
    lastBackup: await lastBackup(env),
    push: pushConfigured(env),
    environment: env.ENVIRONMENT || null,
  });
});

route('GET', '/admin/users', async ({ request, env }) => {
  await requireAdmin(request, env);
  const now = nowIso();
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.display_name AS displayName, a.email, a.status, a.created_at AS createdAt, a.request_note AS requestNote,
            (SELECT MAX(last_used_at) FROM sessions s WHERE s.account_id = a.id) AS lastSeen,
            (SELECT COUNT(*) FROM sessions s WHERE s.account_id = a.id AND s.expires_at > ?) AS devices,
            (SELECT COUNT(*) FROM sync_records r WHERE r.account_id = a.id AND r.deleted = 0) AS records,
            (SELECT count FROM rate_limits l WHERE l.key = 'tmdb:account:' || a.id AND l.window_start = ?) AS tmdbToday
       FROM accounts a
      ORDER BY a.status = 'pending' DESC, a.created_at DESC
      LIMIT 1000`
  ).bind(now, dayWindow()).all();
  return json({ users: results.map(u => ({ ...u, tmdbToday: u.tmdbToday || 0, isAdmin: isAdmin(env, u.id) })) });
});

async function targetAccount(env, id) {
  const row = await env.DB.prepare('SELECT id, display_name AS displayName, status FROM accounts WHERE id = ?').bind(id).first();
  if (!row) throw new ApiError(404, 'not_found', 'There is no such account.');
  if (isAdmin(env, row.id)) throw new ApiError(400, 'is_admin', "That's an admin account; change it in ADMIN_ACCOUNT_IDS first.");
  return row;
}

route('POST', '/admin/users/:id/approve', async ({ request, env, params }) => {
  const { account: admin } = await requireAdmin(request, env);
  const target = await targetAccount(env, params.id);
  if (target.status !== 'pending') throw new ApiError(400, 'not_pending', 'That account is not waiting for approval.');
  await env.DB.prepare("UPDATE accounts SET status = 'active' WHERE id = ?").bind(target.id).run();
  await audit(env, admin.id, 'approve', target.id, { name: target.displayName });
  return json({ ok: true });
});

route('POST', '/admin/users/:id/suspend', async ({ request, env, params }) => {
  const { account: admin } = await requireAdmin(request, env);
  const target = await targetAccount(env, params.id);
  await env.DB.batch([
    env.DB.prepare("UPDATE accounts SET status = 'suspended' WHERE id = ?").bind(target.id),
    env.DB.prepare('DELETE FROM sessions WHERE account_id = ?').bind(target.id),
    env.DB.prepare('DELETE FROM pairing_codes WHERE account_id = ?').bind(target.id),
  ]);
  await audit(env, admin.id, 'suspend', target.id, { name: target.displayName });
  return json({ ok: true });
});

route('POST', '/admin/users/:id/unsuspend', async ({ request, env, params }) => {
  const { account: admin } = await requireAdmin(request, env);
  const target = await targetAccount(env, params.id);
  if (target.status !== 'suspended') throw new ApiError(400, 'not_suspended', 'That account is not suspended.');
  await env.DB.prepare("UPDATE accounts SET status = 'active' WHERE id = ?").bind(target.id).run();
  await audit(env, admin.id, 'unsuspend', target.id, { name: target.displayName });
  return json({ ok: true });
});

route('POST', '/admin/users/:id/sign-out', async ({ request, env, params }) => {
  const { account: admin } = await requireAdmin(request, env);
  const target = await targetAccount(env, params.id);
  const result = await env.DB.prepare('DELETE FROM sessions WHERE account_id = ?').bind(target.id).run();
  await audit(env, admin.id, 'sign-out', target.id, { name: target.displayName, devices: (result.meta && result.meta.changes) || 0 });
  return json({ ok: true });
});

route('DELETE', '/admin/users/:id', async ({ request, env, params }) => {
  const { account: admin } = await requireAdmin(request, env);
  const target = await targetAccount(env, params.id);
  await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(target.id).run();
  await audit(env, admin.id, target.status === 'pending' ? 'decline' : 'delete', target.id, { name: target.displayName });
  return noContent();
});

// ---------- Invites ----------

function inviteJson(row) {
  return { id: row.id, note: row.note, createdAt: row.createdAt, expiresAt: row.expiresAt, usedAt: row.usedAt, usedBy: row.usedByName || null };
}

route('GET', '/admin/invites', async ({ request, env }) => {
  await requireAdmin(request, env);
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.note, i.created_at AS createdAt, i.expires_at AS expiresAt, i.used_at AS usedAt, a.display_name AS usedByName
       FROM invites i LEFT JOIN accounts a ON a.id = i.used_by
      ORDER BY i.created_at DESC LIMIT 200`
  ).all();
  return json({ invites: results.map(inviteJson) });
});

route('POST', '/admin/invites', async ({ request, env }) => {
  const { account: admin } = await requireAdmin(request, env);
  const body = await readJson(request);
  const days = body.days === undefined ? INVITE_DAYS_DEFAULT : Number(body.days);
  if (!Number.isInteger(days) || days < 1 || days > INVITE_DAYS_MAX) throw new ApiError(400, 'invalid_days', `An invite lasts 1 to ${INVITE_DAYS_MAX} days.`);
  const note = cleanName(body.note, { max: 60 });
  const code = generatePairingCode();
  const now = new Date();
  const invite = { id: crypto.randomUUID(), note, createdAt: nowIso(now), expiresAt: new Date(now.getTime() + days * DAY * 1000).toISOString(), usedAt: null };
  await env.DB.prepare('INSERT INTO invites (id, code_hash, note, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .bind(invite.id, await hashInviteCode(pairingCodeData(code)), note, invite.createdAt, invite.expiresAt).run();
  await audit(env, admin.id, 'invite.create', invite.id, { note, days });
  return json({ invite: inviteJson(invite), code }, 201);
});

route('DELETE', '/admin/invites/:id', async ({ request, env, params }) => {
  const { account: admin } = await requireAdmin(request, env);
  const result = await env.DB.prepare('DELETE FROM invites WHERE id = ? AND used_at IS NULL').bind(params.id).run();
  if (!result.meta || !result.meta.changes) throw new ApiError(404, 'not_found', 'No unused invite has that id.');
  await audit(env, admin.id, 'invite.cancel', params.id);
  return noContent();
});

// ---------- Settings and the log ----------

route('GET', '/admin/settings', async ({ request, env }) => {
  await requireAdmin(request, env);
  return json({ settings: await getSettings(env, { fresh: true }) });
});

route('PATCH', '/admin/settings', async ({ request, env }) => {
  const { account: admin } = await requireAdmin(request, env);
  const body = await readJson(request);
  let result;
  try {
    result = await updateSettings(env, body);
  } catch (message) {
    if (typeof message === 'string') throw new ApiError(400, 'invalid_setting', message);
    throw message;
  }
  if (Object.keys(result.changed).length) await audit(env, admin.id, 'settings', null, result.changed);
  return json({ settings: result.settings });
});

route('GET', '/admin/audit', async ({ request, env }) => {
  await requireAdmin(request, env);
  const { results } = await env.DB.prepare(
    `SELECT l.id, l.at, l.admin_id AS adminId, l.action, l.target, l.details, a.display_name AS targetName
       FROM audit_log l LEFT JOIN accounts a ON a.id = l.target
      ORDER BY l.id DESC LIMIT 100`
  ).all();
  return json({
    entries: results.map(e => ({ ...e, details: e.details ? JSON.parse(e.details) : null })),
    admins: adminIds(env).length,
  });
});
