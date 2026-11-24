// Weekly copy of the whole D1 database to R2 (the BACKUPS bucket), run by the Worker's Cron
// Trigger. D1's own Time Travel already allows restoring to any minute of the last 7 days (free
// plan); these copies reach further back. tools/backup-to-sql.js turns one into SQL that
// `wrangler d1 execute` can load (see docs/DEVELOPMENT.md, "Server database").
//
// A copy is one JSON file, d1/watchlog-<ISO time>.json:
//   { format: 'watchlog-d1-backup', version: 1, createdAt,
//     schema: [CREATE TABLE/INDEX/... statements, in creation order],
//     tables: { <name>: [ {column: value, ...}, ... ] } }
// Cloudflare's internal tables (_cf_*) and SQLite's own (sqlite_*) are skipped; d1_migrations is
// kept, so a restored database knows which migrations it already has. Values are what JSON can
// hold (text, numbers, null): don't add BLOB columns without changing this format.
//
// The new copy is written first and the oldest are deleted only after, so a failed run never
// leaves fewer copies than before. BACKUPS_TO_KEEP copies are kept.

export const BACKUP_PREFIX = 'd1/';
export const BACKUPS_TO_KEEP = 5;
export const BACKUP_FORMAT = 'watchlog-d1-backup';

function isOwnTable(name) {
  return !name.startsWith('sqlite_') && !name.startsWith('_cf_');
}

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

export async function exportDatabase(db, now = new Date()) {
  const { results: objects } = await db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid"
  ).all();
  const own = objects.filter(o => isOwnTable(o.tbl_name) && isOwnTable(o.name));
  const tables = {};
  for (const object of own.filter(o => o.type === 'table')) {
    const { results } = await db.prepare(`SELECT * FROM ${quoteIdentifier(object.name)}`).all();
    tables[object.name] = results;
  }
  return {
    format: BACKUP_FORMAT,
    version: 1,
    createdAt: now.toISOString(),
    schema: own.map(o => o.sql),
    tables,
  };
}

export function backupKey(now) {
  // Colons aren't welcome in file names; the ISO time keeps keys in date order.
  return `${BACKUP_PREFIX}watchlog-${now.toISOString().replace(/:/g, '-')}.json`;
}

async function listBackupKeys(bucket) {
  const keys = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix: BACKUP_PREFIX, cursor });
    keys.push(...page.objects.map(o => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return keys.sort();
}

export async function runBackup(env, { now = new Date(), keep = BACKUPS_TO_KEEP } = {}) {
  if (!env.DB || !env.BACKUPS) throw new Error('Backups need both the DB and BACKUPS bindings');
  const backup = await exportDatabase(env.DB, now);
  const body = JSON.stringify(backup);
  const key = backupKey(now);
  await env.BACKUPS.put(key, body, { httpMetadata: { contentType: 'application/json' } });

  const keys = await listBackupKeys(env.BACKUPS);
  const old = keys.filter(k => k !== key).slice(0, Math.max(0, keys.length - keep));
  if (old.length) await env.BACKUPS.delete(old);

  const rows = Object.values(backup.tables).reduce((sum, list) => sum + list.length, 0);
  return { key, bytes: body.length, tables: Object.keys(backup.tables).length, rows, deleted: old };
}
