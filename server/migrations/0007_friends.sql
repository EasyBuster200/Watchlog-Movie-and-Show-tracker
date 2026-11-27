-- Friends (docs/ROADMAP.md, Phase 7, first step; server/src/routes/friends.js).

-- Each account's friend code (8 Crockford characters, stored without the dash), made the first
-- time it's asked for, and what friends may see of its library: 'everything' (the default,
-- decided with the user), 'lists' (lists and favourites) or 'nothing'.
ALTER TABLE accounts ADD COLUMN friend_code TEXT;
CREATE UNIQUE INDEX accounts_friend_code ON accounts(friend_code);
ALTER TABLE accounts ADD COLUMN share_level TEXT NOT NULL DEFAULT 'everything';

-- A request from one account to another, until it's accepted, declined or cancelled.
CREATE TABLE friend_requests (
  from_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX friend_requests_to ON friend_requests(to_id);

-- A friendship, stored once with the smaller account id first.
CREATE TABLE friendships (
  account_a TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  account_b TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_a, account_b),
  CHECK (account_a < account_b)
);
CREATE INDEX friendships_b ON friendships(account_b);

-- Who blocked whom: a blocked account can't send requests to the blocker (it's told nobody has
-- that code) and isn't their friend any more.
CREATE TABLE blocks (
  blocker_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

-- Web Push for friend requests, per device like the other kinds (server/src/push.js).
ALTER TABLE push_subscriptions ADD COLUMN notify_friends INTEGER NOT NULL DEFAULT 0;
