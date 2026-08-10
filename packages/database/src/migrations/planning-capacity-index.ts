import type Database from 'better-sqlite3'
import type { Migration } from './v001_042/types.ts'

/**
 * The original `(pool, released_at)` unique index also constrained historical
 * release timestamps. Two leases released in the same millisecond could then
 * fail with SQLITE_CONSTRAINT_UNIQUE. Capacity exclusion is enforced by the
 * immediate transaction in SqlitePlanningCapacity, so this is a lookup index.
 */
export const migration066PlanningCapacityIndex: Migration = {
  version: 66,
  name: 'planning_capacity_index',
  up(db: Database.Database) {
    db.exec(`
      DROP INDEX IF EXISTS idx_planning_capacity_active;
      CREATE INDEX IF NOT EXISTS idx_planning_capacity_active
        ON planning_capacity_leases(pool, released_at);
    `)
  }
}
