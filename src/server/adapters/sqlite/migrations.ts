import type Database from 'better-sqlite3'

interface KernelMigration {
  readonly version: number
  readonly name: string
  readonly checksum: string
  apply(database: Database.Database): void
}

const migration001Authentication: KernelMigration = {
  version: 1,
  name: 'authentication',
  checksum: 'auth-kernel-001-2026-07-26',
  apply(database): void {
    database.exec(`
      CREATE TABLE auth_users (
        id TEXT PRIMARY KEY,
        singleton_key INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton_key = 1),
        username TEXT NOT NULL,
        normalized_username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        password_version INTEGER NOT NULL CHECK (password_version >= 1),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
        disabled_at_ms INTEGER
      );

      CREATE TABLE auth_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        token_digest TEXT NOT NULL UNIQUE CHECK (length(token_digest) = 64),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        last_seen_at_ms INTEGER NOT NULL CHECK (last_seen_at_ms >= created_at_ms),
        expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
        revoked_at_ms INTEGER,
        revoke_reason TEXT,
        CHECK (
          (revoked_at_ms IS NULL AND revoke_reason IS NULL)
          OR (revoked_at_ms IS NOT NULL AND revoke_reason IS NOT NULL)
        )
      );

      CREATE INDEX idx_auth_sessions_user_active
        ON auth_sessions(user_id, revoked_at_ms, expires_at_ms, created_at_ms DESC);
      CREATE INDEX idx_auth_sessions_expiry
        ON auth_sessions(expires_at_ms);

      CREATE TABLE auth_throttles (
        key TEXT PRIMARY KEY,
        window_started_at_ms INTEGER NOT NULL CHECK (window_started_at_ms >= 0),
        request_count INTEGER NOT NULL CHECK (request_count >= 0),
        failure_count INTEGER NOT NULL CHECK (failure_count >= 0),
        captcha_required INTEGER NOT NULL CHECK (captcha_required IN (0, 1)),
        locked_until_ms INTEGER,
        updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= window_started_at_ms)
      );

      CREATE INDEX idx_auth_throttles_updated ON auth_throttles(updated_at_ms);

      CREATE TABLE auth_challenges (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        answer_digest TEXT NOT NULL CHECK (length(answer_digest) = 64),
        attempts INTEGER NOT NULL CHECK (attempts >= 0),
        max_attempts INTEGER NOT NULL CHECK (max_attempts >= 1),
        expires_at_ms INTEGER NOT NULL,
        consumed_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        CHECK (expires_at_ms > created_at_ms),
        CHECK (attempts <= max_attempts)
      );

      CREATE INDEX idx_auth_challenges_scope
        ON auth_challenges(scope_key, created_at_ms DESC);
      CREATE INDEX idx_auth_challenges_expiry ON auth_challenges(expires_at_ms);

      CREATE TABLE auth_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        user_id TEXT REFERENCES auth_users(id) ON DELETE SET NULL,
        subject_digest TEXT,
        scope_digest TEXT,
        success INTEGER NOT NULL CHECK (success IN (0, 1)),
        reason_code TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0)
      );

      CREATE INDEX idx_auth_audit_created ON auth_audit(created_at_ms DESC);
      CREATE INDEX idx_auth_audit_user_created
        ON auth_audit(user_id, created_at_ms DESC);
    `)
  }
}

export const KERNEL_SCHEMA_VERSION = 1
const KERNEL_MIGRATIONS: readonly KernelMigration[] = [migration001Authentication]

function ensureMigrationTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS kernel_schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );
  `)
}

function verifyAppliedMigrations(database: Database.Database): number {
  const rows = database
    .prepare(
      `SELECT version, name, checksum
       FROM kernel_schema_migrations
       ORDER BY version`
    )
    .all() as Array<{ version: number; name: string; checksum: string }>

  for (const row of rows) {
    const migration = KERNEL_MIGRATIONS.find((candidate) => candidate.version === row.version)
    if (!migration || migration.name !== row.name || migration.checksum !== row.checksum) {
      throw new Error(`kernel_schema.migration_mismatch.${row.version}`)
    }
  }
  return rows.at(-1)?.version ?? 0
}

export function applyKernelMigrations(
  database: Database.Database,
  nowMs: () => number = Date.now
): void {
  ensureMigrationTable(database)
  const currentVersion = verifyAppliedMigrations(database)

  for (const migration of KERNEL_MIGRATIONS) {
    if (migration.version <= currentVersion) continue
    database.transaction(() => {
      migration.apply(database)
      database
        .prepare(
          `INSERT INTO kernel_schema_migrations
             (version, name, checksum, applied_at_ms)
           VALUES (?, ?, ?, ?)`
        )
        .run(migration.version, migration.name, migration.checksum, nowMs())
    })()
  }
}
