-- The admin page (docs/ROADMAP.md, Phase 8 part 1): sign-up requests and invites, settings the
-- owner can change without a deploy, an audit log of admin actions, and Web Push subscriptions
-- (so the owner's devices hear about new sign-up requests).
--
-- accounts.status now has three values: 'active', 'pending' (asked to join, waiting for the
-- owner's approval) and 'suspended'.

ALTER TABLE accounts ADD COLUMN request_note TEXT;   -- what someone wrote when asking to join

-- Invite codes: 8 Crockford characters like pairing codes, stored hashed, single use.
CREATE TABLE invites (
  id TEXT PRIMARY KEY,                  -- random UUID, for the admin page
  code_hash TEXT NOT NULL UNIQUE,       -- SHA-256 of the code; the code itself is shown once
  note TEXT,                            -- the owner's reminder ("for Mum")
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT REFERENCES accounts(id) ON DELETE SET NULL
);

-- Settings the admin page changes: 'signup_mode', 'tmdb_proxy', 'tmdb_daily_cap'.
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Every admin action. admin_id is kept as text (no foreign key) so the log survives deletions.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  admin_id TEXT NOT NULL,
  action TEXT NOT NULL,                 -- e.g. 'approve', 'suspend', 'invite.create'
  target TEXT,                          -- the account or invite it was about
  details TEXT                          -- JSON, small
);
CREATE INDEX audit_log_at ON audit_log(at);

-- Web Push subscriptions, one per signed-in device that turned notifications on. Signing the
-- device out (deleting its session) removes it.
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,                  -- SHA-256 of the endpoint
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX push_subscriptions_account ON push_subscriptions(account_id);
