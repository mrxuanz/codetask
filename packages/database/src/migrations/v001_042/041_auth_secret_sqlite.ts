import type { Migration } from './types.ts'

/**
 * The database is the only persistence boundary shared by desktop and standalone Hono runtimes.
 * Moving the auth secret into it also makes storage migration atomic from auth's point of view.
 */
export const migration041AuthSecretSqlite: Migration = {
  version: 41,
  name: 'auth_secret_sqlite',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS auth_secret (
        singleton_key INTEGER PRIMARY KEY CHECK (singleton_key = 1),
        secret_hex TEXT NOT NULL
          CHECK (
            length(secret_hex) = 64
            AND secret_hex NOT GLOB '*[^0-9a-f]*'
          ),
        created_at_ms INTEGER NOT NULL
      );

      INSERT OR IGNORE INTO auth_secret (singleton_key, secret_hex, created_at_ms)
      VALUES (1, lower(hex(randomblob(32))), CAST(unixepoch('subsec') * 1000 AS INTEGER));

      DELETE FROM auth_sessions;
      DELETE FROM auth_challenges;
      DELETE FROM auth_throttles;
    `)
  }
}
