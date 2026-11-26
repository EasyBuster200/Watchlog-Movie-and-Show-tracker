// Who the admin is, and the audit log.
//
// The admin is whoever's account id is in the ADMIN_ACCOUNT_IDS Worker secret (comma-separated;
// decided with the user). The admin page shows an account its own id when it isn't admin yet,
// so the owner can copy it into the secret once. Being signed in as that account (a session
// token, like any other request) is what lets a device use /v1/admin/... - there's no separate
// admin password.

import { ApiError } from './router.js';
import { requireAuth, nowIso, PENDING } from './auth.js';

export function adminIds(env) {
  return String(env.ADMIN_ACCOUNT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
}

export function isAdmin(env, accountId) {
  return adminIds(env).includes(accountId);
}

// The owner's own account may still be waiting for approval (made after other accounts existed,
// so it wasn't the first): listing it in ADMIN_ACCOUNT_IDS is the approval, so it's activated here
// rather than left unable to approve itself.
export async function requireAdmin(request, env) {
  const auth = await requireAuth(request, env, { allowPending: true });
  if (!isAdmin(env, auth.account.id)) {
    if (auth.account.status === 'pending') throw PENDING();
    throw new ApiError(403, 'not_admin', 'Only the owner can do this.');
  }
  if (auth.account.status === 'pending') {
    await env.DB.prepare("UPDATE accounts SET status = 'active' WHERE id = ?").bind(auth.account.id).run();
    auth.account.status = 'active';
  }
  return auth;
}

// Records an admin action. `details` is a small object (stored as JSON).
export async function audit(env, adminId, action, target = null, details = null) {
  await env.DB.prepare('INSERT INTO audit_log (at, admin_id, action, target, details) VALUES (?, ?, ?, ?, ?)')
    .bind(nowIso(), adminId, action, target, details ? JSON.stringify(details) : null).run();
}
