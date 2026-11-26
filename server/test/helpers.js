// Test doubles for the Worker's bindings. The database is real SQLite (node:sqlite, Node 22.5+),
// which is what D1 runs on, behind the small part of D1's API the server uses: prepare(),
// bind(), all(), first(), run(), batch(), exec(). Migrations from server/migrations are applied
// the way `wrangler d1 migrations apply` does, recorded in a d1_migrations table.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// The newest migration file, which a fully migrated database reports as applied last.
export const LATEST_MIGRATION = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort().pop();

class Statement {
  constructor(sqlite, sql, params = []) {
    this.sqlite = sqlite;
    this.sql = sql;
    this.params = params;
  }

  bind(...params) {
    return new Statement(this.sqlite, this.sql, params);
  }

  async all() {
    return { results: this.sqlite.prepare(this.sql).all(...this.params).map(row => ({ ...row })), success: true, meta: {} };
  }

  async first(column) {
    const row = this.sqlite.prepare(this.sql).get(...this.params);
    if (!row) return null;
    return column ? (row[column] ?? null) : { ...row };
  }

  async run() {
    const result = this.sqlite.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

export function createD1({ migrate = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const d1 = {
    sqlite,
    prepare: sql => new Statement(sqlite, sql),
    batch: async statements => {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    exec: async sql => { sqlite.exec(sql); return { count: 1 }; },
  };
  if (migrate) applyMigrations(sqlite);
  return d1;
}

export function applyMigrations(sqlite, dir = MIGRATIONS_DIR) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS d1_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
  )`);
  const applied = new Set(sqlite.prepare('SELECT name FROM d1_migrations').all().map(r => r.name));
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
    if (applied.has(file)) continue;
    sqlite.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
    sqlite.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(file);
  }
}

// In-memory R2 bucket: put / get / list (with prefix) / delete (one key or an array).
export function createR2({ failPuts = false } = {}) {
  const objects = new Map();
  return {
    objects,
    async put(key, value) {
      if (failPuts) throw new Error('R2 put failed');
      objects.set(key, typeof value === 'string' ? value : String(value));
      return { key };
    },
    async get(key) {
      if (!objects.has(key)) return null;
      const text = objects.get(key);
      return { key, text: async () => text, json: async () => JSON.parse(text) };
    },
    async list({ prefix = '' } = {}) {
      const keys = [...objects.keys()].filter(k => k.startsWith(prefix)).sort();
      return { objects: keys.map(key => ({ key })), truncated: false };
    },
    async delete(keys) {
      for (const key of [].concat(keys)) objects.delete(key);
    },
  };
}

// The static files binding: records what it was asked for and answers 200 "asset".
export function createAssets() {
  const requests = [];
  return {
    requests,
    async fetch(request) {
      requests.push(new URL(request.url).pathname);
      return new Response('asset', { status: 200 });
    },
  };
}

// `signupMode` sets the admin page's sign-up mode (server/src/settings.js). Tests default to
// 'open', so tests about other things can make as many accounts as they like; the real default
// is 'approval'. Pass signupMode: null to keep the real default.
export function createEnv({ signupMode = 'open', ...overrides } = {}) {
  const env = {
    ENVIRONMENT: 'test',
    ALLOWED_ORIGINS: 'https://localhost',
    DB: createD1(),
    BACKUPS: createR2(),
    ASSETS: createAssets(),
    ...overrides,
  };
  if (signupMode && env.DB && env.DB.sqlite) {
    env.DB.sqlite.prepare("INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('signup_mode', ?, '2026-01-01T00:00:00.000Z')").run(signupMode);
  }
  return env;
}

export const ORIGIN = 'https://watchlog.example.workers.dev';

export function request(pathname, { method = 'GET', origin, headers = {}, body } = {}) {
  const allHeaders = { ...headers };
  if (origin) allHeaders.Origin = origin;
  return new Request(ORIGIN + pathname, { method, headers: allHeaders, body });
}

export function createCtx() {
  const waits = [];
  return { waits, waitUntil: promise => waits.push(promise), passThroughOnException() {} };
}
