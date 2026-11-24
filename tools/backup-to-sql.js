// Turns a database backup from R2 (server/src/backup.js) into SQL that recreates the database:
//
//   node tools/backup-to-sql.js watchlog-2026-11-29T03-00-00.000Z.json > restore.sql
//   npx wrangler d1 execute <database> --remote --file restore.sql
//
// Load it into an EMPTY database (a new one, or one whose tables were dropped): it creates every
// table, then inserts every row. The d1_migrations table comes with it, so later migrations
// carry on from the right place. See docs/DEVELOPMENT.md, "Server database".

const fs = require('node:fs');

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function backupToSql(backup) {
  if (!backup || backup.format !== 'watchlog-d1-backup') throw new Error('Not a Watchlog database backup');
  const lines = [
    `-- Watchlog database restore, from the backup made ${backup.createdAt}`,
    // D1 enforces foreign keys; check them once everything is in, not row by row.
    'PRAGMA defer_foreign_keys = true;',
  ];
  for (const statement of backup.schema) lines.push(`${statement.trim().replace(/;$/, '')};`);
  for (const [table, rows] of Object.entries(backup.tables)) {
    for (const row of rows) {
      const columns = Object.keys(row);
      lines.push(`INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(', ')}) VALUES (${columns.map(c => sqlValue(row[c])).join(', ')});`);
    }
  }
  return lines.join('\n') + '\n';
}

module.exports = { backupToSql };

if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node tools/backup-to-sql.js <backup.json> > restore.sql');
    process.exit(1);
  }
  process.stdout.write(backupToSql(JSON.parse(fs.readFileSync(file, 'utf8'))));
}
