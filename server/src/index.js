// The `watchlog` Worker (wrangler.jsonc). Cloudflare serves the app's own files from public/
// first; this script only runs for requests that match no file:
// - /v1/...  the server API (api.js)
// - anything else: handed back to the static files, which answer 404
// On a schedule (wrangler.jsonc's triggers; Cron Triggers never run in previews):
// - every hour: notifications (notifications.js);
// - Sundays 03:00 UTC (backup.js's BACKUP_CRON; the main module may only export handlers): deletes expired rows (cleanup.js), then copies the
//   database to R2 (backup.js).

import { handleApi, isApiPath } from './api.js';
import { runBackup, BACKUP_CRON } from './backup.js';
import { runCleanup } from './cleanup.js';
import { runNotifications } from './notifications.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (isApiPath(url.pathname)) return handleApi(request, env, ctx);
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    const now = new Date(controller.scheduledTime);
    if (controller.cron !== BACKUP_CRON) {
      ctx.waitUntil(runNotifications(env, { now })
        .then(result => console.log('Notifications', JSON.stringify(result)))
        .catch(error => console.error('Notifications failed', error && error.stack ? error.stack : error)));
      return;
    }
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
