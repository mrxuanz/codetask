export {
  KernelSqliteDatabase,
  openKernelDatabase,
  type OpenKernelDatabaseOptions
} from './database'
export {
  validateKernelDatabase,
  type ForeignKeyViolation,
  type KernelDatabaseValidation
} from './data-validator'
export { applyKernelMigrations, KERNEL_SCHEMA_VERSION } from './migrations'
export { migrateLegacyAuthIfNeeded, type LegacyAuthMigrationResult } from './migrate-legacy-auth'
export * from './repositories'
export { createSqliteRepositories, SqliteUnitOfWork } from './unit-of-work'
