import type { Migration } from './types'

export const migration034JobArtifactBlob: Migration = {
  version: 34,
  name: 'job_artifact_blob',
  up(db) {
    const columns = db.prepare(`PRAGMA table_info(job_artifacts)`).all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'content_blob')) {
      db.exec(`ALTER TABLE job_artifacts ADD COLUMN content_blob BLOB`)
    }
  }
}
