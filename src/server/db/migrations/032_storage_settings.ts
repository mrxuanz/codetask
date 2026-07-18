import type { Migration } from './types'

export const migration032StorageSettings: Migration = {
  version: 32,
  name: 'storage_settings',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        namespace TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
  }
}
