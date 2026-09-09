-- ============================================================================
-- 004 — authentication for a small internal team
--
-- Until now x-actor was an honour-system text field. Online with shared data,
-- attribution has to be real: the audit trail and "who confirmed this location"
-- are only worth anything if the actor is a verified login, not a typed name.
-- ============================================================================

CREATE TABLE app_user (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  must_reset    INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE session (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  user_agent  TEXT
);
CREATE INDEX idx_session_user ON session(user_id);
CREATE INDEX idx_session_exp  ON session(expires_at);
