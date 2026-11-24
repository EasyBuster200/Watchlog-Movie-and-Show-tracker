// The `watchlog` Worker (wrangler.jsonc). Cloudflare serves the app's own files from public/
// first; this script only runs for requests that match no file:
// - /v1/...  the server API (api.js)
// - anything else: handed back to the static files, which answer 404
// On a schedule (Sundays, see wrangler.jsonc's triggers) it copies the database to R2
// (backup.js). Cron Triggers never run in previews.

import { handleApi, isApiPath } from './api.js';
import { runBackup } from './backup.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (isApiPath(url.pathname)) return handleApi(request, env, ctx);
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runBackup(env, { now: new Date(controller.scheduledTime) }).then(
      result => console.log('Database backup saved', JSON.stringify(result)),
      error => console.error('Database backup failed', error && error.stack ? error.stack : error),
    ));
  },
};
