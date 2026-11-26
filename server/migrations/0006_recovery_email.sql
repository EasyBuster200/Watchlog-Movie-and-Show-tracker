-- The recovery email (docs/ROADMAP.md, Phase 3c; server/src/email.js, routes/recovery.js).

-- Every account made before this is deleted, the owner's included (decided with the user: it
-- was all testing, and every account from now on has a verified email from the start). The
-- delete cascades to sessions, pairing codes, synced records and push subscriptions. Libraries
-- stay on people's devices.
DELETE FROM accounts;

-- The account's verified email: the address itself (to send to) and a hash (to look it up by).
ALTER TABLE accounts ADD COLUMN email TEXT;
ALTER TABLE accounts ADD COLUMN email_hash TEXT;
ALTER TABLE accounts ADD COLUMN email_verified_at TEXT;
CREATE UNIQUE INDEX accounts_email ON accounts(email_hash);

-- One-time codes sent by email: to sign up, to change the address, to recover the account. The
-- newest one per purpose and address counts; a few wrong tries and it's gone.
CREATE TABLE email_codes (
  purpose TEXT NOT NULL,            -- 'signup', 'change', 'recover'
  email_hash TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (purpose, email_hash)
);

-- A recovery waiting out its hold (24 hours), during which any signed-in device can cancel it.
-- The device that asked keeps the token and finishes it afterwards.
CREATE TABLE recoveries (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  device_name TEXT,
  requested_at TEXT NOT NULL,
  completes_at TEXT NOT NULL
);
