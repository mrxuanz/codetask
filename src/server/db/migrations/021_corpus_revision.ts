import type { Migration } from './types'

export const migration021CorpusRevision: Migration = {
  version: 21,
  name: 'corpus_revision',
  up(db) {
    const cols = db.prepare(`PRAGMA table_info(design_sessions)`).all() as Array<{ name: string }>
    const names = new Set(cols.map((col) => col.name))
    if (!names.has('corpus_revision')) {
      db.exec(`ALTER TABLE design_sessions ADD COLUMN corpus_revision INTEGER NOT NULL DEFAULT 0`)
    }
    if (!names.has('frozen_corpus_revision')) {
      db.exec(
        `ALTER TABLE design_sessions ADD COLUMN frozen_corpus_revision INTEGER NOT NULL DEFAULT 0`
      )
    }

    db.exec(`
      UPDATE design_sessions
      SET corpus_revision = manifest_revision,
          frozen_corpus_revision = manifest_revision
      WHERE manifest_revision >= 1
    `)
  }
}
