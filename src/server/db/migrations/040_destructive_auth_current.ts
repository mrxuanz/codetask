import type { Migration } from './types'

/**
 * Development cutover: authentication data is deliberately not migrated.
 *
 * The application/business tables are preserved, while every legacy auth v1-v6 table is removed
 * and replaced with the current multi-session model. Existing development installs must set up
 * their local account again after this migration.
 */
export const migration040DestructiveAuthCurrent: Migration = {
  version: 40,
  name: 'destructive_auth_current',
  up(db) {
    db.pragma('foreign_keys = OFF')
    const migrate = db.transaction(() => {
      db.exec(`
        DROP TABLE IF EXISTS auth_audit;
        DROP TABLE IF EXISTS auth_throttles;
        DROP TABLE IF EXISTS auth_challenges;
        DROP TABLE IF EXISTS auth_sessions;
        DROP TABLE IF EXISTS auth_users;

        DROP TABLE IF EXISTS captcha_challenge;
        DROP TABLE IF EXISTS auth_rate_bucket;
        DROP TABLE IF EXISTS auth_guard_state;
        DROP TABLE IF EXISTS auth_state;

        CREATE TABLE auth_users (
          id TEXT PRIMARY KEY,
          singleton_key INTEGER NOT NULL CHECK (singleton_key = 1),
          username TEXT NOT NULL,
          normalized_username TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          password_version INTEGER NOT NULL DEFAULT 1,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          disabled_at_ms INTEGER
        );
        CREATE UNIQUE INDEX idx_auth_users_singleton ON auth_users(singleton_key);
        CREATE UNIQUE INDEX idx_auth_users_normalized_username
          ON auth_users(normalized_username);

        CREATE TABLE auth_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
          token_digest TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          last_seen_at_ms INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          revoked_at_ms INTEGER,
          revoke_reason TEXT
        );
        CREATE UNIQUE INDEX idx_auth_sessions_token_digest
          ON auth_sessions(token_digest);
        CREATE INDEX idx_auth_sessions_user_active
          ON auth_sessions(user_id, revoked_at_ms, expires_at_ms);

        CREATE TABLE auth_challenges (
          id TEXT PRIMARY KEY,
          scope_key TEXT NOT NULL,
          answer_digest TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL,
          expires_at_ms INTEGER NOT NULL,
          consumed_at_ms INTEGER,
          created_at_ms INTEGER NOT NULL
        );
        CREATE INDEX idx_auth_challenges_scope ON auth_challenges(scope_key);
        CREATE INDEX idx_auth_challenges_expiry ON auth_challenges(expires_at_ms);

        CREATE TABLE auth_throttles (
          key TEXT PRIMARY KEY,
          window_started_at_ms INTEGER NOT NULL,
          request_count INTEGER NOT NULL DEFAULT 0,
          failure_count INTEGER NOT NULL DEFAULT 0,
          captcha_required INTEGER NOT NULL DEFAULT 0,
          locked_until_ms INTEGER,
          updated_at_ms INTEGER NOT NULL
        );

        CREATE TABLE auth_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          user_id TEXT,
          subject_digest TEXT,
          scope_digest TEXT,
          success INTEGER NOT NULL,
          reason_code TEXT,
          created_at_ms INTEGER NOT NULL
        );
        CREATE INDEX idx_auth_audit_created ON auth_audit(created_at_ms);
        CREATE INDEX idx_auth_audit_event_created ON auth_audit(event_type, created_at_ms);
      `)
    })
    migrate()
    db.pragma('foreign_keys = ON')
  }
}
