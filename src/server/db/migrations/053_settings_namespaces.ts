import type Database from 'better-sqlite3'
import { migration053SettingsNamespaces as settingsNamespacesMigration } from '../../../../packages/database/src/migrations/settings-namespaces.ts'
import type { Migration } from './types'

export const migration053SettingsNamespaces: Migration = {
  version: settingsNamespacesMigration.version,
  name: settingsNamespacesMigration.name,
  up(db: Database.Database) {
    settingsNamespacesMigration.up(db)
  }
}
