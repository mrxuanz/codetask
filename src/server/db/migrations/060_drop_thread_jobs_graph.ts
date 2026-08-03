import type Database from 'better-sqlite3'
import { migration060DropThreadJobsGraph } from '../../../../packages/database/src/migrations/drop-thread-jobs-graph.ts'
import type { Migration } from './types'

export const migration060DropThreadJobsGraphHost: Migration = {
  version: migration060DropThreadJobsGraph.version,
  name: migration060DropThreadJobsGraph.name,
  up(db: Database.Database) {
    migration060DropThreadJobsGraph.up(db)
  }
}
