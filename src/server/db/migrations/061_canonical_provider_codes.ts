import type Database from 'better-sqlite3'
import { migration061CanonicalProviderCodes } from '../../../../packages/database/src/migrations/canonical-provider-codes.ts'
import type { Migration } from './types'

export const migration061CanonicalProviderCodesHost: Migration = {
  version: migration061CanonicalProviderCodes.version,
  name: migration061CanonicalProviderCodes.name,
  up(db: Database.Database) {
    migration061CanonicalProviderCodes.up(db)
  }
}
