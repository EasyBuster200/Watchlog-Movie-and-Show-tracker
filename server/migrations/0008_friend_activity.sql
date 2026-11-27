-- Friends, step 2 (docs/ROADMAP.md, Phase 7; server/src/routes/friends.js): the activity feed
-- reads each friend's recent changes, so sync records get an index by account and time.
CREATE INDEX sync_records_updated ON sync_records(account_id, updated_at);
