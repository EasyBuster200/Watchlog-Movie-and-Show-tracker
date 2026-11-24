-- First migration: sets up the migrations pipeline and gives the database something to back up.
-- Real tables (accounts, sessions, the synced library) come with later phases, each in its own
-- numbered file. Never edit a migration that has been applied; add a new one instead.

CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO app_meta (key, value) VALUES ('created_by', '0001_init');
