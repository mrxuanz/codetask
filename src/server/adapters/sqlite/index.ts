export { applyCoreSchema, getCoreSchemaVersion, type SqliteDatabase } from './migrate-core'
export { CORE_SCHEMA_VERSION, CORE_TABLES_SQL, CORE_TABLE_STATEMENTS } from './schema/core-tables'
export { SqliteIdempotencyStore } from './idempotency-store'
export { SqliteUnitOfWork, createSqliteUnitOfWork, type SqliteUnitOfWorkHandle } from './unit-of-work'
export { validateCoreDb, type CoreDbOrphanCounts, type CoreDbValidationReport } from './data-validator'
export {
  migrateLegacyToCore,
  mapLegacyJobStatus,
  UnmappableLegacyRowError,
  type MigrateLegacyToCoreInput,
  type MigrationCounts,
  type MigrationReport
} from './offline-migrator'
export type * from './ports'
export { SqliteThreadRepository } from './repositories/thread-repository'
export { SqliteDraftRepository } from './repositories/draft-repository'
export { SqlitePlanRepository } from './repositories/plan-repository'
export { SqliteJobRepository } from './repositories/job-repository'
export { SqliteTaskRepository } from './repositories/task-repository'
export { SqliteAttemptRepository } from './repositories/attempt-repository'
export { SqliteOutboxRepository } from './repositories/outbox-repository'
export { SqliteArtifactRepository } from './repositories/artifact-repository'
export {
  SqliteDomainThreadRepository,
  SqliteDomainDraftRepository,
  SqliteDomainPlanRepository,
  SqliteDomainJobRepository,
  SqliteDomainTaskProjectionRepository,
  SqliteDomainAttemptRepository,
  SqliteDomainWorkspaceLeaseRepository,
  SqliteDomainVerificationAttemptRepository,
  SqliteDomainRetentionStore
} from './domain-repositories'
export { SqliteArtifactStore } from './artifact-store'
