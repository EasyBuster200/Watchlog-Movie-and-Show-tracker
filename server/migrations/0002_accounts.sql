-- Online accounts (docs/ROADMAP.md, Phase 3): the account, its signed-in devices (sessions),
-- one-time codes for adding a device, and rate-limit counters. The recovery email comes in a
-- later migration, once email can be sent.

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,                  -- random UUID
  key_hash TEXT NOT NULL UNIQUE,        -- SHA-256 of the account key (server/src/auth.js); never the key
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',-- 'active' (the admin page will add 'suspended')
  created_at TEXT NOT NULL,             -- ISO 8601 UTC
  key_changed_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,      -- SHA-256 of the session token
  device_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  expires_at TEXT NOT NULL              -- last use + 180 days
);
CREATE INDEX sessions_account ON sessions(account_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

CREATE TABLE pairing_codes (
  code_hash TEXT PRIMARY KEY,           -- SHA-256 of the one-time code
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL              -- a few minutes after created_at
);
CREATE INDEX pairing_codes_account ON pairing_codes(account_id);

CREATE TABLE rate_limits (
  key TEXT NOT NULL,                    -- what's limited and for whom (hashed, never an IP address)
  window_start INTEGER NOT NULL,        -- Unix seconds
  count INTEGER NOT NULL,
  PRIMARY KEY (key, window_start)
);
