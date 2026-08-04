import type Database from 'better-sqlite3'

export type BatchICleanupMigration = {
  version: number
  name: string
  up: (db: Database.Database) => void
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name) as { name: string } | undefined
  return Boolean(row)
}

/**
 * Batch I: drop permanent backup/marker/dead tables after A–H acceptance.
 * Does NOT drop live `threads` / `thread_messages` yet — janitor/deletion still
 * consult them until Conversation-only ownership is proven in production DBs.
 */
export const migration064DropBackupAndMarkerTables: BatchICleanupMigration = {
  version: 64,
  name: 'drop_backup_and_marker_tables',
  up(db) {
    const drop = [
      'design_sessions_backup_026',
      'design_abilities_backup_026',
      'design_plan_milestones_backup_026',
      'design_plan_slices_backup_026',
      'design_plan_tasks_backup_026',
      'design_runs_backup_026',
      'draft_references_backup_026',
      'workspace_leases_v030',
      'design_backfill_markers'
    ]
    for (const table of drop) {
      if (tableExists(db, table)) {
        db.exec(`DROP TABLE ${table}`)
      }
    }
  }
}

/** Tables that must remain absent after Batch I (and G/R5). */
export const BATCH_I_ABSENT_TABLES = [
  'design_sessions_backup_026',
  'design_abilities_backup_026',
  'design_plan_milestones_backup_026',
  'design_plan_slices_backup_026',
  'design_plan_tasks_backup_026',
  'design_runs_backup_026',
  'draft_references_backup_026',
  'workspace_leases_v030',
  'design_backfill_markers',
  'conversation_outbox',
  'agent_runtime_bindings',
  'threads',
  'thread_messages'
] as const

/** @deprecated Empty after R5 — threads/thread_messages dropped in migration 065. */
export const BATCH_I_DEFERRED_LEGACY_TABLES = [] as const
