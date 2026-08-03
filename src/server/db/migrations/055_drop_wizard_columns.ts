import type Database from 'better-sqlite3'
import { migration055DropWizardColumns } from '../../../../packages/database/src/migrations/drop-wizard-columns.ts'
import type { Migration } from './types'

export const migration055DropWizardColumnsTables: Migration = {
  version: migration055DropWizardColumns.version,
  name: migration055DropWizardColumns.name,
  up(db: Database.Database) {
    migration055DropWizardColumns.up(db)
  }
}
