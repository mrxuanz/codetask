import type Database from 'better-sqlite3'

export type ProjectFkMigration = {
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

function hasProjectFk(db: Database.Database, table: string): boolean {
  const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    table: string
    from: string
  }>
  return rows.some((row) => row.table === 'projects' && row.from === 'project_id')
}

/**
 * Rebuild a table so project_id REFERENCES projects(id) ON DELETE CASCADE.
 * Requires foreign_keys OFF for the duration (caller controls pragma).
 */
function rebuildWithProjectFk(db: Database.Database, table: string): void {
  if (!tableExists(db, table) || !tableExists(db, 'projects')) return
  if (hasProjectFk(db, table)) return

  db.prepare(`DELETE FROM ${table} WHERE project_id NOT IN (SELECT id FROM projects)`).run()

  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string
    type: string
    notnull: number
    dflt_value: string | null
    pk: number
  }>
  if (!cols.some((col) => col.name === 'project_id')) return

  const tmp = `${table}__fk063`
  const colDefs = cols
    .map((col) => {
      const pieces = [`${col.name} ${col.type || 'TEXT'}`]
      if (col.pk) pieces.push('PRIMARY KEY')
      if (col.notnull && !col.pk) pieces.push('NOT NULL')
      if (col.dflt_value !== null && col.dflt_value !== undefined) {
        pieces.push(`DEFAULT ${col.dflt_value}`)
      }
      if (col.name === 'project_id') {
        pieces.push('REFERENCES projects(id) ON DELETE CASCADE')
      }
      return pieces.join(' ')
    })
    .join(', ')

  db.exec(`CREATE TABLE ${tmp} (${colDefs})`)
  const names = cols.map((col) => col.name).join(', ')
  db.exec(`INSERT INTO ${tmp} (${names}) SELECT ${names} FROM ${table}`)
  db.exec(`DROP TABLE ${table}`)
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`)
}

/**
 * Batch G2:
 * 1. Strong project_id FK on conversation_threads / drafts / planning_sessions / jobs
 * 2. Normalize assets.storage_key to attachments/{ownerId}/{assetId} (no trailing filename)
 */
export const migration063ProjectFkAndAssetStorageKeys: ProjectFkMigration = {
  version: 63,
  name: 'project_fk_and_asset_storage_keys',
  up(db) {
    db.exec('PRAGMA foreign_keys = OFF')
    try {
      for (const table of [
        'conversation_threads',
        'drafts',
        'planning_sessions',
        'jobs'
      ] as const) {
        rebuildWithProjectFk(db, table)
      }

      // Recreate the common indexes used by list/delete paths.
      if (tableExists(db, 'conversation_threads')) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_conversation_threads_actor
            ON conversation_threads(actor_id, updated_at);
          CREATE INDEX IF NOT EXISTS idx_conversation_threads_project
            ON conversation_threads(project_id, updated_at);
        `)
      }
      if (tableExists(db, 'drafts')) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_drafts_actor_updated ON drafts(actor_id, updated_at);
          CREATE INDEX IF NOT EXISTS idx_drafts_project ON drafts(project_id);
        `)
      }
      if (tableExists(db, 'planning_sessions')) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_planning_sessions_draft ON planning_sessions(source_draft_id);
          CREATE INDEX IF NOT EXISTS idx_planning_sessions_project ON planning_sessions(project_id);
        `)
      }
      if (tableExists(db, 'jobs')) {
        db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency ON jobs(idempotency_key);
          CREATE INDEX IF NOT EXISTS idx_jobs_actor_updated ON jobs(actor_id, updated_at);
          CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state, queued_at);
          CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id);
        `)
      }

      if (tableExists(db, 'assets')) {
        const rows = db.prepare(`SELECT id, storage_key AS storageKey FROM assets`).all() as Array<{
          id: string
          storageKey: string
        }>
        const update = db.prepare(`UPDATE assets SET storage_key = ?, updated_at = ? WHERE id = ?`)
        const now = Math.floor(Date.now() / 1000)
        for (const row of rows) {
          // attachments/{owner}/{assetId}/filename → attachments/{owner}/{assetId}
          const parts = row.storageKey.split('/')
          if (parts.length >= 4 && parts[0] === 'attachments') {
            const normalized = `attachments/${parts[1]}/${parts[2]}`
            if (normalized !== row.storageKey) {
              update.run(normalized, now, row.id)
            }
          }
        }
      }
    } finally {
      db.exec('PRAGMA foreign_keys = ON')
    }
  }
}
