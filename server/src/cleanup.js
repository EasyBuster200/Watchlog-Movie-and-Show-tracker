// Weekly housekeeping, run by the Cron Trigger before the backup (index.js): deletes expired
// sessions and pairing codes, and rate-limit counters from windows that are over. Nothing here
// is needed for correctness (expired rows are already refused when used); it keeps the
// database, and so its backups, small.

const RATE_LIMIT_KEEP_SECONDS = 2 * 24 * 60 * 60; // longer than any rate-limit window

export async function runCleanup(env, now = new Date()) {
  const iso = now.toISOString();
  const oldestWindow = Math.floor(now.getTime() / 1000) - RATE_LIMIT_KEEP_SECONDS;
  const [sessions, codes, limits] = await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(iso),
    env.DB.prepare('DELETE FROM pairing_codes WHERE expires_at <= ?').bind(iso),
    env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(oldestWindow),
  ]);
  const changes = result => (result && result.meta && result.meta.changes) || 0;
  return { sessions: changes(sessions), pairingCodes: changes(codes), rateLimits: changes(limits) };
}
