import { route, json } from '../router.js';

// Health check: is the Worker up, and can it reach its database? `migration` is the newest
// database migration applied (server/migrations), so a deploy can be checked from a browser.
route('GET', '/health', async ({ env }) => {
  let database = 'ok';
  let migration = null;
  try {
    const row = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1').first();
    migration = row ? row.name : null;
  } catch (error) {
    console.error('Health check: database query failed', error && error.stack ? error.stack : error);
    database = 'error';
  }
  return json({ ok: database === 'ok', environment: env.ENVIRONMENT || 'unknown', database, migration }, database === 'ok' ? 200 : 503);
});
