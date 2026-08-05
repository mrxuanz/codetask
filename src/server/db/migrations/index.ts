/** Host re-export — migration registry lives in @codetask/database. */
export {
  allMigrations,
  applyMigrations,
  runMigrations,
  type Migration
} from '@codetask/database/migrations/all'
