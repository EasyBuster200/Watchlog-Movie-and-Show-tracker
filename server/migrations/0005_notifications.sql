-- Notifications through the server (docs/ROADMAP.md, Phase 6; server/src/notifications.js).

-- What each device wants to hear about, and where it is (for 18:00 "local time" and release
-- dates). Rows from before this (the admin page's switch) only had sign-up requests.
ALTER TABLE push_subscriptions ADD COLUMN notify_requests INTEGER NOT NULL DEFAULT 1;
ALTER TABLE push_subscriptions ADD COLUMN notify_episodes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_subscriptions ADD COLUMN notify_releases INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_subscriptions ADD COLUMN notify_recap INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_subscriptions ADD COLUMN time_zone TEXT;   -- IANA name, e.g. 'Europe/Lisbon'
ALTER TABLE push_subscriptions ADD COLUMN region TEXT;      -- ISO 3166-1, e.g. 'PT'

-- The few facts the hourly job needs about each tracked show or movie, refreshed a few titles
-- an hour (the free plan allows 50 outside requests per run). data is a small JSON object:
--   tv:    { name, status, runtime, next: { date, season, episode, name } | null }
--   movie: { title, runtime, releases: { <region>: { date, kind } } }
CREATE TABLE tmdb_titles (
  media_type TEXT NOT NULL,        -- 'tv' or 'movie'
  tmdb_id INTEGER NOT NULL,
  data TEXT NOT NULL,
  next_date TEXT,                  -- tv: the next episode's air date ('YYYY-MM-DD')
  refresh_after TEXT NOT NULL,     -- ISO time after which it's fetched again
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (media_type, tmdb_id)
);
CREATE INDEX tmdb_titles_next ON tmdb_titles(media_type, next_date);

-- What was already sent to which device, so nothing is sent twice.
CREATE TABLE push_log (
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,               -- 'ep:1399:2:3', 'rel:550:2026-12-01', 'recap:2026-11-29'
  sent_at TEXT NOT NULL,
  PRIMARY KEY (subscription_id, tag)
);
