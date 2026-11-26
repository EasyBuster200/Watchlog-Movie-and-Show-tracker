// Weekly housekeeping, run by the Cron Trigger before the backup (index.js): deletes expired
// sessions and pairing codes, rate-limit counters from windows that are over, the record of
// notifications sent (push_log) after two weeks, and stored TMDB facts nobody has needed for a
// month (notifications.js). Nothing here
// is needed for correctness (expired rows are already refused when used); it keeps the
// database, and so its backups, small.

const RATE_LIMIT_KEEP_SECONDS = 2 * 24 * 60 * 60; // longer than any rate-limit window
const DAY_MS = 24 * 60 * 60 * 1000;
const PUSH_LOG_KEEP_DAYS = 14;
const TITLES_KEEP_DAYS = 30;

export async function runCleanup(env, now = new Date()) {
  const iso = now.toISOString();
  const oldestWindow = Math.floor(now.getTime() / 1000) - RATE_LIMIT_KEEP_SECONDS;
  const ago = days => new Date(now.getTime() - days * DAY_MS).toISOString();
  const [sessions, codes, limits, pushLog, titles] = await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(iso),
    env.DB.prepare('DELETE FROM pairing_codes WHERE expires_at <= ?').bind(iso),
    env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(oldestWindow),
    env.DB.prepare('DELETE FROM push_log WHERE sent_at < ?').bind(ago(PUSH_LOG_KEEP_DAYS)),
    env.DB.prepare('DELETE FROM tmdb_titles WHERE fetched_at < ?').bind(ago(TITLES_KEEP_DAYS)),
  ]);
  const changes = result => (result && result.meta && result.meta.changes) || 0;
  return { sessions: changes(sessions), pairingCodes: changes(codes), rateLimits: changes(limits), pushLog: changes(pushLog), titles: changes(titles) };
}
