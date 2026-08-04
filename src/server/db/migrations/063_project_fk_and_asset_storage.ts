import type Database from 'better-sqlite3'
import { migration063ProjectFkAndAssetStorageKeys } from '../../../../packages/database/src/migrations/project-fk-and-asset-storage.ts'
import type { Migration } from './types'

export const migration063ProjectFkAndAssetStorageKeysHost: Migration = {
  version: migration063ProjectFkAndAssetStorageKeys.version,
  name: migration063ProjectFkAndAssetStorageKeys.name,
  up(db: Database.Database) {
    migration063ProjectFkAndAssetStorageKeys.up(db)
  }
}
