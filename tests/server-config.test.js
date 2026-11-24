// Checks on the Cloudflare config (wrangler.jsonc, wrangler.preview-db.jsonc) that would
// otherwise only fail during a deploy: placeholders left in, the two files naming different
// preview databases, or previews pointed at the production database.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// JSON with // and /* */ comments, as Wrangler reads it. Comments inside strings
// ("https://localhost") are left alone.
function readJsonc(file) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const config = readJsonc('wrangler.jsonc');
const previewDb = readJsonc('wrangler.preview-db.jsonc');

test('no placeholder is left in the Cloudflare config', () => {
  for (const file of ['wrangler.jsonc', 'wrangler.preview-db.jsonc']) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(text, /REPLACE_WITH_/, `${file} still has a REPLACE_WITH_ placeholder`);
  }
});

test('previews use their own database, the same one migrations are applied to', () => {
  const production = config.d1_databases.find(d => d.binding === 'DB');
  const preview = config.previews.d1_databases.find(d => d.binding === 'DB');
  const migrationsTarget = previewDb.d1_databases.find(d => d.binding === 'DB');
  assert.ok(production && preview && migrationsTarget);
  assert.notEqual(preview.database_id, production.database_id, 'previews must never use the production database');
  assert.equal(migrationsTarget.database_id, preview.database_id, 'wrangler.preview-db.jsonc must name the preview database');
  assert.equal(migrationsTarget.database_name, preview.database_name);
  for (const db of [production, preview, migrationsTarget]) {
    assert.equal(db.migrations_dir, 'server/migrations');
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'server/migrations')));
});

test('the Worker script, static files, backups bucket and weekly schedule are configured', () => {
  assert.ok(fs.existsSync(path.join(ROOT, config.main)), `${config.main} exists`);
  assert.equal(config.assets.directory, './public');
  assert.equal(config.assets.binding, 'ASSETS');
  assert.ok(config.r2_buckets.some(b => b.binding === 'BACKUPS'));
  assert.equal(config.triggers.crons.length, 1);
  assert.equal(config.vars.ENVIRONMENT, 'production');
  assert.equal(config.previews.vars.ENVIRONMENT, 'preview');
  assert.equal(config.previews.triggers, undefined, 'Cron Triggers do not belong in previews');
});

test('deploys apply migrations to the right database before uploading', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  // Every build (previews and main) migrates the preview database; only main's deploy step
  // touches production (previews run Cloudflare's fixed `npx wrangler preview`).
  assert.equal(scripts['cf:build'], 'node tools/write-web-version.js && npx wrangler d1 migrations apply DB --remote --config wrangler.preview-db.jsonc');
  assert.equal(scripts['cf:deploy'], 'npx wrangler d1 migrations apply DB --remote && npx wrangler deploy');
});
