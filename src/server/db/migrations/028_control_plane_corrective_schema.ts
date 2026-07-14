import type { Migration } from './types'

function tableExists(db: Parameters<Migration['up']>[0], table: string): boolean {
  return Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
  )
}

function columnExists(
  db: Parameters<Migration['up']>[0],
  table: string,
  column: string
): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    (row) => row.name === column
  )
}

function indexExists(db: Parameters<Migration['up']>[0], indexName: string): boolean {
  return Boolean(
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(indexName)
  )
}

export const migration028ControlPlaneCorrectiveSchema: Migration = {
  version: 28,
  name: 'control_plane_corrective_schema',
  up(db) {
    if (!tableExists(db, 'control_jobs')) return

    const needsRunRebuild = columnExists(db, 'control_job_runs', 'pending_attempt_id')
    const needsAttemptRebuild =
      !columnExists(db, 'control_task_attempts', 'must_pause_at_commit') ||
      needsRunRebuild
    const needsDedupRebuild = !indexExists(db, 'idx_control_command_dedup_pk')
    const needsOutboxRebuild = !indexExists(db, 'idx_control_outbox_entity_revision')
    const needsSchemaMetaRebuild = !columnExists(db, 'control_schema_meta', 'source_schema_version')
    const needsPlanRevisionUnique = !indexExists(db, 'idx_control_plan_revisions_job_revision')
    const verificationTableSql = tableExists(db, 'control_verifications')
      ? (db
          .prepare(
            `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'control_verifications'`
          )
          .get() as { sql: string } | undefined)
      : undefined
    const needsVerificationRebuild =
      tableExists(db, 'control_verifications') &&
      (!columnExists(db, 'control_verifications', 'result_revision') ||
        (verificationTableSql?.sql !== undefined &&
          !verificationTableSql.sql.includes('REFERENCES control_plan_revisions')))

    if (
      !needsRunRebuild &&
      !needsAttemptRebuild &&
      !needsDedupRebuild &&
      !needsOutboxRebuild &&
      !needsSchemaMetaRebuild &&
      !needsPlanRevisionUnique &&
      !needsVerificationRebuild
    ) {
      return
    }

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_control_plan_revisions_job_revision
        ON control_plan_revisions(job_id, plan_revision);
    `)

    if (needsRunRebuild) {
      db.exec(`
        CREATE TABLE control_job_runs_new (
          id                      TEXT PRIMARY KEY,
          job_id                  TEXT NOT NULL,
          kind                    TEXT NOT NULL CHECK (kind IN ('planning','execution')),
          state                   TEXT NOT NULL
            CHECK (state IN (
              'queued','starting','active','retrying',
              'pausing','cancelling','stopping','exiting',
              'paused','succeeded','failed','cancelled','interrupted'
            )),
          attempt_no              INTEGER NOT NULL CHECK (attempt_no >= 1),
          fence_token             TEXT NOT NULL,
          execution_generation    INTEGER NOT NULL CHECK (execution_generation >= 0),
          lease_owner_boot_id     TEXT,
          current_runtime_instance_id TEXT,
          heartbeat_at_ms         INTEGER,
          stop_reason             TEXT,
          started_at_ms           INTEGER NOT NULL CHECK (started_at_ms >= 0),
          ended_at_ms             INTEGER CHECK (ended_at_ms IS NULL OR ended_at_ms >= 0),
          FOREIGN KEY (job_id) REFERENCES control_jobs(id) ON DELETE CASCADE
        );

        INSERT INTO control_job_runs_new (
          id, job_id, kind, state, attempt_no, fence_token, execution_generation,
          lease_owner_boot_id, current_runtime_instance_id, heartbeat_at_ms,
          stop_reason, started_at_ms, ended_at_ms
        )
        SELECT
          id, job_id, kind, state, attempt_no, fence_token, execution_generation,
          lease_owner_boot_id, current_runtime_instance_id, heartbeat_at_ms,
          stop_reason, started_at_ms, ended_at_ms
        FROM control_job_runs;

        DROP TABLE control_job_runs;
        ALTER TABLE control_job_runs_new RENAME TO control_job_runs;

        CREATE UNIQUE INDEX idx_control_job_runs_fence
          ON control_job_runs(job_id, fence_token);
      `)
    }

    if (needsAttemptRebuild) {
      db.exec(`
        CREATE TABLE control_task_attempts_new (
          id                  TEXT PRIMARY KEY,
          job_id              TEXT NOT NULL,
          execution_generation INTEGER NOT NULL,
          task_id             TEXT NOT NULL,
          attempt_no          INTEGER NOT NULL CHECK (attempt_no >= 1),
          run_id              TEXT NOT NULL,
          state               TEXT NOT NULL
            CHECK (state IN ('pending','starting','running','completed','failed','interrupted')),
          provider            TEXT,
          evidence_blob_hash  TEXT,
          failure_id          TEXT,
          started_at_ms       INTEGER NOT NULL CHECK (started_at_ms >= 0),
          ended_at_ms         INTEGER CHECK (ended_at_ms IS NULL OR ended_at_ms >= 0),
          result_hash         TEXT,
          result_revision     INTEGER NOT NULL DEFAULT 0,
          must_pause_at_commit INTEGER CHECK (must_pause_at_commit IN (0, 1)),
          FOREIGN KEY (run_id) REFERENCES control_job_runs(id) ON DELETE CASCADE,
          FOREIGN KEY (job_id, execution_generation, task_id)
            REFERENCES control_job_tasks(job_id, execution_generation, task_id),
          FOREIGN KEY (evidence_blob_hash) REFERENCES control_evidence_blobs(hash)
        );

        INSERT INTO control_task_attempts_new (
          id, job_id, execution_generation, task_id, attempt_no, run_id, state,
          provider, evidence_blob_hash, failure_id, started_at_ms, ended_at_ms,
          result_hash, result_revision, must_pause_at_commit
        )
        SELECT
          id, job_id, execution_generation, task_id, attempt_no, run_id, state,
          provider, evidence_blob_hash, failure_id, started_at_ms, ended_at_ms,
          result_hash, COALESCE(result_revision, 0), NULL
        FROM control_task_attempts;

        DROP TABLE control_task_attempts;
        ALTER TABLE control_task_attempts_new RENAME TO control_task_attempts;

        CREATE UNIQUE INDEX idx_control_task_attempts_unique
          ON control_task_attempts(job_id, execution_generation, task_id, attempt_no);
      `)
    }

    if (!indexExists(db, 'idx_control_runtime_instances_run_active')) {
      db.exec(`
        CREATE UNIQUE INDEX idx_control_runtime_instances_run_active
          ON control_runtime_instances(run_id)
          WHERE state != 'closed';
      `)
    }

    if (needsOutboxRebuild) {
      db.exec(`
        DELETE FROM control_outbox_events
        WHERE rowid NOT IN (
          SELECT MIN(rowid)
          FROM control_outbox_events
          GROUP BY entity_id, aggregate_revision
        );

        CREATE TABLE control_outbox_events_new (
          event_id            INTEGER PRIMARY KEY AUTOINCREMENT,
          topic               TEXT NOT NULL,
          event_type          TEXT NOT NULL,
          entity_id           TEXT NOT NULL,
          aggregate_revision  INTEGER NOT NULL,
          payload_json        TEXT NOT NULL,
          payload_bytes       INTEGER NOT NULL CHECK (payload_bytes >= 0),
          created_at_ms       INTEGER NOT NULL CHECK (created_at_ms >= 0),
          dispatched_at_ms    INTEGER CHECK (dispatched_at_ms IS NULL OR dispatched_at_ms >= 0),
          UNIQUE (entity_id, aggregate_revision)
        );

        INSERT INTO control_outbox_events_new (
          event_id, topic, event_type, entity_id, aggregate_revision,
          payload_json, payload_bytes, created_at_ms, dispatched_at_ms
        )
        SELECT
          event_id, topic, event_type, entity_id, aggregate_revision,
          payload_json, payload_bytes, created_at_ms, dispatched_at_ms
        FROM control_outbox_events;

        DROP TABLE control_outbox_events;
        ALTER TABLE control_outbox_events_new RENAME TO control_outbox_events;

        CREATE INDEX idx_control_outbox_dispatch
          ON control_outbox_events(dispatched_at_ms, event_id);
        CREATE INDEX idx_control_outbox_topic
          ON control_outbox_events(topic, event_id);
      `)
    }

    if (needsDedupRebuild) {
      db.exec(`
        CREATE TABLE control_command_dedup_new (
          actor_username    TEXT NOT NULL,
          command_type      TEXT NOT NULL,
          idempotency_key   TEXT NOT NULL,
          request_hash      TEXT NOT NULL,
          response_json     TEXT NOT NULL,
          response_revision INTEGER NOT NULL,
          created_at_ms     INTEGER NOT NULL CHECK (created_at_ms >= 0),
          expires_at_ms     INTEGER NOT NULL CHECK (expires_at_ms >= 0),
          PRIMARY KEY (actor_username, command_type, idempotency_key)
        );

        INSERT INTO control_command_dedup_new (
          actor_username, command_type, idempotency_key, request_hash,
          response_json, response_revision, created_at_ms, expires_at_ms
        )
        SELECT
          actor_username, command_type, idempotency_key, request_hash,
          response_json, response_revision, created_at_ms, expires_at_ms
        FROM control_command_dedup;

        DROP TABLE control_command_dedup;
        ALTER TABLE control_command_dedup_new RENAME TO control_command_dedup;
      `)
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS control_verifications_new (
        id                  TEXT PRIMARY KEY,
        job_id              TEXT NOT NULL,
        execution_generation INTEGER NOT NULL,
        plan_revision       INTEGER NOT NULL,
        scope_type          TEXT NOT NULL CHECK (scope_type IN ('slice','milestone')),
        scope_id            TEXT NOT NULL,
        attempt_no          INTEGER NOT NULL CHECK (attempt_no >= 1),
        state               TEXT NOT NULL CHECK (state IN ('running','passed','rejected','interrupted','superseded')),
        run_id              TEXT,
        fence_token         TEXT,
        verdict_blob_hash   TEXT,
        result_hash         TEXT,
        result_revision     INTEGER,
        failure_id          TEXT,
        started_at_ms       INTEGER NOT NULL CHECK (started_at_ms >= 0),
        ended_at_ms         INTEGER CHECK (ended_at_ms IS NULL OR ended_at_ms >= 0),
        CHECK (
          state != 'passed' OR (
            verdict_blob_hash IS NOT NULL
            AND result_hash IS NOT NULL
            AND ended_at_ms IS NOT NULL
          )
        ),
        FOREIGN KEY (job_id) REFERENCES control_jobs(id) ON DELETE CASCADE,
        FOREIGN KEY (job_id, plan_revision)
          REFERENCES control_plan_revisions(job_id, plan_revision),
        FOREIGN KEY (run_id) REFERENCES control_job_runs(id) ON DELETE SET NULL,
        FOREIGN KEY (verdict_blob_hash) REFERENCES control_evidence_blobs(hash),
        FOREIGN KEY (failure_id) REFERENCES control_job_failures(id)
      );
    `)

    const needsVerificationRebuildAtEnd = needsVerificationRebuild

    if (needsVerificationRebuildAtEnd) {
      db.exec(`
        INSERT INTO control_verifications_new (
          id, job_id, execution_generation, plan_revision, scope_type, scope_id,
          attempt_no, state, run_id, fence_token, verdict_blob_hash, result_hash,
          result_revision, failure_id, started_at_ms, ended_at_ms
        )
        SELECT
          v.id, v.job_id, v.execution_generation, v.plan_revision, v.scope_type, v.scope_id,
          v.attempt_no, v.state, v.run_id, v.fence_token, v.verdict_blob_hash, v.result_hash,
          NULL, v.failure_id, v.started_at_ms, v.ended_at_ms
        FROM control_verifications v
        WHERE EXISTS (
          SELECT 1 FROM control_plan_revisions pr
          WHERE pr.job_id = v.job_id AND pr.plan_revision = v.plan_revision
        );

        DROP TABLE control_verifications;
        ALTER TABLE control_verifications_new RENAME TO control_verifications;

        CREATE UNIQUE INDEX idx_control_verifications_unique
          ON control_verifications(job_id, execution_generation, plan_revision, scope_type, scope_id, attempt_no);
      `)
    } else {
      db.exec(`DROP TABLE IF EXISTS control_verifications_new;`)
    }

    if (needsSchemaMetaRebuild) {
      db.exec(`
        CREATE TABLE control_schema_meta_new (
          key                     TEXT PRIMARY KEY,
          value                   TEXT NOT NULL,
          source_migration        INTEGER NOT NULL,
          source_schema_version   INTEGER,
          created_by_migration    INTEGER,
          copy_report_hash        TEXT,
          backup_id               TEXT,
          validation_summary_json TEXT,
          updated_at_ms           INTEGER NOT NULL CHECK (updated_at_ms >= 0)
        );

        INSERT INTO control_schema_meta_new (
          key, value, source_migration, source_schema_version, created_by_migration,
          copy_report_hash, backup_id, validation_summary_json, updated_at_ms
        )
        SELECT
          key,
          value,
          CASE WHEN key = 'control_schema_generation' AND value IN ('copied', 'v3_authoritative')
            THEN 26 ELSE source_migration END,
          CASE WHEN key = 'control_schema_generation' AND value IN ('copied', 'v3_authoritative')
            THEN 26 ELSE source_migration END,
          source_migration,
          copy_report_hash,
          backup_id,
          validation_summary_json,
          updated_at_ms
        FROM control_schema_meta;

        DROP TABLE control_schema_meta;
        ALTER TABLE control_schema_meta_new RENAME TO control_schema_meta;
      `)
    }

    db.exec(`
      UPDATE control_schema_meta
      SET created_by_migration = COALESCE(created_by_migration, 28)
      WHERE created_by_migration IS NULL;
    `)
  }
}
