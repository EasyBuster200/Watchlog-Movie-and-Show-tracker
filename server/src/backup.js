// Weekly copy of the whole D1 database to R2 (the BACKUPS bucket), run by the Worker's Cron
// Trigger. D1's own Time Travel already allows restoring to any minute of the last 7 days (free
// plan); these copies reach further back. Restoring is in docs/DEVELOPMENT.md, "Server database".
//
// Two ways to make a copy:
//
// 1. D1's own export (when the BACKUP_API_TOKEN secret and BACKUP_DATABASE_ID var are set; the
//    normal way). Cloudflare builds a SQL dump of the database on its side - the same thing
//    `wrangler d1 export` does - and this Worker only waits for it and copies the file into R2,
//    streaming it. So the Worker's own processing time stays tiny however big the database gets
//    (the free plan gives a Cron run 10 ms of CPU, which building the dump here would outgrow).
//    The file is d1/watchlog-<ISO time>.sql, loadable with `wrangler d1 execute --file`.
//    D1 answers no other requests while it exports (seconds at this size, at 03:00 on a Sunday).
//
// 2. A JSON dump made by this Worker (exportDatabase), only when the token isn't set up. It
//    reads every table and writes d1/watchlog-<ISO time>.json:
//      { format: 'watchlog-d1-backup', version: 1, createdAt,
//        schema: [CREATE TABLE/INDEX/... statements, in creation order],
//        tables: { <name>: [ {column: value, ...}, ... ] } }
//    Cloudflare's internal tables (_cf_*) and SQLite's own (sqlite_*) are skipped; d1_migrations
//    is kept. tools/backup-to-sql.js turns one into SQL. This is what runs out of CPU on a big
//    database.
//
// The new copy is written first and the oldest are deleted only after, so a failed run never
// leaves fewer copies than before. BACKUPS_TO_KEEP copies are kept, of either kind.

export const BACKUP_PREFIX = 'd1/';
export const BACKUPS_TO_KEEP = 5;
export const BACKUP_FORMAT = 'watchlog-d1-backup';

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
// D1 cancels an export that isn't polled, so poll steadily. A free-plan Worker run may make 50
// requests to other servers: one for the account, the polls, one download.
export const EXPORT_POLL_MS = 2000;
export const EXPORT_MAX_POLLS = 40;

function isOwnTable(name) {
  return !name.startsWith('sqlite_') && !name.startsWith('_cf_');
}

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// ---------- 2. The JSON dump (fallback) ----------

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

export function backupKey(now, extension = 'json') {
  // Colons aren't welcome in file names; the ISO time keeps keys in date order.
  return `${BACKUP_PREFIX}watchlog-${now.toISOString().replace(/:/g, '-')}.${extension}`;
}

async function saveJsonDump(env, now) {
  const backup = await exportDatabase(env.DB, now);
  const body = JSON.stringify(backup);
  const key = backupKey(now, 'json');
  await env.BACKUPS.put(key, body, { httpMetadata: { contentType: 'application/json' } });
  const rows = Object.values(backup.tables).reduce((sum, list) => sum + list.length, 0);
  return { key, method: 'json', bytes: body.length, tables: Object.keys(backup.tables).length, rows };
}

// ---------- 1. D1's own export ----------

export function d1ExportConfigured(env) {
  return Boolean(env.BACKUP_API_TOKEN && env.BACKUP_DATABASE_ID);
}

async function cloudflareApi(env, fetchImpl, path, body) {
  const response = await fetchImpl(`${CLOUDFLARE_API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${env.BACKUP_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    // Not JSON: reported below with the status.
  }
  if (!response.ok || !data || data.success === false) {
    const reasons = data && Array.isArray(data.errors) ? data.errors.map(e => e.message).join('; ') : '';
    throw new Error(`Cloudflare API ${path} answered ${response.status}${reasons ? `: ${reasons}` : ''}`);
  }
  return data.result;
}

// The account the database is in: BACKUP_ACCOUNT_ID if set, else the one account the token
// can see.
async function accountId(env, fetchImpl) {
  if (env.BACKUP_ACCOUNT_ID) return env.BACKUP_ACCOUNT_ID;
  const accounts = await cloudflareApi(env, fetchImpl, '/accounts');
  if (!Array.isArray(accounts) || accounts.length !== 1) {
    throw new Error(`The backup token sees ${Array.isArray(accounts) ? accounts.length : 'no'} accounts; set BACKUP_ACCOUNT_ID`);
  }
  return accounts[0].id;
}

// Starts an export and polls until D1 has the file. Resolves its download address (valid for an
// hour, no sign-in needed).
export async function requestD1Export(env, { fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const account = await accountId(env, fetchImpl);
  const path = `/accounts/${account}/d1/database/${env.BACKUP_DATABASE_ID}/export`;
  let bookmark;
  for (let poll = 0; poll < EXPORT_MAX_POLLS; poll++) {
    const result = await cloudflareApi(env, fetchImpl, path, { output_format: 'polling', current_bookmark: bookmark });
    if (result.status === 'complete') {
      if (!result.result || !result.result.signed_url) throw new Error('D1 export finished without a file');
      return result.result.signed_url;
    }
    if (result.status === 'error') throw new Error(`D1 export failed: ${result.error || 'no reason given'}`);
    bookmark = result.at_bookmark || bookmark;
    await sleep(EXPORT_POLL_MS);
  }
  throw new Error(`D1 export didn't finish after ${EXPORT_MAX_POLLS} checks`);
}

// Copies the export into R2 without holding it in memory or parsing it: the download is streamed
// straight into the bucket (R2 needs to know the length of a stream up front).
async function saveD1Export(env, now, options) {
  const fetchImpl = options.fetchImpl || fetch;
  const url = await requestD1Export(env, options);
  const download = await fetchImpl(url);
  if (!download.ok) throw new Error(`Downloading the D1 export failed: ${download.status}`);
  const key = backupKey(now, 'sql');
  const meta = { httpMetadata: { contentType: 'application/sql' } };
  const length = Number(download.headers.get('Content-Length'));
  if (length > 0 && download.body && typeof FixedLengthStream === 'function') {
    const { readable, writable } = new FixedLengthStream(length);
    await Promise.all([download.body.pipeTo(writable), env.BACKUPS.put(key, readable, meta)]);
    return { key, method: 'd1-export', bytes: length };
  }
  const text = await download.text();
  await env.BACKUPS.put(key, text, meta);
  return { key, method: 'd1-export', bytes: text.length };
}

// ---------- The weekly run ----------

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

// `fetchImpl` and `sleep` are for tests.
export async function runBackup(env, { now = new Date(), keep = BACKUPS_TO_KEEP, fetchImpl, sleep } = {}) {
  if (!env.DB || !env.BACKUPS) throw new Error('Backups need both the DB and BACKUPS bindings');
  let saved;
  if (d1ExportConfigured(env)) {
    saved = await saveD1Export(env, now, { fetchImpl, sleep });
  } else {
    console.warn('BACKUP_API_TOKEN or BACKUP_DATABASE_ID is not set: making a JSON backup in the Worker, which a big database can outgrow (docs/DEVELOPMENT.md, "Server database")');
    saved = await saveJsonDump(env, now);
  }

  const keys = await listBackupKeys(env.BACKUPS);
  const old = keys.filter(k => k !== saved.key).slice(0, Math.max(0, keys.length - keep));
  if (old.length) await env.BACKUPS.delete(old);
  return { ...saved, deleted: old };
}
