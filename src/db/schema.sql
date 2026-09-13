PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS accounts (
  pk              TEXT PRIMARY KEY,
  username        TEXT NOT NULL,
  full_name       TEXT,
  profile_pic_url TEXT,
  is_private      INTEGER NOT NULL DEFAULT 0,
  is_verified     INTEGER NOT NULL DEFAULT 0,
  follower_count  INTEGER,
  following_count INTEGER,
  follows_back    INTEGER,
  followed_at     INTEGER,
  first_seen_at   INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  last_seen_run   INTEGER,
  enriched_at     INTEGER,
  status          TEXT NOT NULL DEFAULT 'following'
                  CHECK (status IN ('following', 'unfollowed', 'gone'))
);

CREATE INDEX IF NOT EXISTS idx_accounts_status   ON accounts (status);
CREATE INDEX IF NOT EXISTS idx_accounts_username ON accounts (username COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_accounts_followed ON accounts (followed_at);

CREATE TABLE IF NOT EXISTS actions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_pk   TEXT NOT NULL,
  username     TEXT NOT NULL,
  status       TEXT NOT NULL
               CHECK (status IN ('queued', 'running', 'done', 'failed', 'canceled')),
  requested_at INTEGER NOT NULL,
  executed_at  INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_actions_status ON actions (status, id);
-- At most one live (queued or running) action per account.
CREATE UNIQUE INDEX IF NOT EXISTS idx_actions_pending_unique
  ON actions (account_pk) WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS sync_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER,
  ok          INTEGER,
  added       INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  removed     INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);

-- Append-only ledger used by the rate limiter, so quotas survive a restart.
CREATE TABLE IF NOT EXISTS rate_events (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket TEXT NOT NULL,
  at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rate_events ON rate_events (bucket, at);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
