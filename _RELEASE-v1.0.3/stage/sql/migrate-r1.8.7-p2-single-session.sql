BEGIN;

CREATE TABLE IF NOT EXISTS active_user_sessions(
  user_id BIGINT PRIMARY KEY,
  session_token VARCHAR(100) NOT NULL UNIQUE,
  login_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  ip_address VARCHAR(100),
  user_agent TEXT,
  CONSTRAINT fk_active_user_sessions_user
    FOREIGN KEY(user_id) REFERENCES users(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_active_user_sessions_expires
  ON active_user_sessions(expires_at);

DELETE FROM active_user_sessions WHERE expires_at <= NOW();

COMMIT;