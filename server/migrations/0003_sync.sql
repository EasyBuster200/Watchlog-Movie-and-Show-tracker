-- Sync (docs/ROADMAP.md, Phase 4): every synced record of every account, one row each, with the
-- newest version (or a tombstone when it was deleted). Devices keep their own copy in IndexedDB;
-- this is what they exchange through POST /v1/sync (server/src/routes/sync.js).

CREATE TABLE sync_records (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,           -- 'watched_movie', 'watched_episode', 'favorite', 'list', 'list_item', 'prefs'
  record_key TEXT NOT NULL,     -- the record's id within its kind (e.g. '1399:1:3' for an episode)
  data TEXT,                    -- the record as JSON; NULL for a tombstone
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,     -- when the change was made (device clock, capped): newest wins
  seq INTEGER NOT NULL,         -- the server's order of changes, for "everything since"
  PRIMARY KEY (account_id, kind, record_key)
);
CREATE INDEX sync_records_seq ON sync_records(account_id, seq);

-- The last seq handed out per account; bumped atomically by each sync.
ALTER TABLE accounts ADD COLUMN sync_seq INTEGER NOT NULL DEFAULT 0;
