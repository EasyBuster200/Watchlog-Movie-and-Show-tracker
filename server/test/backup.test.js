import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { runBackup, exportDatabase, backupKey, BACKUPS_TO_KEEP } from '../src/backup.js';
import { createEnv, createD1, createR2, createCtx } from './helpers.js';

const require = createRequire(import.meta.url);
const { backupToSql } = require('../../tools/backup-to-sql.js');

const plain = value => JSON.parse(JSON.stringify(value));

function seededD1() {
  const d1 = createD1();
  d1.sqlite.exec(`
    CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT);
    CREATE TABLE pets (id INTEGER PRIMARY KEY, owner INTEGER NOT NULL REFERENCES people(id), name TEXT);
    CREATE INDEX pets_owner ON pets(owner);
    INSERT INTO people (id, name, note) VALUES (1, 'Ana', 'it''s "quoted"'), (2, 'Rui', NULL);
    INSERT INTO pets (id, owner, name) VALUES (1, 2, 'Bolacha');
    CREATE TABLE _cf_internal (x);
    INSERT INTO _cf_internal VALUES (1);
  `);
  return d1;
}

test('a backup has every table of ours with its rows and schema, and skips Cloudflare internals', async () => {
  const backup = await exportDatabase(seededD1(), new Date('2026-11-29T03:00:00Z'));
  assert.equal(backup.format, 'watchlog-d1-backup');
  assert.equal(backup.createdAt, '2026-11-29T03:00:00.000Z');
  for (const table of ['app_meta', 'd1_migrations', 'people', 'pets']) assert.ok(table in backup.tables, table);
  assert.equal(backup.tables.people.length, 2);
  assert.deepEqual(plain(backup.tables.app_meta), [{ key: 'created_by', value: '0001_init' }]);
  assert.ok(backup.schema.some(sql => sql.includes('CREATE INDEX pets_owner')), 'indexes are kept');
  assert.ok(!JSON.stringify(backup).includes('_cf_internal'));
});

test('the weekly run writes a dated copy to R2 and keeps only the newest five', async () => {
  const env = createEnv({ DB: seededD1() });
  // Six older copies already there.
  for (let week = 6; week >= 1; week--) {
    await env.BACKUPS.put(backupKey(new Date(Date.UTC(2026, 9, 1 + week * 7, 3))), '{}');
  }
  const now = new Date('2026-11-29T03:00:00Z');
  const result = await runBackup(env, { now });

  const keys = [...env.BACKUPS.objects.keys()].sort();
  assert.equal(keys.length, BACKUPS_TO_KEEP);
  assert.equal(keys[keys.length - 1], 'd1/watchlog-2026-11-29T03-00-00.000Z.json');
  assert.equal(result.key, keys[keys.length - 1]);
  assert.equal(result.deleted.length, 2, 'six old + one new, five kept');
  assert.ok(result.deleted.every(k => k < keys[0]), 'the oldest copies are the ones deleted');
  const saved = JSON.parse(env.BACKUPS.objects.get(result.key));
  assert.equal(saved.tables.people.length, 2);
});

test('when the new copy cannot be written, nothing old is deleted', async () => {
  const backups = createR2();
  for (let week = 1; week <= 5; week++) await backups.put(backupKey(new Date(Date.UTC(2026, 9, week * 7))), '{}');
  const failing = { ...backups, put: async () => { throw new Error('R2 is down'); } };
  await assert.rejects(runBackup(createEnv({ BACKUPS: failing }), { now: new Date('2026-11-29T03:00:00Z') }), /R2 is down/);
  assert.equal(backups.objects.size, 5);
});

test('the Cron Trigger runs the backup', async () => {
  const env = createEnv();
  const ctx = createCtx();
  await worker.scheduled({ scheduledTime: Date.parse('2026-11-29T03:00:00Z'), cron: '0 3 * * SUN' }, env, ctx);
  await Promise.all(ctx.waits);
  assert.deepEqual([...env.BACKUPS.objects.keys()], ['d1/watchlog-2026-11-29T03-00-00.000Z.json']);
});

test('a backup restores into an empty database with identical data (tools/backup-to-sql.js)', async () => {
  const source = seededD1();
  const backup = plain(await exportDatabase(source));
  const target = new DatabaseSync(':memory:');
  target.exec('PRAGMA foreign_keys = ON');
  target.exec(backupToSql(backup));

  for (const table of ['people', 'pets', 'app_meta', 'd1_migrations']) {
    const before = source.sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
    const after = target.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
    assert.deepEqual(plain(after), plain(before), table);
  }
  assert.ok(target.prepare("SELECT name FROM sqlite_master WHERE name = 'pets_owner'").get(), 'index restored');
  assert.throws(() => backupToSql({ format: 'something-else' }), /Not a Watchlog database backup/);
});
