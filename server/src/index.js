// The `watchlog` Worker (wrangler.jsonc). Cloudflare serves the app's own files from public/
// first; this script only runs for requests that match no file:
// - /v1/...  the server API (api.js)
// - anything else: handed back to the static files, which answer 404
// On a schedule (Sundays, see wrangler.jsonc's triggers) it deletes expired rows (cleanup.js),
// then copies the database to R2 (backup.js). Cron Triggers never run in previews.

import { handleApi, isApiPath } from './api.js';
import { runBackup } from './backup.js';
import { runCleanup } from './cleanup.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (isApiPath(url.pathname)) return handleApi(request, env, ctx);
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    const now = new Date(controller.scheduledTime);
    ctx.waitUntil((async () => {
      // A failed cleanup mustn't stop the backup.
      try {
        console.log('Cleanup done', JSON.stringify(await runCleanup(env, now)));
      } catch (error) {
        console.error('Cleanup failed', error && error.stack ? error.stack : error);
      }
      try {
        console.log('Database backup saved', JSON.stringify(await runBackup(env, { now })));
      } catch (error) {
        console.error('Database backup failed', error && error.stack ? error.stack : error);
      }
    })());
  },
};
